import { isValidApprovedLabel } from "./labelProvenance.js";

/** Rebuild decision examples without leaking information learned after prediction. */
export function buildEpisode(store, episodeId) {
  const episode = store.getEpisode(episodeId);
  if (!episode) return null;
  const events = store.getEvents(episodeId);
  const eventById = new Map(events.map(event => [event.eventId, event]));
  const qualifications = events.filter(event => event.eventType === "qualification.completed").map(completed => {
    const started = eventById.get(completed.parentEventId);
    if (!started || started.eventType !== "qualification.started"
      || started.payload.qualificationId !== completed.payload.qualificationId
      || started.decisionId !== completed.decisionId) return null;
    return {
      qualificationId: completed.payload.qualificationId,
      automationRunId: completed.payload.automationRunId,
      scenarioId: completed.payload.scenarioId,
      providerId: completed.payload.providerId,
      trigger: completed.payload.trigger,
      strategyFingerprint: completed.payload.strategyFingerprint,
      status: completed.payload.qualificationStatus,
      reasonCode: completed.payload.reasonCode,
      ...(completed.payload.qualificationLevel ? {
        qualification: {
          level: completed.payload.qualificationLevel,
          providerIdentity: completed.payload.providerIdentity,
          scenarioSeed: completed.payload.scenarioSeed,
          sourceRevision: completed.payload.sourceRevision,
          oracleReference: completed.payload.oracleReference,
          independentApplicationOutcome: completed.payload.independentApplicationOutcome,
          cleanupResult: completed.payload.cleanupResult
        }
      } : {}),
      sourceEventIds: started.payload.sourceEventIds,
      evidenceRefs: completed.payload.evidenceRefs,
      eventIds: [started.eventId, completed.eventId],
      knowledgeState: completed.payload.qualificationStatus === "qualified" ? "candidate" : "not_reusable",
      trainingEligibility: "pending"
    };
  }).filter(Boolean);
  const decisionPredictions = events.filter(event => ["decision.predicted", "semantic.annotated", "planner.predicted"].includes(event.eventType) && event.decisionId);
  const modelFailures = events.filter(event => event.eventType === "planner.failed").map(event => ({
    eventId: event.eventId,
    sequence: event.sequence,
    decisionId: event.decisionId,
    stepId: event.stepId ?? null,
    model: event.payload.model,
    inputModality: event.payload.inputModality,
    failureCode: event.payload.failureCode
  }));
  const decisions = decisionPredictions.map(prediction => {
    if (prediction.eventType === "planner.predicted") {
      const later = events.filter(event => event.sequence > prediction.sequence && event.decisionId === prediction.decisionId);
      return {
        decisionId: prediction.decisionId,
        stepId: prediction.stepId ?? null,
        predictionEventId: prediction.eventId,
        sequenceAtPrediction: prediction.sequence,
        sourceType: "planner",
        model: { provider: prediction.payload.provider, model: prediction.payload.model },
        prediction: {
          resultCode: prediction.payload.resultCode,
          reasonCode: prediction.payload.reasonCode ?? null,
          actionType: prediction.payload.actionType ?? null,
          selectedCandidateFingerprint: prediction.payload.selectedCandidateFingerprint ?? null
        },
        inputFingerprint: prediction.payload.inputFingerprint,
        inputModality: prediction.payload.inputModality,
        usage: prediction.payload.usage ?? null,
        inputEventIds: [],
        inputEvents: [],
        inputLineageComplete: false,
        laterEventIds: later.map(event => event.eventId),
        outcomeEvents: later.filter(event => ["execution.observed", "verification.completed", "correction.recorded"].includes(event.eventType)).map(projectTrainingEvent),
        label: null,
        trainingEligible: false
      };
    }
    // Use only explicit model-input references. The surrounding event prefix
    // is not proof that a model saw every earlier event.
    const referencedInputEvents = (prediction.payload.inputEventIds ?? [])
      .map(eventId => eventById.get(eventId))
      .filter(event => event && event.sequence < prediction.sequence);
    const requiredInputType = prediction.eventType === "semantic.annotated" ? "semantic.input_captured" : "decision.input_captured";
    const inputMatchesPrediction = event => {
      if (event.eventType === "semantic.input_captured") {
        return event.payload.inputFingerprint === prediction.payload.inputFingerprint
          && event.payload.rubricHash === prediction.payload.rubricHash;
      }
      const rubricIds = event.payload.rubricIds ?? [];
      return rubricIds.includes(prediction.payload.rubricId)
        && (prediction.payload.inputFingerprint === undefined
          || event.payload.inputFingerprint === prediction.payload.inputFingerprint);
    };
    const reconstructedInput = referencedInputEvents.find(event => event.eventType === requiredInputType
      && event.decisionId === prediction.decisionId
      && event.observationId === prediction.observationId
      && inputMatchesPrediction(event));
    const later = events.filter(event => event.sequence > prediction.sequence && event.decisionId === prediction.decisionId);
    const rubricId = prediction.payload.rubricId ?? prediction.payload.annotationKind;
    const approvedLabel = events.find(event => event.decisionId === prediction.decisionId
      && event.payload.rubricId === rubricId && isValidApprovedLabel(events, event, prediction));
    return {
      decisionId: prediction.decisionId,
      stepId: prediction.stepId ?? null,
      predictionEventId: prediction.eventId,
      sequenceAtPrediction: prediction.sequence,
      sourceType: prediction.eventType === "semantic.annotated" ? "semantic" : "decision",
      rubricId,
      model: prediction.eventType === "semantic.annotated"
        ? { provider: prediction.payload.analyzerProvider, model: prediction.payload.analyzerModel, rubricVersion: prediction.payload.rubricVersion ?? null, rubricHash: prediction.payload.rubricHash ?? null, annotationKind: prediction.payload.annotationKind }
        : { provider: prediction.payload.provider, model: prediction.payload.model, rubricId: prediction.payload.rubricId, rubricVersion: prediction.payload.rubricVersion, rubricHash: prediction.payload.rubricHash ?? null, questionType: prediction.payload.questionType },
      prediction: prediction.eventType === "semantic.annotated"
        ? { type: "semantic", semanticRole: prediction.payload.semanticRole, candidateRef: prediction.payload.candidateRef ?? null, resultCode: prediction.payload.resultCode, confidence: prediction.payload.confidence, uncertaintyCode: prediction.payload.uncertaintyCode ?? null }
        : prediction.payload.answer,
      inputFingerprint: prediction.payload.inputFingerprint ?? null,
      ...(prediction.payload.usage ? { usage: prediction.payload.usage } : {}),
      inputEventIds: referencedInputEvents.map(event => event.eventId),
      inputEvents: referencedInputEvents.map(projectTrainingEvent),
      inputLineageComplete: Boolean(reconstructedInput && reconstructedInput.trainingEligibility !== "excluded"),
      laterEventIds: later.map(event => event.eventId),
      outcomeEvents: later.filter(event => ["execution.observed", "verification.completed", "correction.recorded"].includes(event.eventType)).map(projectTrainingEvent),
      label: approvedLabel ? { labelCode: approvedLabel.payload.labelCode, sourceClass: approvedLabel.payload.sourceClass, evidenceRefs: approvedLabel.payload.evidenceRefs, approvalEventId: approvedLabel.eventId } : null,
      trainingEligible: Boolean(approvedLabel && approvedLabel.trainingEligibility === "eligible")
    };
  });
  return {
    schemaVersion: 1,
    episode: {
      episodeId: episode.episode_id,
      runId: episode.run_id,
      workflowId: episode.workflow_id,
      applicationId: episode.application_id,
      environmentClass: episode.environment_class,
      executionMode: episode.execution_mode,
      policyVersion: episode.policy_version,
      status: episode.status,
      createdAt: episode.created_at,
      completedAt: episode.completed_at ?? null
    },
    eventCount: events.length,
    integrity: store.verifyEpisodeChain(episodeId),
    events: events.map(projectTrainingEvent),
    inferenceRoutes: events.filter(event => event.eventType === "inference.route_selected").map(event => ({
      eventId: event.eventId,
      sequence: event.sequence,
      decisionId: event.decisionId,
      stepId: event.stepId ?? null,
      observationId: event.observationId ?? null,
      ...event.payload
    })),
    modelFailures,
    decisions,
    qualifications
  };
}

function projectTrainingEvent(event) {
  // Event payloads are already a structural allowlist; omit storage internals
  // and any event that is not useful as model input or evaluation context.
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    eventType: event.eventType,
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.decisionId ? { decisionId: event.decisionId } : {}),
    ...(event.observationId ? { observationId: event.observationId } : {}),
    ...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
    payload: event.payload
  };
}
