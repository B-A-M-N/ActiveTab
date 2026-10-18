import { TRAINING_ELIGIBILITY } from "./decisionEvents.js";

const INDEPENDENT_SOURCES = new Set(["deterministic_assertion", "correlated_backend", "independent_human"]);

export class TrainingLabeler {
  constructor({ store, authenticateApprover } = {}) {
    if (!store) throw new Error("TrainingLabeler requires a DecisionEventStore.");
    this.store = store;
    this.authenticateApprover = authenticateApprover;
  }

  propose({ episodeId, runId, stepId, decisionId, rubricId, labelCode, sourceClass, evidenceRefs = [] }) {
    return this.store.append({
      episodeId, runId, stepId, decisionId, eventType: "label.proposed",
      trainingEligibility: TRAINING_ELIGIBILITY.PENDING,
      payload: { rubricId, labelCode, sourceClass, evidenceRefs }
    });
  }

  async approve({ episodeId, runId, labelEventId, reviewerId }) {
    if (typeof this.authenticateApprover !== "function" || await this.authenticateApprover(reviewerId) !== true) {
      throw new Error("Training-label export requires an independently authenticated reviewer.");
    }
    const events = this.store.getEvents(episodeId);
    const proposed = events.find(event => event.eventId === labelEventId && event.eventType === "label.proposed");
    if (!proposed) throw new Error("The proposed training label was not found in this episode.");
    if (proposed.runId !== runId) throw new Error("Training label run identity mismatch.");
    const { rubricId, labelCode, sourceClass, evidenceRefs } = proposed.payload;
    if (!INDEPENDENT_SOURCES.has(sourceClass)) throw new Error("Model or coding-agent predictions cannot become training ground truth.");
    if (!evidenceRefs.length) throw new Error("Training labels require independent evidence references.");
    const prediction = events.find(event => event.decisionId === proposed.decisionId
      && ((event.eventType === "decision.predicted" && event.payload.rubricId === rubricId)
        || (event.eventType === "semantic.annotated" && event.payload.rubricId === rubricId)));
    if (!prediction) throw new Error("Training label rubric does not match a recorded semantic or Jev prediction.");
    return this.store.append({
      episodeId, runId, stepId: proposed.stepId, decisionId: proposed.decisionId,
      parentEventId: proposed.eventId, eventType: "label.approved",
      trainingEligibility: TRAINING_ELIGIBILITY.ELIGIBLE,
      payload: { labelEventId, rubricId, labelCode, sourceClass, evidenceRefs, reviewerId }
    });
  }
}
