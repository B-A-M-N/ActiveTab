import test from "node:test";
import assert from "node:assert/strict";
import { DecisionEventStore } from "../src/telemetry/eventStore.js";
import { eventIdsForEvidence } from "../src/telemetry/evidenceRefs.js";

test("evidence references resolve to linked event IDs, never raw evidence IDs", () => {
  const store = new DecisionEventStore({ databasePath: ":memory:" });
  try {
    const episode = store.startEpisode({ runId: "run_evidence_refs", workflowId: "cloud_agent_test", applicationId: "fi_agents" });
    const observed = store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_submit",
      decisionId: "decision_submit",
      observationId: "browser_after",
      eventType: "execution.observed",
      payload: { outcomeClass: "task_run_identifier_observed", changed: true, evidenceRefs: ["browser_before", "browser_after"] }
    });
    const verification = store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_submit",
      decisionId: "decision_submit",
      observationId: "browser_run_id",
      eventType: "verification.completed",
      payload: { status: "uncertain", oracleType: "correlated_backend", reasonCode: "backend_pending", evidenceRefs: ["browser_run_id", "backend_run"] }
    });
    store.append({
      episodeId: episode.episodeId,
      runId: episode.runId,
      stepId: "step_other",
      decisionId: "decision_other",
      observationId: "browser_run_id",
      eventType: "execution.observed",
      payload: { outcomeClass: "unrelated", changed: false, evidenceRefs: ["browser_run_id"] }
    });

    assert.deepEqual(eventIdsForEvidence(store, {
      episodeId: episode.episodeId,
      decisionId: "decision_submit",
      evidenceIds: ["browser_after", "browser_run_id"],
      eventTypes: ["execution.observed", "verification.completed"]
    }), [observed.eventId, verification.eventId]);
    assert.equal(eventIdsForEvidence(store, {
      episodeId: episode.episodeId,
      decisionId: "decision_submit",
      evidenceIds: ["browser_run_id"],
      eventTypes: ["execution.observed", "verification.completed"]
    }).includes("browser_run_id"), false);
  } finally {
    store.close();
  }
});
