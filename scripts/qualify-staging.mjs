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
 *   --mode=owned    (default) Launch an owned headed Chrome with a private,
 *                   persistent profile dedicated to this staging profile.
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
 * Human handoff: owned mode keeps the same browser and run alive while the
 * operator follows staging → visible Cloud Agents → Agent login. It resumes
 * only after fresh evidence shows the Agent task composer. After qualification
 * it leaves the authenticated page open until Ctrl-C.
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
import { selectAuthorizedStagingTarget } from "../src/testing/qualifyTarget.js";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}
const hasFlag = name => args.includes(`--${name}`);

const mode = arg("mode", "owned");
const profileId = arg("profile", "cloud-agent-staging");
const openOnly = hasFlag("open-only");
const resumeRunId = arg("resume-run-id", process.env.ACTIVETAB_RESUME_RUN_ID ?? null);
const discardRunId = arg("discard-run", null);

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
if (mode === "attached" && openOnly) {
  console.error("--open-only requires --mode=owned.");
  process.exit(2);
}
if (mode === "owned" && process.env.ACTIVETAB_HEADLESS === "1") {
  console.error("Refusing --mode=owned with ACTIVETAB_HEADLESS=1: headless is never a silent fallback for staging qualification. Use --mode=owned with a display, or an explicit operator opt-in workflow.");
  process.exit(2);
}
if (resumeRunId && (discardRunId || process.env.ACTIVETAB_DISCARD_SUSPENDED_RUN === "1")) {
  console.error("Choose either --resume-run-id or an explicit discard, not both.");
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const profilesDir = join(repoRoot, "profiles");
const stateDir = join(repoRoot, ".activetab", "qualification");
const browserProfilesDir = join(stateDir, "browser-profiles");
const reportDir = reportDirArg ?? stateDir;

function delayOrAbort(ms, signal) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(profileId)) {
  console.error("Profile ID must contain only letters, digits, and hyphens.");
  process.exit(2);
}

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
        await mkdir(reportDir, { recursive: true, mode: 0o700 });
        const path = join(reportDir, `${name}.jpg`);
        await writeFile(path, Buffer.from(data, "base64"), { mode: 0o600 });
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

  // Browser-profile persistence and run-state persistence are independent:
  // either mode can resume a durable run, but each must revalidate its target.
  const interventionDir = mode === "attached"
    ? join(repoRoot, ".activetab", "interventions")
    : join(stateDir, "interventions-owned");
  const runStoreDir = join(repoRoot, ".activetab", "run-state");
  const interventions = new InterventionStore(interventionDir);
  await interventions.init();
  const runStore = new RunStateStore(runStoreDir);
  await runStore.init();
  const relevantRun = run => run.workflowId === "cloud-agent-staging-qualification"
    && run.environmentId === binding.environmentId
    && (!run.profileId || run.profileId === profileId);
  const pendingRuns = [...new Map([...runStore.listSuspended(), ...runStore.listActive()]
    .filter(relevantRun).map(run => [run.runId, run])).values()];
  let resumeRunState = null;

  let selectedDiscardId = discardRunId;
  if (!selectedDiscardId && process.env.ACTIVETAB_DISCARD_SUSPENDED_RUN === "1" && pendingRuns.length === 1) {
    selectedDiscardId = pendingRuns[0].runId;
  }
  if (selectedDiscardId) {
    const abandoned = pendingRuns.find(run => run.runId === selectedDiscardId);
    if (!abandoned) {
      console.error(`[qualification] --discard-run '${selectedDiscardId}' does not identify a pending run for profile '${profileId}'.`);
      process.exit(3);
    }
    await runStore.update(abandoned.runId, {
      status: "abandoned",
      pendingInterventionId: null,
      suspendedStepId: null,
      resumeCursor: null
    });
    console.error(`[qualification] Explicitly abandoned suspended run ${abandoned.runId}; its report and intervention records remain available.`);
  }

  if (resumeRunId) {
    const candidate = pendingRuns.find(run => run.runId === resumeRunId);
    if (!candidate || !candidate.resumeCursor || !candidate.pendingInterventionId) {
      console.error(`[qualification] Run '${resumeRunId}' has no resumable human-authentication cursor for profile '${profileId}'.`);
      process.exit(3);
    }
    if (candidate.mode && candidate.mode !== mode) {
      console.error(`[qualification] Run '${resumeRunId}' was created in ${candidate.mode} mode; refusing to resume it in ${mode} mode.`);
      process.exit(3);
    }
    if (candidate.profileId && candidate.profileId !== profileId) {
      console.error(`[qualification] Run '${resumeRunId}' belongs to profile '${candidate.profileId}', not '${profileId}'.`);
      process.exit(3);
    }
    resumeRunState = candidate;
  } else {
    const remaining = pendingRuns.filter(run => run.runId !== selectedDiscardId);
    if (remaining.length) {
      console.error(`[qualification] ${remaining.length} unfinished run(s) exist in ${runStoreDir}; refusing to start a replacement run.`);
      for (const run of remaining) console.error(`  runId=${run.runId} status=${run.status} pendingIntervention=${run.pendingInterventionId ?? "none"} suspendedStep=${run.suspendedStepId ?? "none"}`);
      console.error("  Resume with --resume-run-id=<runId>, or explicitly abandon one with --discard-run=<runId>.");
      process.exit(3);
    }
  }

  let owned = null;
  let session = null;
  let attachedFromOutside = false;
  const evidence = { screenshots: [], navigation: [] };

  const startedAt = Date.now();
  try {
    if (mode === "owned") {
      owned = await launchOwnedChrome({
        // Both the manual browser launcher and qualification begin at the
        // actual staging application entry. Cloud Agent is reached through
        // the visible UI route observed by the workflow.
        initialUrl: binding.applicationEntryUrl,
        headed: true,
        displayMode: useXvfb ? "xvfb" : "current-display",
        signal: controller.signal,
        userDataDir: join(browserProfilesDir, profileId),
        preserveProfile: true
      });
      session = owned.session;
      evidence.browser = {
        launchMode: owned.launchMode,
        displayMode: owned.displayMode,
        displaySource,
        browserVersion: owned.browserVersion,
        assignedCdpEndpoint: "ws://127.0.0.1:<assigned>", // sanitized: assigned port only
        profileDir: "<private persistent profile>",
        readiness: owned.readiness
      };
      console.log(`[owned] Chrome ${owned.browserVersion} launched (${owned.launchMode}, ${displaySource}), target ${owned.targetId}`);
      if (openOnly) {
        const cdpHttp = new URL(owned.endpoint);
        cdpHttp.protocol = "http:";
        cdpHttp.pathname = "";
        cdpHttp.search = "";
        console.log(`[owned] Staging entry: ${binding.applicationEntryUrl}`);
        console.log(`[owned] Browser parked for manual login/navigation. Persistent profile: ${owned.profileDir}`);
        console.log(`[owned] CDP endpoint: ${cdpHttp.href}`);
        console.log("[owned] Authenticate on staging, follow the visible Cloud Agents link, and leave this process running for attachment.");
        await new Promise(resolve => {
          if (controller.signal.aborted) return resolve();
          controller.signal.addEventListener("abort", resolve, { once: true });
        });
        return;
      }
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
      const authorizedTargetId = process.env.ACTIVETAB_AUTHORIZED_TARGET_ID;
      if (!authorizedTargetId) {
        console.error(`[attached] ACTIVETAB_AUTHORIZED_TARGET_ID is required in attached mode. Set it to the target ID independently authorized via the extension Attach action.`);
        process.exit(3);
      }
      const selected = selectAuthorizedStagingTarget(targets, authorizedTargetId, binding);
      if (!selected.ok) {
        const observed = selected.target?.url ?? (targets.map(target => `${target.id}:${target.url}`).join(", ") || "none");
        console.error(`[attached] The exact independently authorized target '${authorizedTargetId}' is unavailable or outside ${binding.entryOrigin} (observed: ${observed}). ${selected.reason} Re-authorize the intended staging tab.`);
        process.exit(3);
      }
      const stagingTarget = selected.target;
      if (resumeRunState && resumeRunState.target?.targetId !== authorizedTargetId) {
        console.error(`[attached] Resume target '${authorizedTargetId}' does not match the suspended run's original target '${resumeRunState.target?.targetId ?? "unknown"}'.`);
        process.exit(3);
      }
      const target = await resolveAuthorizedTarget(endpoint, stagingTarget.id, authorizedTargetId);
      session = await new BrowserSession(target).attach();
      attachedFromOutside = true;
      evidence.browser = { launchMode: "attached (operator browser preserved)", endpoint: "ws://127.0.0.1:<operator-assigned>" };
      console.log(`[attached] Attached to authorized staging tab ${stagingTarget.id} (${stagingTarget.url})`);
    }

    const waitForAbort = () => new Promise(resolve => {
      if (controller.signal.aborted) return resolve();
      controller.signal.addEventListener("abort", resolve, { once: true });
    });

    const report = await qualifyCloudAgent({
      session,
      environment: binding,
      interventions,
      runStore,
      resumeRunState,
      profileId,
      mode,

      signal: controller.signal,
      onHumanIntervention: async (intervention, { inspectCurrentPage }) => {
        console.log(`\n[human] ${intervention.requiredHumanAction ?? "Complete the visible staging and Cloud Agent login flow in Chrome."}`);
        console.log(`[human] Chrome remains open at the staging root. ActiveTab will resume this same run after it observes the authorized Cloud Agent task composer.`);
        let lastNoticeAt = 0;
        while (!controller.signal.aborted) {
          const ready = await inspectCurrentPage().catch(error => ({ ok: false, reason: String(error?.message ?? error) }));
          if (ready.ok) {
            console.log(`[human] Verified task composer at ${ready.origin}; resuming the suspended run.`);
            return true;
          }
          if (Date.now() - lastNoticeAt > 15_000) {
            console.log(`[human] Still waiting for the task composer (${ready.reason ?? "not visible yet"}).`);
            lastNoticeAt = Date.now();
          }
          await delayOrAbort(1_500, controller.signal);
        }
        return false;
      },
      onEvent: text => console.log(`  ${text}`)
    });

    // Capture a screenshot where permitted (bounded, local).
    const shot = hasFlag("capture-screenshot")
      ? await captureScreenshot(session, `qualify-${report.runId}`)
      : null;
    if (shot) { evidence.screenshots.push(shot); report.screenshotPath = shot; }

    report.evidence = { ...report.evidence, ...evidence };
    report.browserProcessLifetimeMs = Date.now() - startedAt;
    report.displaySource = displaySource;

    // Persist the final report.
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    const reportPath = join(reportDir, `${report.runId}.report.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
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

    // Leave the authenticated page available for the operator's next
    // read-only discovery or explicitly requested PR test. The profile is
    // persistent, and Ctrl-C is the explicit close boundary.
    if (mode === "owned" && report.gates?.agents_application_entered?.passed === true && !controller.signal.aborted) {
      const cdpHttp = new URL(owned.endpoint);
      cdpHttp.protocol = "http:";
      cdpHttp.pathname = "";
      cdpHttp.search = "";
      console.log(`[owned] Authenticated Cloud Agent remains open at the observed application page. Target: ${owned.targetId}`);
      console.log(`[owned] CDP endpoint: ${cdpHttp.href}`);
      console.log(`[owned] Persistent profile retained: ${owned.profileDir}`);
      console.log("[owned] Press Ctrl-C when you are done using this browser.");
      await waitForAbort();
    }
  } finally {
    if (owned) {
      const cleanup = await owned.close();
      console.log(`[owned] Browser closed: graceful=${cleanup.graceful} forced=${cleanup.forced} exitCode=${cleanup.exitCode} profilePreserved=${cleanup.profilePreserved}${cleanup.error ? ` error=${cleanup.error}` : ""}`);
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
