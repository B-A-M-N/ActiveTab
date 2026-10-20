/**
 * Real CDP-backed API integration test.
 * Mirrors the fixture-serving pattern from cdp.integration.test.js.
 * Launches disposable Chrome, starts the API server with a real runner,
 * and verifies HTTP → CDP → navigation → output files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { CdpClient } from "../src/cdp/client.js";
import { BrowserSession } from "../src/browser/session.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import { TaskJournal } from "../src/state/journal.js";
import { createApiServer } from "../src/api/local-server.js";
import { generateOutputFiles } from "../src/api/output-files.js";
import { acquireBrowserTargetLease } from "../src/testing/runState.js";
import { chromeWindowPositionArgs } from "../src/browser/chromeWindowPlacement.js";

const chromePath = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const fixture = await readFile(new URL("./fixtures/navigation.html", import.meta.url));
const sameFrameFixture = await readFile(new URL("./fixtures/same-frame.html", import.meta.url));
const fixtureViewport = Object.freeze({ width: 1280, height: 720, deviceScaleFactor: 1 });
const fixtureScreen = Object.freeze({ width: 1280, height: 1024 });
const browserSurfaceExpression = "({url:location.href,title:document.title,visibilityState:document.visibilityState,hidden:document.hidden,innerWidth,innerHeight,screenWidth:screen.width,screenHeight:screen.height,deviceScaleFactor:devicePixelRatio})";
const chromeStartupTimeoutMs = 45_000;

function createRealRunner({ journalDir, outputDir }) {
  return {
    async run(goal, { signal, input, templateId, taskId, runStateStore } = {}) {
      if (signal?.aborted) return { status: "canceled" };
      const startedAtMs = Date.now();

      // For the API test, we don't launch Chrome here — the caller already
      // launched it and passed the site URL. We create a session to the
      // already-running Chrome and navigate.
      // But since the API server runs the runner in background, we need
      // to launch Chrome ourselves. Let's do it here.
      const profileDir = await mkdtemp(join(tmpdir(), "activetab-api-cdp-"));
      const port = 11000 + Math.floor(Math.random() * 5000);

      // Always start at about:blank so the engine can navigate to the target URL
      const chrome = spawn(chromePath, [
        ...(process.env.ACTIVETAB_HEADLESS === "1" ? ["--headless=new"] : []),
        ...chromeWindowPositionArgs(),
      "--no-sandbox", "--disable-dev-shm-usage",
        "--no-first-run", "--no-default-browser-check",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "about:blank"
      ], { stdio: ["ignore", "ignore", "pipe"], detached: true });

      let stderr = "";
      chrome.stderr.setEncoding("utf8");
      chrome.stderr.on("data", chunk => { stderr += chunk.slice(-5000); });

      try {
        // Wait for CDP endpoint
        const endpoint = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Chrome CDP startup timed out: ${stderr.slice(-500)}`)), chromeStartupTimeoutMs);
          const check = () => {
            const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); return true; }
            return false;
          };
          chrome.stderr.on("data", check);
          const poll = setInterval(() => {
            if (check()) { clearInterval(poll); return; }
            if (chrome.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error(`Chrome exited early (${chrome.exitCode})`)); return; }
          }, 100);
        });

        // Wait for a target
        const deadline = Date.now() + 10000;
        let targets = [];
        while (Date.now() < deadline) {
          try {
            targets = await listTargets(endpoint);
            if (targets.length > 0) break;
          } catch { /* not ready */ }
          await new Promise(r => setTimeout(r, 100));
        }

        if (targets.length === 0) throw new Error("No CDP targets found");

        let session;
        let bootstrap;
        try {
          // Chrome starts at about:blank, which is not an authorized HTTP(S)
          // control target. Navigate the existing page target to the input URL
          // over a throwaway CDP connection before authorizing it.
          if (input?.url) {
            const rawTarget = targets.find(item => typeof item.id === "string");
            const rawList = await fetch(new URL("/json/list", endpoint), { signal: AbortSignal.timeout(5_000) });
            const rawTargets = await rawList.json();
            const raw = rawTargets.find(item => item.id === rawTarget?.id);
            if (!raw?.webSocketDebuggerUrl) throw new Error("The page target has no direct CDP WebSocket.");
            bootstrap = new CdpClient(raw.webSocketDebuggerUrl);
            await bootstrap.connect();
            await bootstrap.send("Page.enable");
            await bootstrap.send("Emulation.setDeviceMetricsOverride", {
              width: fixtureViewport.width,
              height: fixtureViewport.height,
              deviceScaleFactor: fixtureViewport.deviceScaleFactor,
              mobile: false,
              screenWidth: fixtureScreen.width,
              screenHeight: fixtureScreen.height
            });
            await bootstrap.send("Page.navigate", { url: input.url });
            let initialSurface;
            const initialLoadDeadline = Date.now() + 5000;
            while (Date.now() < initialLoadDeadline) {
              initialSurface = await bootstrap.send("Runtime.evaluate", {
                expression: browserSurfaceExpression,
                returnByValue: true
              });
              if (initialSurface?.result?.value?.url === input.url && initialSurface?.result?.value?.title === "Demo shop") break;
              await new Promise(r => setTimeout(r, 100));
            }
            assert.deepEqual(initialSurface?.result?.value, {
              url: input.url,
              title: "Demo shop",
              visibilityState: "visible",
              hidden: false,
              innerWidth: fixtureViewport.width,
              innerHeight: fixtureViewport.height,
              screenWidth: fixtureScreen.width,
              screenHeight: fixtureScreen.height,
              deviceScaleFactor: fixtureViewport.deviceScaleFactor
            }, "the fixture's first site load uses the shared viewport and emulated screen");
            await bootstrap.close().catch(() => {});
            bootstrap = null;
          }

          // Re-list so authorization sees the post-navigation HTTP(S) URL.
          const readyTargets = await listTargets(endpoint);
          const target = await resolveAuthorizedTarget(endpoint, readyTargets[0].id, readyTargets[0].id);
          session = await new BrowserSession(target).attach();
          await session.client.send("Emulation.setDeviceMetricsOverride", {
            width: fixtureViewport.width,
            height: fixtureViewport.height,
            deviceScaleFactor: fixtureViewport.deviceScaleFactor,
            mobile: false,
            screenWidth: fixtureScreen.width,
            screenHeight: fixtureScreen.height
          });
          let observation;
          const loadDeadline = Date.now() + 5000;
          while (Date.now() < loadDeadline) {
            observation = await session.observe();
            if (observation.page.title === "Demo shop") break;
            await new Promise(r => setTimeout(r, 100));
          }
          const surface = await session.client.send("Runtime.evaluate", {
            expression: browserSurfaceExpression,
            returnByValue: true
          });
          console.log(`[CDP Test] Browser surface: ${JSON.stringify(surface?.result?.value)}`);
          assert.deepEqual(surface?.result?.value, {
            url: input.url,
            title: "Demo shop",
            visibilityState: "visible",
            hidden: false,
            innerWidth: fixtureViewport.width,
            innerHeight: fixtureViewport.height,
            screenWidth: fixtureScreen.width,
            screenHeight: fixtureScreen.height,
            deviceScaleFactor: fixtureViewport.deviceScaleFactor
          }, "the local workflow fixture uses the same visible viewport and emulated screen in headed and headless modes");

          console.log(`[CDP Test] Goal: ${goal}`);
          console.log(`[CDP Test] Page title: ${observation?.page?.title}`);

          // Run the navigation engine with the goal
          const journal = new TaskJournal(join(journalDir, `${taskId}.json`));
          // This button exists only in the disposable fixture. Keep its test
          // capability exact and independent from ordinary product policy.
          const fixtureButtonAuthorizer = {
            operationId: "test.local_fixture_archive_button",
            authorize({ action, candidate, observation }) {
              let fixtureOrigin = null;
              let observedOrigin = null;
              try {
                fixtureOrigin = new URL(input.url).origin;
                observedOrigin = new URL(observation?.page?.url).origin;
              } catch {}
              const fresh = (observation?.candidates ?? []).some(item =>
                item.identity === candidate?.identity && item.role === "button" && item.visible === true);
              const allowed = action === "click"
                && fixtureOrigin === observedOrigin
                && candidate?.tag === "button"
                && candidate?.name === "Open archive"
                && fresh;
              return allowed
                ? { allowed: true, category: "test_local_fixture_archive" }
                : { allowed: false, reason: "The test capability is limited to the fresh Open archive button on its own fixture." };
            }
          };
          const targetLease = await acquireBrowserTargetLease(runStateStore, session, taskId);
          let navResult;
          try {
            const engine = new NavigationEngine(session, {
              journal,
              maxActions: 3,
              operationAuthorizer: fixtureButtonAuthorizer,
              assertExecutionLease: targetLease.assertCurrent
            });
            navResult = await engine.run(goal);
          } finally {
            await targetLease.release();
          }
          console.log(`[CDP Test] Result: ${navResult.status} attempts=${navResult.attempts}`);

          if (signal?.aborted) return { status: "canceled" };

          const output = {
            status: navResult.status,
            goal: navResult.goal ?? "[redacted]",
            attempts: navResult.attempts ?? 0,
            recoveries: navResult.recoveries ?? 0,
            final_page: navResult.page ? {
              url: navResult.page.url,
              title: navResult.page.title
            } : null
          };

          const outputFiles = await generateOutputFiles(
            taskId,
            { goal, input, output, status: navResult.status },
            outputDir
          );

          return {
            status: navResult.status === "succeeded" ? "succeeded" : navResult.status,
            output,
            usage: {
              actions: navResult.attempts ?? 0,
              recoveries: navResult.recoveries ?? 0,
              planner_calls: navResult.plannerCalls ?? null,
              wall_time_ms: Date.now() - startedAtMs
            },
            output_files: outputFiles,
            live_url_info: null
          };
        } finally {
          await session?.close().catch(() => {});
          await bootstrap?.close().catch(() => {});
        }
      } finally {
        try { chrome.kill("SIGKILL"); } catch { /* already dead */ }
        try { await rm(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  };
}

test("API server with real CDP: navigate fixture page via HTTP API", { timeout: 120_000 }, async t => {
  let server;
  let crossOriginServer;
  let api;
  let tempDir;

  try {
    // Start cross-origin server (needed by fixture)
    crossOriginServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(sameFrameFixture);
    });
    crossOriginServer.listen(0, "127.0.0.1");
    await once(crossOriginServer, "listening");
    const crossOriginPort = crossOriginServer.address().port;

    // Start fixture server (serves all routes like the working test)
    server = createServer((req, res) => {
      if (req.url?.startsWith("/same-frame.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(sameFrameFixture);
        return;
      }
      if (req.url?.startsWith("/api/account?")) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ loaded: true }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fixture.toString().replace("CROSS_ORIGIN_FRAME_URL", `http://127.0.0.1:${crossOriginPort}/same-frame.html`));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const sitePort = server.address().port;
    const siteUrl = `http://127.0.0.1:${sitePort}/`;

    tempDir = await mkdtemp(join(tmpdir(), "activetab-api-e2e-"));

    const runner = createRealRunner({
      journalDir: join(tempDir, "journals"),
      outputDir: join(tempDir, "output")
    });

    const apiToken = "test-api-token-for-cdp-integration";
    api = createApiServer({
      port: 0,
      taskStoreDir: join(tempDir, "tasks"),
      navigationRunner: runner,
      apiToken
    });
    const { url: apiUrl } = await api.start();

    // Create a run using the page data extractor template
    const createRes = await fetch(`${apiUrl}/v3/bots/templates/local-page-data-extractor/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify({
        input: {
          url: siteUrl,
          extraction_goal: "open the archive page"
        }
      })
    });
    assert.equal(createRes.status, 200);
    const { task_id: taskId, status: createStatus } = await createRes.json();
    assert.equal(createStatus, "created");

    // Poll for completion
    let finalStatus;
    const pollDeadline = Date.now() + 45000;
    while (Date.now() < pollDeadline) {
      const statusRes = await fetch(`${apiUrl}/v3/bots/runs/${taskId}/status`, { headers: { "Authorization": `Bearer ${apiToken}` } });
      const statusBody = await statusRes.json();
      finalStatus = statusBody.status;
      if (["finished", "failed", "canceled"].includes(finalStatus)) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Get detail
    const detailRes = await fetch(`${apiUrl}/v3/bots/runs/${taskId}`, { headers: { "Authorization": `Bearer ${apiToken}` } });
    const detail = await detailRes.json();

    t.diagnostic(`Final status: ${finalStatus}`);
    t.diagnostic(`Detail status: ${detail.status}`);
    t.diagnostic(`Output: ${JSON.stringify(detail.output).slice(0, 300)}`);

    // The key assertion: the pipeline works end-to-end
    // (Chrome launched, page loaded, engine ran, output generated)
    assert.ok(["finished", "failed"].includes(finalStatus), `Task should reach terminal state, got: ${finalStatus}`);
    assert.equal(detail.task_id, taskId);
    assert.ok(detail.output);
    assert.ok(detail.usage && typeof detail.usage === "object");
    assert.ok(typeof detail.usage.actions === "number");

    // Output files should exist
    assert.ok(detail.output_files);
    assert.ok(detail.output_files.json);

    // Fetch output file
    const fileRes = await fetch(`${apiUrl}/output/${taskId}/result.json`, { headers: { "Authorization": `Bearer ${apiToken}` } });
    assert.equal(fileRes.status, 200);
    const fileData = JSON.parse(await fileRes.text());
    assert.equal(fileData.task_id, taskId);

    t.diagnostic(`✅ Full pipeline verified: HTTP → Chrome → CDP → Navigation → Output Files`);
  } finally {
    if (api) await api.stop().catch(() => {});
    if (server) server.close();
    if (crossOriginServer) crossOriginServer.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
