/**
 * Cloud Agent staging qualification — node:test wrapper (P0-2 / P0-3).
 *
 * The operational qualification logic lives in
 * src/testing/qualifyCloudAgent.js and is shared with the standalone
 * single-invocation entrypoint (scripts/qualify-staging.mjs). This file
 * only supplies an authorized attached headed tab on the REAL
 * FreeInference staging origin and asserts the honest outcome.
 *
 * Architecture:
 *   Browser path:     extension-authorized headed tab → staging website → Agents
 *   Diagnostic path:  optional Cloud Agent admin adapter (SSH tunnel or direct),
 *                     correlated to the browser operation by run identifiers
 *   Control path:     CDP / extension broker (transport only)
 *
 * Behavior:
 *  - Requires an authorized attached tab on the real staging origin
 *    (ACTIVETAB_CDP_ENDPOINT or extension mode; never launches a disposable
 *    profile at a localhost URL).
 *  - Verifies environment/application identity from the observed URL.
 *  - If authentication is required, the run enters a durable resumable
 *    WAITING_FOR_HUMAN state instead of skipping the browser workflow.
 *  - Honest gating (P1-5): separate evidence gates are asserted
 *    individually. Discovering controls or entering Agents is NEVER
 *    reported as Cloud Agent operational qualification. A success message
 *    is printed only when every mandatory gate passed.
 *
 * Never sets ACTIVETAB_HEADLESS implicitly; headed is the default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { loadEnvironmentBinding } from "../src/testing/profiles.js";
import { verifyObservedUrl, isLoopbackUrl } from "../src/environments/model.js";
import { qualifyCloudAgent } from "../src/testing/qualifyCloudAgent.js";

const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");
const CDP_ENDPOINT = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const EXTENSION_MODE = process.env.ACTIVETAB_EXTENSION === "1";

test("Cloud Agent staging qualification: real FreeInference website in headed Chrome", { timeout: 300_000 }, async t => {
  const binding = await loadEnvironmentBinding(profilesDir, "cloud-agent-staging");
  assert.equal(binding.applicationEntryUrl, "https://staging.freeinference.org",
    "The application entry must be the real staging website, never a loopback fixture or tunnel UI");
  assert.ok(!isLoopbackUrl(binding.applicationEntryUrl), "Application entry must not be loopback");

  // Locate an authorized attached tab on the real staging origin. An MCP
  // argument alone never grants consent; the tab must be authorized out of
  // band (extension Attach or Chrome debugging consent flow).
  let targets;
  try {
    targets = await listTargets(CDP_ENDPOINT);
  } catch (error) {
    t.skip(`No authorized headed Chrome staging session available (${String(error?.message ?? error).slice(0, 120)}). Start headed Chrome on ${binding.applicationEntryUrl} and authorize the tab through the ActiveTab extension, or run: npm run qualify:staging:owned`);
    return;
  }
  const stagingTarget = targets.find(target => verifyObservedUrl(binding, target.url).ok);
  if (!stagingTarget) {
    const observed = targets.map(target => target.url).join(", ") || "none";
    t.skip(`No authorized tab is attached on ${binding.entryOrigin} (observed: ${observed}). Open FreeInference staging and Attach the tab; the run will resume automatically once authentication is verified. Or run: npm run qualify:staging:owned`);
    return;
  }

  const interventionDir = await mkdtemp(join(tmpdir(), "activetab-interventions-"));
  let session;
  try {
    const target = await resolveAuthorizedTarget(CDP_ENDPOINT, stagingTarget.id, stagingTarget.id);
    session = await new BrowserSession(target).attach();

    // Disposable in-process intervention store for the test invocation.
    const interventions = new InterventionStore(interventionDir);
    await interventions.init();

    const report = await qualifyCloudAgent({
      session,
      environment: binding,
      interventions,
      mode: "test",
      onEvent: text => t.diagnostic(text)
    });

    // ── Honest gate assertions (P1-5): each evidence gate separately ──
    t.diagnostic(`Qualification state: ${report.qualificationState}`);
    t.diagnostic(`Gates passed: ${report.passedGates.join(", ") || "none"}`);
    t.diagnostic(`Gates failed: ${report.failedGates.join(", ") || "none"}`);
    for (const limitation of report.limitations) t.diagnostic(`Limitation: ${limitation}`);

    // Environment identity and real-site reachability are mandatory and
    // must be established by the shared runtime.
    assert.ok(report.gates.environment_identity_verified?.passed === true,
      `Environment identity must be verified: ${report.gates.environment_identity_verified?.detail ?? "no detail"}`);
    assert.ok(report.gates.real_staging_site_reached?.passed === true,
      "The real staging website must be reached in the headed browser");

    if (report.qualificationState === "WAITING_FOR_HUMAN") {
      // Durable resumable suspension: the checkpoint exists and is listed.
      assert.ok(report.pendingInterventions.length > 0, "A suspended run must carry a durable intervention id");
      const pending = interventions.listPending();
      assert.ok(pending.some(r => report.pendingInterventions.includes(r.intervention_id)),
        "Pending intervention must be durable and listed for the watcher");
      t.skip(`Run is suspended in a resumable waiting state pending human authentication (${report.pendingInterventions.join(", ")}). Re-run after the Agents session is authenticated; no step restarts from the beginning.`);
      return;
    }

    if (report.qualificationState === "UNCERTAIN") {
      // UNCERTAIN steps remain unresolved; entering Agents is NOT
      // operational qualification (P1-3).
      t.diagnostic(`UNCERTAIN: ${report.reason}`);
      assert.ok(report.gates.agents_application_entered?.passed !== true
        || report.gates.cloud_agent_operation_executed?.passed !== true,
        "UNCERTAIN runs must not claim operational qualification");
      t.skip(`Qualification is UNCERTAIN (not a pass): ${report.reason}`);
      return;
    }

    if (report.qualificationState === "PASSED") {
      // Only now may a success message be printed: every mandatory gate
      // passed, including an executed test-owned operation with a
      // verified result and verified cleanup.
      assert.ok(report.mandatoryGatesPassed === true, "PASSED requires every mandatory gate");
      t.diagnostic("✅ Staging qualification PASSED against the real FreeInference website (headed, authorized).");
      return;
    }

    assert.fail(`Qualification ended in an unexpected state: ${report.qualificationState} — ${report.reason ?? "no reason"}`);
  } finally {
    if (session) await session.close().catch(() => {});
    await rm(interventionDir, { recursive: true, force: true }).catch(() => {});
  }
});
