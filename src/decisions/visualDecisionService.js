import { groundVisualTarget } from "../navigation/visualGrounder.js";

/**
 * Narrow, advisory visual decisions over a fresh observation. This service
 * has no browser handle and cannot authorize or dispatch browser operations.
 */
export class VisualDecisionService {
  constructor({ coordinator } = {}) {
    if (!coordinator || typeof coordinator.reviewVisualAssessment !== "function") {
      throw new Error("VisualDecisionService requires the shared decision coordinator.");
    }
    this.coordinator = coordinator;
  }

  classifyPage(observation, options = {}) {
    return this.coordinator.reviewVisualAssessment({
      ...options,
      task: "page_classification",
      observation,
      imageEvidence: options.imageEvidence ?? observation?.visualEvidence
    });
  }

  detectObstructions(observation, options = {}) {
    return this.coordinator.reviewVisualAssessment({
      ...options,
      task: "obstruction_detection",
      observation,
      imageEvidence: options.imageEvidence ?? observation?.visualEvidence
    });
  }

  assessVisualOutcome(before, after, options = {}) {
    return this.coordinator.reviewVisualAssessment({
      ...options,
      task: "outcome_assessment",
      beforeObservation: before,
      observation: after,
      imageEvidence: options.imageEvidence ?? after?.visualEvidence
    });
  }

  async groundTarget(observation, { targetRoleCode, ...options } = {}) {
    const imageEvidence = options.imageEvidence ?? observation?.visualEvidence;
    const assessment = await this.coordinator.reviewVisualAssessment({
      ...options,
      task: "target_grounding",
      targetRoleCode,
      observation,
      imageEvidence
    });
    if (assessment?.status !== "reviewed") return { ...assessment, grounding: null };
    const grounding = groundVisualTarget({
      observation,
      imageEvidence,
      answers: assessment.answers,
      allowedCandidateIds: options.allowedCandidateIds ?? null
    });
    return { ...assessment, grounding };
  }
}
