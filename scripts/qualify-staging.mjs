#!/usr/bin/env node
/**
 * Single-invocation FreeInference staging qualification entrypoint (P0-2).
 *
 * One Node.js process owns Chrome, the CDP connection, ActiveTab
 * execution, diagnostic collection, and cleanup for the entire run.
 * Nothing relies on background processes surviving between command
 * invocations.
 *
 * Modes:
 *   --mode=owned    (default) Launch an owned headed Chrome with a unique
 *                   disposable profile and Chrome-assigned CDP port. For
 *                   disposable, bounded execution inside one invocation.
 *   --mode=attached Attach to the operator's existing authorized Chrome
 *                   tab (extension Attach flow or confirmed direct CDP
 *                   target). The browser process and authenticated
 *                   profile are preserved; the session detaches without
 *                   closing the user's browser. For human-assisted runs.
 *
 * Display handling (P1-1): headed is the default. This script never
 * silently falls back to headless and never overwrites DISPLAY. With
 * --xvfb it starts Xvfb WITHIN the same owning invocation (valid for
 * graphical rendering, but the browser is not visible on the operator's
 * desktop). Use the current display (DISPLAY already set) for
 * human-assisted runs.
 *
 * Honest outcomes (P1-3/P1-5): if the owned invocation reaches the real
 * staging site but cannot authenticate, that is a truthful
 * WAITING_FOR_HUMAN result — browser launch, connection, and real-site
 * navigation are established; human authentication remains blocked by
 * the environment. The attached mode then finishes the workflow.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { launchOwnedChrome } from "../src/browser/ownedChrome.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { RunStateStore } from "../src/testing/runState.js";
import { loadEnvironmentBinding } from "../src/testing/profiles.js";
import { qualifyCloudAgent } from "../src/testing/qualifyCloudAgent.js";
import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { verifyObservedUrl } from "../src/environments/model.js";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const hasFlag = name => args.includes(`--${name}`);

const mode = arg("mode", "owned");
const profileId = arg("profile", "cloud-agent-staging");
const waitForHuman = hasFlag("wait-for-human");
const humanWaitMinutes = Number(arg("wait-minutes", "5"));
const useXvfb = hasFlag("xvfb");
const reportDirArg = arg("report-dir", null);

if (!["owned", "attached"].includes(mode)) {
  console.error(`Unknown mode '${mode}'. Use --mode=owned or --mode=attached.`);
  process.exit(2);
}
if (mode === "attached" && useXvfb) {
  console.error("--xvfb is only meaningful with --mode=owned.");
  process.exit(2);
}
if (mode === "owned" && process.env.ACTIVETAB_HEADLESS === "1") {
  console.error("Refusing --mode=owned with ACTIVETAB_HEADLESS=1: headless is never a silent fallback for staging qualification. Use --mode=owned with a display, or an explicit operator opt-in workflow.");
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilesDir = join(repoRoot, "profiles");
const stateDir = join(repoRoot, ".activetab", "qualification");
const reportDir = reportDirArg ?? stateDir;

let xvfbProcess = null;
let displaySource = "current-display";
async function ensureDisplay() {
  if (mode !== "owned") return;
  if (useXvfb) {
    // Start Xvfb within the same owning invocation. The browser renders
    // graphically but is not visible on the operator's desktop.
    const displayNum = `:${90 + (process.pid % 10)}`;
    xvfbProcess = spawn("Xvfb", [displayNum, "-screen", "0", "1600x1000x24"], { stdio: ["ignore", "ignore", "ignore"] });
    await once(xvfbProcess, "spawn").catch(() => {});
    process.env.DISPLAY = displayNum;
    displaySource = `xvfb (${displayNum}, started by this invocation)`;
    await new Promise(r => setTimeout(r, 500));
    return;
  }
  if (!process.env.DISPLAY) {
    console.error("No DISPLAY is set. For a human-visible run, export DISPLAY and run inside the graphical session; for unattended runs pass --xvfb (graphical, not desktop-visible). Headless is never a silent fallback.");
    process.exit(2);
  }
  displaySource = `current-display (DISPLAY=${process.env.DISPLAY})`;
}

function captureScreenshot(session, name) {
  return session.client.send("Page.captureScreenshot", { format: "jpeg", quality: 60, fromSurface: true })
    .then(({ data }) => data ?? null)
    .catch(() => null)
    .then(async data => {
      if (!data) return null;
      try {
        await mkdir(reportDir, { recursive: true });
        const path = join(reportDir, `${name}.jpg`);
        await writeFile(path, Buffer.from(data, "base64"));
        return path;
      } catch { return null; }
    });
}

async function main() {
  const binding = await loadEnvironmentBinding(profilesDir, profileId);
  if (!binding.applicationEntryUrl) throw new Error(`Profile '${profileId}' declares no application entry URL.`);

  await ensureDisplay();

  const controller = new AbortController();
  const onSig = () => controller.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // Durable state (P0-4). The owned run's intervention store and browser
  // cannot survive the invocation's end; the attached (host-backed) mode
  // persists under the configured state directory so a restart can reload
  // and resume the exact pending run.
  const durable = mode === "attached";
  const interventionDir = durable
    ? join(repoRoot, ".activetab", "interventions")
    : join(stateDir, "interventions-owned");
  const runStoreDir = durable ? join(repoRoot, ".activetab", "run-state") : null;
  const interventions = new InterventionStore(interventionDir);
  await interventions.init();
  const runStore = runStoreDir ? new RunStateStore(runStoreDir) : null;
  if (runStore) await runStore.init();

  let owned = null;
  let session = null;
  let attachedFromOutside = false;
  const evidence = { screenshots: [], navigation: [] };

  const startedAt = Date.now();
  try {
    if (mode === "owned") {
      owned = await launchOwnedChrome({
        initialUrl: binding.applicationEntryUrl,
        headed: true,
        displayMode: useXvfb ? "xvfb" : "current-display",
        signal: controller.signal
      });
      session = owned.session;
      evidence.browser = {
        launchMode: owned.launchMode,
        displayMode: owned.displayMode,
        displaySource,
        browserVersion: owned.browserVersion,
        assignedCdpEndpoint: "ws://127.0.0.1:<assigned>", // sanitized: assigned port only
        profileDir: "<disposable removed on cleanup>",
        readiness: owned.readiness
      };
      console.log(`[owned] Chrome ${owned.browserVersion} launched (${owned.launchMode}, ${displaySource}), target ${owned.targetId}`);
    } else {
      // Attached mode: adopt only a tab authorized out of band. Never turn
      // an arbitrary existing tab into a runner-owned target.
      const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
      let targets;
      try { targets = await listTargets(endpoint); }
      catch (error) {
        console.error(`[attached] No reachable CDP endpoint at ${endpoint}: ${String(error?.message ?? error).slice(0, 140)}`);
        console.error("[attached] Start the operator's headed Chrome with remote debugging (or use the extension Attach flow) and authorize the staging tab out of band.");
        process.exit(3);
      }
      const stagingTarget = targets.find(t => verifyObservedUrl(binding, t.url).ok);
      if (!stagingTarget) {
        const observed = targets.map(t => t.url).join(", ") || "none";
        console.error(`[attached] No authorized tab on ${binding.entryOrigin} (observed: ${observed}). Open FreeInference staging and Attach/authorize the tab.`);
        process.exit(3);
      }
      const target = await resolveAuthorizedTarget(endpoint, stagingTarget.id, stagingTarget.id);
      session = await new BrowserSession(target).attach();
      attachedFromOutside = true;
      evidence.browser = { launchMode: "attached (operator browser preserved)", endpoint: "ws://127.0.0.1:<operator-assigned>" };
      console.log(`[attached] Attached to authorized staging tab ${stagingTarget.id} (${stagingTarget.url})`);
    }

    const report = await qualifyCloudAgent({
      session,
      environment: binding,
      interventions,
      runStore,
      mode,
      waitForHuman,
      humanWaitMs: Math.max(1, humanWaitMinutes) * 60_000,
      signal: controller.signal,
      onEvent: text => console.log(`  ${text}`)
    });

    // Capture a screenshot where permitted (bounded, local).
    const shot = await captureScreenshot(session, `qualify-${report.runId}`);
    if (shot) { evidence.screenshots.push(shot); report.screenshotPath = shot; }

    report.evidence = { ...report.evidence, ...evidence };
    report.browserProcessLifetimeMs = Date.now() - startedAt;
    report.displaySource = displaySource;

    // Persist the final report.
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${report.runId}.report.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    report.reportLocation = reportPath;

    console.log(`\nQualification state: ${report.qualificationState}`);
    console.log(`Reason: ${report.reason ?? "n/a"}`);
    console.log(`Gates: passed=[${report.passedGates.join(", ") || "none"}] failed=[${report.failedGates.join(", ") || "none"}]`);
    for (const limitation of report.limitations) console.log(`Limitation: ${limitation}`);
    console.log(`Report: ${reportPath}`);
    if (report.pendingInterventions?.length) {
      console.log(`Pending interventions: ${report.pendingInterventions.join(", ")} (durable under ${interventionDir})`);
    }

    // Distinct, honest exit codes (P1-3).
    const exitByState = { PASSED: 0, FAILED: 1, WAITING_FOR_HUMAN: 10, BLOCKED: 11, UNCERTAIN: 12, CANCELED: 13 };
    process.exitCode = exitByState[report.qualificationState] ?? 1;
  } finally {
    if (owned) {
      const cleanup = await owned.close();
      console.log(`[owned] Cleanup: graceful=${cleanup.graceful} forced=${cleanup.forced} exitCode=${cleanup.exitCode} profileRemoved=${cleanup.profileRemoved}${cleanup.error ? ` error=${cleanup.error}` : ""}`);
      if (xvfbProcess) { try { xvfbProcess.kill("SIGTERM"); } catch { /* best-effort */ } }
    } else if (session && attachedFromOutside) {
      // Detach without closing the operator's browser.
      await session.close().catch(() => {});
      console.log("[attached] Detached (operator browser preserved).");
    }
  }
}

main().catch(error => {
  console.error(`qualify-staging failed: ${String(error?.message ?? error).slice(0, 500)}`);
  if (error?.launchDiagnostics) console.error(`Launch diagnostics: ${JSON.stringify(error.launchDiagnostics)}`);
  process.exit(1);
});
