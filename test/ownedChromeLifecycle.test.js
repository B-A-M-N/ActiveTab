import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { launchOwnedChrome } from "../src/browser/ownedChrome.js";
import { resolveChromeWindowPosition } from "../src/browser/chromeWindowPlacement.js";
import { listTargets } from "../src/browser/targets.js";

test("an active profile lock preserves its CDP handoff and refuses a second Chrome launch", async t => {
  const profileDir = await mkdtemp(join(tmpdir(), "activetab-locked-profile-"));
  t.after(() => rm(profileDir, { recursive: true, force: true }));

  const endpointFile = join(profileDir, "DevToolsActivePort");
  const originalEndpoint = "1\n/devtools/browser/AbC_123-token\n";
  await writeFile(join(profileDir, "SingletonLock"), "active-profile");
  await writeFile(endpointFile, originalEndpoint, { mode: 0o600 });

  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = "/unused/chrome-for-locked-profile-test";
  try {
    await assert.rejects(
      launchOwnedChrome({
        initialUrl: "https://staging.freeinference.org/",
        userDataDir: profileDir,
        preserveProfile: true
      }),
      /Chrome owns this profile but its DevTools endpoint is not reachable/
    );
    assert.equal(await readFile(endpointFile, "utf8"), originalEndpoint);
  } finally {
    if (previousChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChromePath;
  }
});

test("keeping Chrome open requires an explicit persistent profile", async () => {
  const previousChromePath = process.env.CHROME_PATH;
  process.env.CHROME_PATH = "/unused/chrome-for-locked-profile-test";
  try {
    await assert.rejects(
      launchOwnedChrome({ initialUrl: "https://staging.freeinference.org/", keepBrowserOpen: true }),
      /keepBrowserOpen requires an explicit persistent profile/
    );
  } finally {
    if (previousChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChromePath;
  }
});

const chromeExecutable = process.env.CHROME_PATH ?? process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

test("the selected secondary display is reapplied when reusing an owned Chrome profile", {
  skip: process.env.ACTIVETAB_HEADLESS === "1"
    ? "headless mode cannot verify desktop window placement; run this fixture on a display"
    : !existsSync(chromeExecutable)
      || (process.env.ACTIVETAB_CHROME_DISPLAY ?? "secondary") !== "secondary"
      || Boolean(process.env.ACTIVETAB_CHROME_WINDOW_POSITION),
  timeout: 60_000
}, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Reusable display fixture</title><main>Ready</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const initialUrl = `http://127.0.0.1:${server.address().port}/`;
  const profileDir = await mkdtemp(join(tmpdir(), "activetab-display-reuse-"));
  const selectedPosition = resolveChromeWindowPosition();
  const initialPosition = { x: selectedPosition.x + 20, y: selectedPosition.y + 20 };
  let firstOwner = null;
  let reusedOwner = null;

  try {
    firstOwner = await launchOwnedChrome({
      initialUrl,
      headed: true,
      userDataDir: profileDir,
      preserveProfile: true,
      windowPosition: `${initialPosition.x},${initialPosition.y}`
    });
    assert.deepEqual(
      { left: firstOwner.windowBounds.left, top: firstOwner.windowBounds.top },
      { left: initialPosition.x, top: initialPosition.y },
      "the fixture starts on the secondary display"
    );

    reusedOwner = await launchOwnedChrome({
      initialUrl,
      userDataDir: profileDir,
      preserveProfile: true,
      reuseExisting: true
    });
    assert.equal(reusedOwner.reusedExisting, true);
    assert.equal(reusedOwner.readiness.positionedWindowCount, 1);
    assert.deepEqual(
      { left: reusedOwner.windowBounds.left, top: reusedOwner.windowBounds.top },
      { left: selectedPosition.x, top: selectedPosition.y },
      "profile reuse reapplies the configured secondary-display position"
    );
  } finally {
    await reusedOwner?.close();
    await firstOwner?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("owned Chrome reattaches to the exact authorized page without reloading or closing it", {
  skip: !existsSync(chromeExecutable),
  timeout: 60_000
}, async () => {
  const requests = { entry: 0, agents: 0 };
  const entryServer = createServer((request, response) => {
    if (request.url === "/") requests.entry++;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Staging fixture</title><main>Entry fixture</main>");
  });
  const agentsServer = createServer((request, response) => {
    if (request.url === "/agents") requests.agents++;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Agents fixture</title><main>Agents fixture</main>");
  });
  entryServer.listen(0, "127.0.0.1");
  agentsServer.listen(0, "127.0.0.1");
  await Promise.all([once(entryServer, "listening"), once(agentsServer, "listening")]);

  const entryOrigin = `http://127.0.0.1:${entryServer.address().port}`;
  const agentsOrigin = `http://127.0.0.1:${agentsServer.address().port}`;
  const profileDir = await mkdtemp(join(tmpdir(), "activetab-reconnect-profile-"));
  let firstOwner = null;
  let secondOwner = null;

  try {
    firstOwner = await launchOwnedChrome({
      initialUrl: `${entryOrigin}/`,
      headed: false,
      userDataDir: profileDir,
      preserveProfile: true,
      keepBrowserOpen: true
    });
    const originalTargetId = firstOwner.targetId;
    await firstOwner.session.client.send("Page.navigate", { url: `${agentsOrigin}/agents` });

    let observed = null;
    const navigationDeadline = Date.now() + 15_000;
    while (Date.now() < navigationDeadline) {
      observed = await firstOwner.session.observe().catch(() => null);
      if (observed?.page?.url === `${agentsOrigin}/agents` && observed?.page?.title === "Agents fixture") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(observed?.page?.url, `${agentsOrigin}/agents`, "the manual navigation reached the distinct Agents origin");
    assert.equal(requests.entry, 1, "the entry page loaded once before operator authentication/navigation");
    assert.equal(requests.agents, 1, "the Agents page loaded once");

    await firstOwner.close();
    const refused = await launchOwnedChrome({
      initialUrl: `${entryOrigin}/`,
      userDataDir: profileDir,
      preserveProfile: true,
      attachExistingTargetId: originalTargetId,
      allowedExistingOrigins: [entryOrigin]
    }).then(owner => owner.close()).then(() => null, error => error);
    assert.match(refused?.message ?? "", /outside the authorized origin allowlist/);
    assert.equal(requests.entry, 1, "a refused origin check does not reload the staging entry");
    assert.equal(requests.agents, 1, "a refused origin check does not navigate away from the current page");

    secondOwner = await launchOwnedChrome({
      initialUrl: `${entryOrigin}/`,
      userDataDir: profileDir,
      preserveProfile: true,
      keepBrowserOpen: true,
      attachExistingTargetId: originalTargetId,
      allowedExistingOrigins: [entryOrigin, agentsOrigin]
    });
    assert.equal(secondOwner.attachedExisting, true);
    assert.equal(secondOwner.targetId, originalTargetId);
    observed = await secondOwner.session.observe();
    assert.equal(observed.page.url, `${agentsOrigin}/agents`, "reattachment preserves the exact current page");
    assert.equal(observed.page.title, "Agents fixture");
    assert.equal(requests.entry, 1, "reattachment does not replay the staging entry URL");
    assert.equal(requests.agents, 1, "reattachment does not reload the authenticated Agents page");

    const closeResult = await secondOwner.close();
    assert.equal(closeResult.browserPreserved, true, "closing ActiveTab detaches its session but preserves owned Chrome");
    assert.ok((await listTargets(secondOwner.endpoint)).some(target => target.id === originalTargetId), "the exact browser target remains open after detach");
  } finally {
    if (secondOwner) await secondOwner.close().catch(() => {});
    if (firstOwner?.chromeProcess && firstOwner.chromeProcess.exitCode === null) {
      try { process.kill(-firstOwner.chromeProcess.pid, "SIGTERM"); }
      catch { firstOwner.chromeProcess.kill("SIGTERM"); }
      await Promise.race([once(firstOwner.chromeProcess, "exit"), new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => {});
      if (firstOwner.chromeProcess.exitCode === null) {
        try { process.kill(-firstOwner.chromeProcess.pid, "SIGKILL"); }
        catch { firstOwner.chromeProcess.kill("SIGKILL"); }
      }
    }
    await Promise.all([
      new Promise(resolve => entryServer.close(resolve)),
      new Promise(resolve => agentsServer.close(resolve))
    ]);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
