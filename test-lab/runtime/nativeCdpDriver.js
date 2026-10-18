import { isSafeTelemetryCode } from "../../src/telemetry/privacy.js";
import { NavigationEngine } from "../../src/navigation/engine.js";
import { launchOwnedChrome } from "../../src/browser/ownedChrome.js";

function observedRunId(observation) {
  for (const heading of observation?.headings ?? []) {
    const text = String(heading?.text ?? "").trim();
    if (!text.startsWith("Run ")) continue;
    const parts = text.split(" ").filter(Boolean);
    const candidate = parts.at(-1);
    if (isSafeTelemetryCode(candidate, { maxLength: 96 })) return candidate;
  }
  for (const candidate of observation?.candidates ?? []) {
    const value = String(candidate?.href ?? "");
    if (!value.startsWith("/app?run=")) continue;
    const runId = new URL(value, "http://fixture.invalid").searchParams.get("run");
    if (isSafeTelemetryCode(runId, { maxLength: 96 })) return runId;
  }
  return null;
}

/**
 * Compose the fixture driver from ActiveTab's normal native-CDP navigation
 * path. The fixture binding supplies explicit authorized origins; no
 * localFixture override or oracle capability is passed to the browser agent.
 */
export function createNativeCdpQualificationDriver({
  decisionRuntime = null,
  plannerMode = "deterministic",
  launchBrowser = launchOwnedChrome,
  headed = true
} = {}) {
  if (typeof launchBrowser !== "function") throw new TypeError("A trusted owned-Chrome launcher is required.");
  return async function driveQualification({ automationRunId, targetBinding, task, signal } = {}) {
    const environment = targetBinding?.environment;
    const authorizedOrigins = environment?.authorizedOrigins;
    if (!Array.isArray(authorizedOrigins) || !authorizedOrigins.length
      || !authorizedOrigins.every(origin => {
        try {
          const parsed = new URL(origin);
          return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin;
        } catch { return false; }
      })) {
      return { status: "uncertain", reasonCode: "fixture_environment_unbound" };
    }
    const owned = await launchBrowser({
      initialUrl: targetBinding.entryUrl,
      headed,
      signal,
      keepBrowserOpen: false,
      preserveProfile: false,
      reuseExisting: false
    });
    try {
      const engine = new NavigationEngine(owned.session, {
        environment,
        decisionRuntime,
        decisionContext: {
          runId: automationRunId,
          workflowId: task.scenarioId,
          applicationId: targetBinding.targetIdentity?.siteFamily ?? "fixture"
        },
        executionMode: "standalone",
        plannerMode,
        signal,
        maxActions: 10,
        maxRecoveries: 1
      });
      const result = await engine.run(task.goal, { signal });
      const observation = await owned.session.observe().catch(() => null);
      return Object.freeze({
        status: result?.status === "succeeded" ? "succeeded"
          : result?.status === "needs_human" ? "uncertain" : "failed",
        reportedRunId: observedRunId(observation),
        reasonCode: result?.status === "needs_human" ? "human_handoff_required"
          : result?.status === "succeeded" ? null : "active_tab_run_incomplete"
      });
    } finally {
      await owned.close();
    }
  };
}
