import { TRAINING_ELIGIBILITY } from "./decisionEvents.js";

export class TrainingLabeler {
  constructor({ store } = {}) {
    if (!store) throw new Error("TrainingLabeler requires a DecisionEventStore.");
    this.store = store;
  }

  propose({ episodeId, runId, stepId, decisionId, rubricId, labelCode, sourceClass, evidenceRefs = [] }) {
    return this.store.append({
      episodeId, runId, stepId, decisionId, eventType: "label.proposed",
      trainingEligibility: TRAINING_ELIGIBILITY.PENDING,
      payload: { rubricId, labelCode, sourceClass, evidenceRefs }
    });
  }

  approve({ episodeId, runId, labelEventId }) {
    return this.store.approveTrainingLabel({ episodeId, runId, labelEventId });
  }
}
