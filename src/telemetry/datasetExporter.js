import { buildEpisode } from "./episodeBuilder.js";

const SPLIT_KINDS = new Set(["application", "workflow", "time"]);

/**
 * Build a provenance-preserving dataset split by a held-out group. The caller
 * must choose a held-out application, workflow, or time boundary; there is no
 * random per-event split that could leak near-duplicate workflow states.
 */
export function buildTrainingDataset(store, { split, datasetVersion = "1", includeUnlabeled = false } = {}) {
  if (!split || !SPLIT_KINDS.has(split.kind)) throw new Error("Dataset export requires a split by application, workflow, or time.");
  if (split.kind === "time" && !Number.isFinite(Date.parse(split.cutoff))) throw new Error("Time split requires a valid cutoff timestamp.");
  if (split.kind !== "time" && (!Array.isArray(split.holdout) || split.holdout.length === 0)) throw new Error("Grouped split requires at least one held-out group.");
  const holdout = new Set(split.holdout ?? []);
  const examples = [];
  for (const row of store.listEpisodes({ limit: 10_000 })) {
    const episode = buildEpisode(store, row.episode_id);
    if (!episode?.integrity?.ok) throw new Error(`Episode '${row.episode_id}' failed event-chain integrity verification.`);
    for (const decision of episode.decisions) {
      if (!decision.inputLineageComplete) continue;
      if (!includeUnlabeled && !decision.trainingEligible) continue;
      const group = split.kind === "application" ? episode.episode.applicationId
        : split.kind === "workflow" ? episode.episode.workflowId
          : episode.episode.createdAt;
      const evaluation = split.kind === "time"
        ? Date.parse(group) >= Date.parse(split.cutoff)
        : holdout.has(group);
      examples.push({
        schemaVersion: 1,
        datasetVersion,
        split: evaluation ? "evaluation" : "train",
        group,
        applicationId: episode.episode.applicationId,
        workflowId: episode.episode.workflowId,
        episodeId: episode.episode.episodeId,
        runId: episode.episode.runId,
        decisionId: decision.decisionId,
        stepId: decision.stepId,
        predictionEventId: decision.predictionEventId,
        inputEventIds: decision.inputEventIds,
        inputEvents: decision.inputEvents,
        inputLineageComplete: decision.inputLineageComplete,
        prediction: decision.prediction,
        ...(decision.usage ? { usage: decision.usage } : {}),
        model: decision.model,
        outcomeEvents: decision.outcomeEvents,
        label: decision.label,
        labelProvenance: decision.label ? { sourceClass: decision.label.sourceClass, evidenceRefs: decision.label.evidenceRefs, approvalEventId: decision.label.approvalEventId } : null
      });
    }
  }
  return {
    schemaVersion: 1,
    datasetVersion,
    createdAt: new Date().toISOString(),
    split: { ...split, holdout: split.holdout ? [...split.holdout] : undefined },
    eligibleExampleCount: examples.length,
    examples
  };
}
