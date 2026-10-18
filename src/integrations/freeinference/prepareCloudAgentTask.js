import { randomUUID } from "node:crypto";
import { buildEnvironmentBinding, verifyObservedUrl } from "../../environments/model.js";
import { CLOUD_AGENT_TASK_ROLES, createCloudAgentTaskPlan } from "./cloudAgentWorkflow.js";

export const CLOUD_AGENT_MAPPING_CONFIDENCE_THRESHOLD = 0.8;

function supportedCandidate(candidate, role) {
  if (!candidate || candidate.visible !== true || candidate.disabled === true || candidate.frameTargetId) return false;
  if (role === CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR) {
    return candidate.tag === "select" || String(candidate.role ?? "").toLowerCase() === "combobox";
  }
  if (role === CLOUD_AGENT_TASK_ROLES.TASK_PROMPT) {
    const roleName = String(candidate.role ?? "").toLowerCase();
    if (candidate.tag === "textarea") return true;
    if (candidate.tag === "input") return candidate.type === null || candidate.type === undefined
      || ["text", "search"].includes(String(candidate.type).toLowerCase());
    const editable = candidate.contentEditable === true;
    return editable && ["textbox", "searchbox"].includes(roleName);
  }
  if (role === CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK) {
    return String(candidate.role ?? "").toLowerCase() === "button"
      && (candidate.tag === "button" || candidate.tag === "input");
  }
  return false;
}

function resolveControlRoles(observation, semantic, { allowSemanticAssociation = false } = {}) {
  const roles = Object.values(CLOUD_AGENT_TASK_ROLES);
  const candidates = (observation.candidates ?? []).filter(candidate => candidate.targetId === observation.targetId
    && candidate.frameTargetId == null && candidate.visible === true && candidate.disabled !== true);
  const annotations = new Map((semantic?.annotations ?? []).map(annotation => [annotation.semanticRole, annotation]));
  const fixed = new Map();
  for (const role of roles) {
    const annotation = annotations.get(role);
    if (annotation?.resultCode !== "mapped" || annotation.confidence < CLOUD_AGENT_MAPPING_CONFIDENCE_THRESHOLD) continue;
    const candidate = candidates.find(item => item.identity === annotation.candidateRef);
    if (supportedCandidate(candidate, role)) fixed.set(role, candidate);
  }

  // Enumerate complete typed control triples. The structural fallback is
  // accepted only when the fresh observation leaves exactly one valid form
  // mapping after applying any usable semantic predictions.
  const modelChoices = fixed.has(CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR)
    ? [fixed.get(CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR)]
    : candidates.filter(candidate => supportedCandidate(candidate, CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR));
  const promptChoices = fixed.has(CLOUD_AGENT_TASK_ROLES.TASK_PROMPT)
    ? [fixed.get(CLOUD_AGENT_TASK_ROLES.TASK_PROMPT)]
    : candidates.filter(candidate => supportedCandidate(candidate, CLOUD_AGENT_TASK_ROLES.TASK_PROMPT));
  const submitChoices = fixed.has(CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK)
    ? [fixed.get(CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK)]
    : candidates.filter(candidate => supportedCandidate(candidate, CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK) && candidate.submitsForm === true);
  const triples = [];
  for (const model of modelChoices) {
    for (const prompt of promptChoices) {
      for (const submit of submitChoices) {
        if (prompt.identity === submit.identity) continue;
        const sameForm = prompt.formIdentity && prompt.formIdentity === submit.formIdentity;
        if (!sameForm && !allowSemanticAssociation) continue;
        if (new Set([model.identity, prompt.identity, submit.identity]).size !== 3) continue;
        triples.push({ model, prompt, submit });
        if (triples.length > 1) break;
      }
      if (triples.length > 1) break;
    }
    if (triples.length > 1) break;
  }
  if (triples.length !== 1) {
    throw Object.assign(new Error("Cloud Agent controls remain ambiguous in the fresh observation after semantic and structural resolution."), { code: "semantic_mapping_unresolved" });
  }
  return {
    [CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR]: triples[0].model.identity,
    [CLOUD_AGENT_TASK_ROLES.TASK_PROMPT]: triples[0].prompt.identity,
    [CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK]: triples[0].submit.identity
  };
}

/**
 * Compose semantic control mapping, the FreeInference task adapter, and the
 * declared environment into a runnable plan. Jev reviews each effect when the
 * generic runner reaches that step; preparation itself dispatches nothing.
 */
export async function prepareCloudAgentTask({ session, profile, request, decisionRuntime, runId, signal } = {}) {
  if (!session || session.attached !== true || !session.target?.id) {
    throw new Error("Cloud Agent task preparation requires the exact attached browser target.");
  }
  if (!decisionRuntime?.startEpisode || !decisionRuntime?.annotateRoles) throw new Error("Cloud Agent task preparation requires ActiveTab's decision runtime and semantic adapter.");
  if (typeof runId !== "string" || !runId) throw new Error("Cloud Agent task preparation requires a stable run ID.");

  const environment = buildEnvironmentBinding(profile);
  if (environment.environmentId !== "freeinference-staging") {
    throw new Error("Cloud Agent task preparation is limited to the declared FreeInference staging environment.");
  }
  const observation = await session.observe();
  if (!observation?.evidenceId || observation.targetId !== session.target.id || !observation.page?.url) {
    throw new Error("Cloud Agent task preparation requires a fresh observation from the selected browser target.");
  }
  const observedIdentity = verifyObservedUrl(environment, observation.page.url);
  if (!observedIdentity.ok) throw new Error(observedIdentity.reason);

  const episode = decisionRuntime.startEpisode({
    runId,
    workflowId: "freeinference_cloud_agent_task",
    applicationId: "fi-agents",
    environmentClass: "staging",
    executionMode: "agent_directed",
    policyVersion: "active_policy_v1",
    workflowKind: "cloud_agent_task"
  });
  const mappingDecisionId = randomUUID();
  const roles = Object.values(CLOUD_AGENT_TASK_ROLES);
  let mappedRoles;
  let semantic = null;
  let semanticEventIds = [];
  let mappingSource = "deterministic_structural";
  try {
    // Prefer exact native structure. The semantic endpoint is reserved for
    // observations where the page does not expose one complete, unique form.
    mappedRoles = resolveControlRoles(observation, null);
  } catch (error) {
    if (error?.code !== "semantic_mapping_unresolved") throw error;
    const semanticObservation = {
      ...observation,
      candidates: (observation.candidates ?? []).filter(candidate => candidate.targetId === observation.targetId
        && roles.some(role => supportedCandidate(candidate, role)))
    };
    // The analyzer only maps current controls. Caller-supplied model IDs,
    // task text, expected outcomes, and execution scope are never sent here.
    const semanticReview = await decisionRuntime.annotateRoles({
      observation: semanticObservation,
      requestedRoles: roles,
      intentHints: ["cloud_agent_task_composer"],
      episodeId: episode.episodeId,
      runId,
      stepId: "step_control_mapping",
      decisionId: mappingDecisionId,
      operation: "map_cloud_agent_task_control",
      operationClass: "unknown",
      targetRole: "cloud_agent_task_composer",
      expectedOutcomeClass: "observed_controls_match_typed_roles",
      signal
    });
    semantic = semanticReview?.semantic ?? null;
    semanticEventIds = [...(semanticReview?.eventIds ?? semantic?.eventIds ?? [])];
    mappedRoles = resolveControlRoles(observation, semantic, { allowSemanticAssociation: semantic !== null });
    mappingSource = "semantic_annotation";
  }
  const roleMappings = roles.map(role => ({ role, candidateRef: mappedRoles[role] }));
  const targetResolution = decisionRuntime.recordTargetResolution({
    episodeId: episode.episodeId,
    runId,
    stepId: "step_control_mapping",
    decisionId: mappingDecisionId,
    observationId: observation.evidenceId,
    resolver: mappingSource,
    roleMappings,
    reasonCode: mappingSource === "semantic_annotation" ? "semantic_disambiguated_observed_form" : "unique_observed_form_structure",
    evidenceRefs: [observation.evidenceId],
    inputEventIds: semanticEventIds
  });
  const plan = createCloudAgentTaskPlan({
    profile,
    request,
    observation,
    mapping: {
      observationId: observation.evidenceId,
      roles: mappedRoles,
      semanticAnnotations: semantic?.annotations ?? [],
      semanticEventIds
    }
  });
  return Object.freeze({
    ...plan,
    runId,
    episodeId: episode.episodeId,
    environment,
    observation,
    semanticMappingDecisionId: mappingDecisionId,
    semanticMappingSource: mappingSource,
    semanticMappingEventIds: Object.freeze(semanticEventIds),
    semanticMapping: semantic,
    targetResolutionEventId: targetResolution?.eventId ?? null,
    diagnosticEndpointBindings: environment.diagnosticEndpointBindings
  });
}
