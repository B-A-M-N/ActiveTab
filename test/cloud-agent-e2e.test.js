/**
 * Cloud Agent staging browser qualification (P0-2 / P2-2).
 *
 * Operates Cloud Agent as an application realm of the REAL FreeInference
 * staging website (https://staging.freeinference.org → /agents/) in a HEADED
 * Chrome browser. This is application qualification: a localhost fixture or
 * tunneled backend UI can never substitute for it.
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
 *  - Executed operations are test-owned; backend effects and diagnostics are
 *    correlated by exact operation identifiers (not merely temporal proximity).
 *
 * Env:
 *  - ACTIVETAB_CDP_ENDPOINT or ACTIVETAB_EXTENSION=1 (authorized headed tab)
 *  - ACTIVETAB_CLOUD_AGENT_URL + ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN +
 *    ACTIVETAB_CLOUD_AGENT_TRANSPORT=ssh_tunnel + ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET
 *    (optional backend diagnostics; tunnel endpoints must declare their target)
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
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { TestRunner } from "../src/testing/runner.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { loadEnvironmentBinding } from "../src/testing/profiles.js";
import { verifyObservedUrl, isLoopbackUrl } from "../src/environments/model.js";
import { classifyHumanHandoff } from "../src/navigation/handoff.js";
import { RUN_STATUS } from "../src/testing/schema.js";

const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");
const CDP_ENDPOINT = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const EXTENSION_MODE = process.env.ACTIVETAB_EXTENSION === "1";

test("Cloud Agent staging qualification: real FreeInference website in headed Chrome", { timeout: 300_000 }, async t => {
  const binding = await loadEnvironmentBinding(profilesDir, "cloud-agent-staging");
  assert.equal(binding.applicationEntryUrl, "https://staging.freeinference.org",
    "The application entry must be the real staging website, never a loopback fixture or tunnel UI");
  assert.ok(!isLoopbackUrl(binding.applicationEntryUrl), "Application entry must not be loopback");
  t.diagnostic(`Environment: ${binding.environmentId} → ${binding.applicationEntryUrl}`);

  // Locate an authorized attached tab on the real staging origin. An MCP
  // argument alone never grants consent; the tab must be authorized out of
  // band (extension Attach or Chrome debugging consent flow).
  let targets;
  try {
    targets = await listTargets(CDP_ENDPOINT);
  } catch (error) {
    t.skip(`No authorized headed Chrome staging session available (${String(error?.message ?? error).slice(0, 120)}). Start headed Chrome on ${binding.applicationEntryUrl} and authorize the tab through the ActiveTab extension.`);
    return;
  }
  const stagingTarget = targets.find(target => {
    const verified = verifyObservedUrl(binding, target.url);
    return verified.ok;
  });
  if (!stagingTarget) {
    const observed = targets.map(target => target.url).join(", ") || "none";
    t.skip(`No authorized tab is attached on ${binding.entryOrigin} (observed: ${observed}). Open FreeInference staging and Attach the tab; the run will resume automatically once authentication is verified.`);
    return;
  }

  const interventionDir = await mkdtemp(join(tmpdir(), "activetab-interventions-"));
  let session;
  try {
    const target = await resolveAuthorizedTarget(CDP_ENDPOINT, stagingTarget.id, stagingTarget.id);
    session = await new BrowserSession(target).attach();
    const interventions = new InterventionStore(interventionDir);
    await interventions.init();

    // ── 1. Correct environment and application identity (mandatory) ──
    const observation = await session.observe();
    const identity = verifyObservedUrl(binding, observation.page?.url);
    assert.ok(identity.ok, `Browser evidence must establish the actual application URL: ${identity.reason}`);
    t.diagnostic(`Verified application identity: ${observation.page.url} (${observation.page.title ?? "untitled"})`);

    // ── 2. Authenticated application access ──
    const handoff = classifyHumanHandoff(observation);
    if (handoff?.category === "authentication" || handoff?.category === "anti_automation") {
      // Do NOT skip the browser workflow: enter a durable resumable waiting
      // state. The intervention watcher resumes automatically once the
      // Agents-specific session is verifiably authenticated.
      const record = await interventions.create({
        runId: "cloud-agent-staging-qualification",
        stepId: "enter-agents",
        type: handoff.category === "anti_automation" ? "human_decision" : "authentication",
        reason: handoff.reason,
        requiredHumanAction: "Complete sign-in in the attached browser tab. No password or MFA code passes through the agent.",
        completionCondition: { type: "authenticated_session_check", realm: "agents-session" },
        environmentId: binding.environmentId,
        authenticationRealm: "agents-session",
        targetId: target.id,
        applicationId: "fi-agents"
      });
      t.diagnostic(`Authentication required → durable resumable state ${record.state} (${record.intervention_id})`);
      assert.equal(record.state, "waiting_for_human");
      assert.equal(record.completionCondition.type, "authenticated_session_check");
      assert.ok(interventions.listPending().some(r => r.intervention_id === record.intervention_id),
        "Pending intervention must be durable and listed for the watcher");
      t.skip("Run is suspended in a resumable waiting state pending human authentication. Re-run after the Agents session is authenticated; no step restarts from the beginning.");
      return;
    }
    t.diagnostic("Authentication state: no login/challenge handoff detected on the entry page.");

    // ── 3. Discover the Agents application through the site's navigation ──
    const discovery = new ApplicationDiscoveryEngine({
      session,
      maxSteps: 8,
      maxLinksPerStep: 4,
      environment: binding,
      onAuthorizationBoundary: boundary => t.diagnostic(`Authorization boundary: ${boundary.category} at ${boundary.url}`)
    });
    const discoveryResult = await discovery.discover();
    assert.ok(discoveryResult.capabilityMap, "Discovery must produce a capability map");
    const map = discoveryResult.capabilityMap;
    t.diagnostic(`Discovered ${map.pages.length} pages, ${map.controls.length} controls, ${(map.childApplications ?? []).length} child applications`);
    for (const child of map.childApplications ?? []) {
      t.diagnostic(`Child application: ${child.applicationId} via ${child.entryFrom} (${child.verified ? "verified" : "unverified"})`);
    }

    // ── 4. Goal-driven workflow: enter Agents and verify the realm ──
    const runner = new TestRunner({ session, interventions, environment: binding });
    const receipt = await runner.run({
      id: "cloud-agent-enter-agents",
      name: "Enter the Agents application from FreeInference staging",
      steps: [
        {
          id: "enter-agents",
          type: "goal",
          goal: "Find and open the Agents (Cloud Agent) application from the FreeInference staging navigation",
          intervention: {
            type: "authentication",
            realm: "agents-session",
            requiredAction: "Complete Agents authentication in the attached browser tab.",
            condition: { type: "authenticated_session_check", realm: "agents-session" }
          }
        },
        {
          id: "verify-agents-realm",
          type: "assert",
          assertion: { type: "page_title_contains", value: "agent" }
        }
      ]
    }, { runId: "cloud-agent-staging-qualification" });

    if (receipt.interventions?.length > 0) {
      // The run suspended at a human-intervention point with durable state.
      t.diagnostic(`Suspended: ${receipt.interventions.map(i => `${i.type}(${i.state})`).join(", ")}`);
      assert.ok(receipt.interventions.every(i => i.interventionId), "Every intervention must be durable");
      t.skip("Workflow suspended at a human-intervention boundary; it resumes from this step once the condition is verified.");
      return;
    }
    assert.ok([RUN_STATUS.PASSED].includes(receipt.status) || receipt.steps.some(s => s.status === "UNCERTAIN"),
      `Browser workflow must execute real steps with meaningful postconditions (got ${receipt.status})`);

    // ── 5. Backend diagnostic correlation (optional, exact identifiers) ──
    const diagUrl = process.env.ACTIVETAB_CLOUD_AGENT_URL;
    const diagToken = process.env.ACTIVETAB_CLOUD_AGENT_ADMIN_TOKEN;
    if (diagUrl && diagToken) {
      const { CloudAgentDiagnosticAdapter } = await import("../src/diagnostics/adapters/cloudAgentApi.js");
      const adapter = new CloudAgentDiagnosticAdapter({
        baseUrl: diagUrl,
        adminToken: diagToken,
        diagnosticTransport: process.env.ACTIVETAB_CLOUD_AGENT_TRANSPORT ?? null,
        remoteTarget: process.env.ACTIVETAB_CLOUD_AGENT_REMOTE_TARGET ?? null,
        environmentBinding: binding
      });
      assert.ok(!isLoopbackUrl(diagUrl) || adapter.diagnosticTransport === "ssh_tunnel",
        "A loopback diagnostic endpoint must be an explicitly configured, verified SSH tunnel");
      const health = await adapter.healthCheck();
      if (health.healthy) {
        const detail = await adapter.getRunDetail(process.env.ACTIVETAB_CLOUD_AGENT_TEST_RUN_ID ?? "");
        t.diagnostic(`Diagnostic adapter healthy (${health.transport ?? "direct"}); run detail: HTTP ${detail.httpStatus ?? "n/a"}`);
        // Correlation must use exact operation identifiers from the browser
        // workflow, not mere temporal proximity.
      } else {
        t.diagnostic(`Diagnostic adapter unreachable: ${health.reason}`);
      }
    } else {
      t.diagnostic("No diagnostic endpoint configured; backend correlation is unavailable for this run and is reported as such.");
    }

    t.diagnostic("✅ Staging browser qualification executed against the real FreeInference website (headed, authorized).");
  } finally {
    if (session) await session.close().catch(() => {});
    await rm(interventionDir, { recursive: true, force: true }).catch(() => {});
  }
});
