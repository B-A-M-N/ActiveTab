import { createHash } from "node:crypto";
import { validateWorkflow } from "../../testing/schema.js";
import { canonicalInputHash } from "../../runtime/approvals.js";

export const CLOUD_AGENT_TASK_ROLES = Object.freeze({
  REPOSITORY_SELECTOR: "cloud_agent_repository_selector",
  REF_SELECTOR: "cloud_agent_ref_selector",
  RUNTIME_SELECTOR: "cloud_agent_runtime_selector",
  MODEL_SELECTOR: "cloud_agent_model_selector",
  TASK_PROMPT: "cloud_agent_task_prompt",
  SUBMIT_TASK: "cloud_agent_submit_task"
});

const OPERATION_IDS = Object.freeze({
  selectModel: "freeinference.cloud_agent.select_model",
  enterPrompt: "freeinference.cloud_agent.enter_prompt",
  submitTask: "freeinference.cloud_agent.submit_task"
});

const ALLOWED_DIAGNOSTIC_SOURCES = new Set([
  "cloud-agent-runs",
  "cloud-agent-steps",
  "cloud-agent-usage"
]);
const CLOUD_AGENT_RUN_STATUSES = new Set([
  "queued", "pending", "running", "started", "completed", "succeeded", "success",
  "failed", "error", "canceled", "cancelled", "timed_out", "timeout", "paused"
]);
const NONTERMINAL_RUN_STATUSES = new Set(["queued", "pending", "running", "started", "paused"]);
const SEMANTIC_MAPPING_CONFIDENCE_THRESHOLD = 0.8;

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters.`);
  }
  return value;
}

function validateExpectedOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "kind") || !Object.hasOwn(value, "value")
    || value.kind !== "run_status" || typeof value.value !== "string"
    || !CLOUD_AGENT_RUN_STATUSES.has(value.value) || NONTERMINAL_RUN_STATUSES.has(value.value)) {
    throw new Error("expectedOutcome must specify one exact terminal run_status value.");
  }
  return { kind: "run_status", value: value.value };
}

/** Compare caller-authored expected status to the exact projected run record. */
export function verifyCloudAgentRunOutcome(expectedOutcome, backendRun) {
  let expected;
  try { expected = validateExpectedOutcome(expectedOutcome); }
  catch { return { status: "UNCERTAIN", reasonCode: "unsupported_expected_outcome", reason: "The requested outcome contract is not a supported exact run-status assertion." }; }
  const actual = typeof backendRun?.status === "string" ? backendRun.status : null;
  if (!actual || !CLOUD_AGENT_RUN_STATUSES.has(actual)) {
    return { status: "UNCERTAIN", reasonCode: "backend_status_unavailable", reason: "The exact backend run record has no supported status value." };
  }
  if (actual === expected.value) {
    return { status: "VERIFIED", reasonCode: "exact_run_status_match", reason: `Exact backend run status '${actual}' matches the caller's expected status.` };
  }
  if (NONTERMINAL_RUN_STATUSES.has(actual)) {
    return { status: "UNCERTAIN", reasonCode: "run_not_terminal", reason: `The exact backend run remains '${actual}'; its requested outcome is not yet established.` };
  }
  return { status: "FAILED", reasonCode: "exact_run_status_mismatch", reason: `Exact backend run status '${actual}' does not match the caller's expected status.` };
}

function assertBoundedJson(value, label, { maxBytes = 8192, maxDepth = 8 } = {}) {
  const seen = new Set();
  const visit = (item, depth) => {
    if (depth > maxDepth) throw new Error(`${label} exceeds the supported nesting depth.`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${label} contains a non-finite number.`);
      return;
    }
    if (typeof item !== "object" || seen.has(item)) throw new Error(`${label} must contain only acyclic JSON values.`);
    seen.add(item);
    if (Array.isArray(item)) item.forEach(child => visit(child, depth + 1));
    else for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
}

function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function resolveMappedCandidate(observation, mapping, role, accepts) {
  if (!mapping || mapping.observationId !== observation.evidenceId) {
    throw new Error("Cloud Agent control mappings must reference the exact current observation.");
  }
  const identity = mapping.roles?.[role];
  if (typeof identity !== "string" || !identity) throw new Error(`Cloud Agent control mapping is missing '${role}'.`);
  const matches = (observation.candidates ?? []).filter(candidate => candidate.identity === identity);
  if (matches.length !== 1) throw new Error(`Cloud Agent role '${role}' does not resolve to one observed control.`);
  const candidate = matches[0];
  if (!accepts(candidate) || candidate.visible !== true || candidate.disabled === true || candidate.frameTargetId) {
    throw new Error(`Cloud Agent role '${role}' is not a supported, visible main-frame control.`);
  }
  return candidate;
}

function validateProfile(profile) {
  if (profile?.profile_id !== "cloud-agent-staging") throw new Error("The FreeInference Cloud Agent adapter requires the cloud-agent-staging profile.");
  const environment = profile.environment;
  if (environment?.environment_id !== "freeinference-staging") throw new Error("Cloud Agent task execution is limited to the declared FreeInference staging environment.");
  const origins = [...new Set((environment.authorized_origins ?? []).map(originOf).filter(Boolean))];
  const entryOrigin = originOf(environment.application_entry_url);
  if (!entryOrigin || !origins.includes(entryOrigin)) throw new Error("The Cloud Agent profile must bind its entry origin to the authorized-origin set.");
  const agentApplication = (environment.applications ?? []).find(application => application.application_id === "fi-agents");
  const agentOrigin = originOf(agentApplication?.candidate_entry);
  if (agentApplication?.authentication_realm !== "agents-session" || !agentOrigin || !origins.includes(agentOrigin)) {
    throw new Error("The Cloud Agent profile must declare its separate Agents authentication realm and candidate origin.");
  }
  return { environmentId: environment.environment_id, agentOrigin };
}

const REQUEST_KEYS = new Set([
  "version", "requestId", "environmentId", "repository", "runtimeId", "modelId", "prompt",
  "options", "effectGrantId", "expectedOutcome", "diagnosticSources", "cleanupPolicyId"
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.has(key))
    || [...keys].some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain exactly the supported fields; unknown or omitted fields are not accepted.`);
  }
}

function boundedIdentifier(value, label, maxLength = 256) {
  return requiredText(value, label, maxLength);
}

function validateOptionIds(value, label) {
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${label} must be an explicit array with at most 50 supported identifiers.`);
  const normalized = value.map((item, index) => boundedIdentifier(item, `${label}[${index}]`, 128));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicate identifiers.`);
  return normalized;
}

/** Validate and fingerprint every field that can define a staging Agent job. */
export function validateCloudAgentTaskRequest(request, profile) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("A typed Cloud Agent task request is required.");
  exactKeys(request, REQUEST_KEYS, "Cloud Agent request v2");
  if (request.version !== 2) throw new Error("Cloud Agent request version 2 is required.");
  const environmentId = profile?.environment?.environment_id;
  if (request.environmentId !== environmentId || environmentId !== "freeinference-staging") throw new Error("Task request environment does not match the Cloud Agent staging profile.");
  const requestId = requiredText(request.requestId, "requestId", 128);
  const repositoryInput = request.repository;
  exactKeys(repositoryInput, new Set(["provider", "repositoryId", "baseRef", "expectedCommit"]), "repository");
  if (repositoryInput.provider !== "github") throw new Error("Only the reviewed GitHub repository provider is supported.");
  const repository = {
    provider: "github",
    repositoryId: boundedIdentifier(repositoryInput.repositoryId, "repository.repositoryId"),
    baseRef: boundedIdentifier(repositoryInput.baseRef, "repository.baseRef", 256),
    expectedCommit: repositoryInput.expectedCommit === null
      ? null : boundedIdentifier(repositoryInput.expectedCommit, "repository.expectedCommit", 128)
  };
  const workspaceGrants = profile?.test_workspace_grants;
  const repositoryAuthorized = Array.isArray(workspaceGrants) && workspaceGrants.some(grant =>
    grant?.provider === repository.provider
      && Array.isArray(grant.repository_ids) && grant.repository_ids.includes(repository.repositoryId)
      && Array.isArray(grant.base_refs) && grant.base_refs.includes(repository.baseRef));
  if (!repositoryAuthorized) throw new Error("Requested repository and base ref are outside the profile's trusted test-workspace grants.");
  const runtimeId = boundedIdentifier(request.runtimeId, "runtimeId", 256);
  const modelId = requiredText(request.modelId, "modelId", 500);
  const prompt = requiredText(request.prompt, "prompt", 2000);
  const optionsInput = request.options;
  exactKeys(optionsInput, new Set(["reasoning", "skills", "plugins", "mcpServers", "attachments"]), "options");
  const reasoning = optionsInput.reasoning === null ? null : boundedIdentifier(optionsInput.reasoning, "options.reasoning", 128);
  const options = {
    reasoning,
    skills: validateOptionIds(optionsInput.skills, "options.skills"),
    plugins: validateOptionIds(optionsInput.plugins, "options.plugins"),
    mcpServers: validateOptionIds(optionsInput.mcpServers, "options.mcpServers"),
    attachments: validateOptionIds(optionsInput.attachments, "options.attachments")
  };
  // These selections have no independently reviewed composer binding yet. Refuse
  // them explicitly until the deployed control and identifier contract is verified.
  if (options.skills.length || options.plugins.length || options.mcpServers.length || options.attachments.length) {
    throw new Error("Requested skills, plugins, MCP servers, or attachments are not supported by the reviewed staging composer contract.");
  }
  if (reasoning !== null) throw new Error("Reasoning selection is not supported by the reviewed staging composer contract.");
  const effectGrantId = boundedIdentifier(request.effectGrantId, "effectGrantId", 128);
  const cleanupPolicyId = boundedIdentifier(request.cleanupPolicyId, "cleanupPolicyId", 128);
  const expectedOutcome = validateExpectedOutcome(request.expectedOutcome);
  assertBoundedJson(expectedOutcome, "expectedOutcome");
  const diagnosticSources = request.diagnosticSources;
  if (!Array.isArray(diagnosticSources) || diagnosticSources.length > 6 || diagnosticSources.some(source => !ALLOWED_DIAGNOSTIC_SOURCES.has(source))) {
    throw new Error("Diagnostic source requests must use the bounded Cloud Agent run evidence allowlist.");
  }
  const normalized = {
    version: 2, requestId, environmentId, repository, runtimeId, modelId, prompt, options,
    effectGrantId, expectedOutcome, diagnosticSources: [...new Set(diagnosticSources)], cleanupPolicyId
  };
  return Object.freeze({ ...normalized, requestHash: canonicalInputHash(normalized) });
}

function validateTaskRequest(request, profile) {
  const environmentId = profile.environment.environment_id;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("A typed Cloud Agent task request is required.");
  const normalized = validateCloudAgentTaskRequest(request, profile);
  return { ...normalized, environmentId };
}

/**
 * Compile one caller-authored Cloud Agent task into ordinary ActiveTab
 * workflow steps. The adapter consumes no browser transport and makes no
 * model, prompt, expected-result, or diagnostic-scope decisions itself.
 *
 * The returned operationAuthorizer is a process-local capability. Keep it in
 * the trusted integration composition path; never accept it from workflow
 * JSON or an MCP caller. It binds the three task operations to this request,
 * exact observed controls, the staging profile, and their declared order.
 */
export function createCloudAgentTaskPlan({ profile, request, observation, mapping } = {}) {
  const { environmentId, agentOrigin } = validateProfile(profile);
  const task = validateTaskRequest(request, profile);
  if (!observation?.evidenceId || !observation?.targetId || !observation?.page?.url) throw new Error("A fresh, target-bound browser observation is required to compile the Cloud Agent task.");
  const observedOrigin = originOf(observation.page.url);
  if (observedOrigin !== agentOrigin) throw new Error("The observed browser page is not on the profile-declared Cloud Agent application origin.");

  const repositoryCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.REPOSITORY_SELECTOR,
    candidate => candidate.tag === "select" || String(candidate.role ?? "").toLowerCase() === "combobox");
  const refCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.REF_SELECTOR,
    candidate => candidate.tag === "select" || String(candidate.role ?? "").toLowerCase() === "combobox");
  const runtimeCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.RUNTIME_SELECTOR,
    candidate => candidate.tag === "select" || String(candidate.role ?? "").toLowerCase() === "combobox");
  const modelCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR,
    candidate => candidate.tag === "select" || String(candidate.role ?? "").toLowerCase() === "combobox");
  const promptCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.TASK_PROMPT,
    candidate => candidate.tag === "textarea"
      || (candidate.tag === "input" && (candidate.type === null || candidate.type === undefined || ["text", "search"].includes(String(candidate.type).toLowerCase())))
      || (candidate.contentEditable === true
        && ["textbox", "searchbox"].includes(String(candidate.role ?? "").toLowerCase())));
  const submitCandidate = resolveMappedCandidate(observation, mapping, CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK,
    candidate => ["button", "input"].includes(candidate.tag) && String(candidate.role ?? "").toLowerCase() === "button");
  const sameForm = promptCandidate.formIdentity && promptCandidate.formIdentity === submitCandidate.formIdentity;
  const semanticSubmitMapping = (mapping.semanticAnnotations ?? []).some(annotation =>
    annotation.semanticRole === CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK
      && annotation.resultCode === "mapped"
      && annotation.candidateRef === submitCandidate.identity
      && annotation.confidence >= SEMANTIC_MAPPING_CONFIDENCE_THRESHOLD);
  if (submitCandidate.submitsForm !== true && !semanticSubmitMapping) {
    throw new Error("A non-form task button requires a fresh high-confidence semantic mapping.");
  }
  if (!sameForm && !semanticSubmitMapping) {
    throw new Error("The task prompt and submit control require a shared observed form or a high-confidence fresh semantic mapping.");
  }
  for (const candidate of [repositoryCandidate, refCandidate, runtimeCandidate, modelCandidate, promptCandidate, submitCandidate]) {
    if (candidate.targetId !== observation.targetId) throw new Error("All Cloud Agent controls must belong to the exact observed browser target.");
  }

  const workflowId = `fi-cloud-agent-${createHash("sha256").update(task.requestId).digest("hex").slice(0, 16)}`;
  const workflow = {
    id: workflowId,
    name: "Caller-directed FreeInference Cloud Agent task",
    steps: [
      {
        id: "select-requested-repository",
        type: "interact",
        action: { type: "select", operationId: "freeinference.cloud_agent.select_repository", target: { identity: repositoryCandidate.identity }, value: task.repository.repositoryId, verifyValue: true }
      },
      {
        id: "select-requested-base-ref",
        type: "interact",
        action: { type: "select", operationId: "freeinference.cloud_agent.select_ref", target: { identity: refCandidate.identity }, value: task.repository.baseRef, verifyValue: true }
      },
      {
        id: "select-requested-runtime",
        type: "interact",
        action: { type: "select", operationId: "freeinference.cloud_agent.select_runtime", target: { identity: runtimeCandidate.identity }, value: task.runtimeId, verifyValue: true }
      },
      {
        id: "select-requested-model",
        type: "interact",
        action: {
          type: "select",
          operationId: OPERATION_IDS.selectModel,
          target: { identity: modelCandidate.identity },
          value: task.modelId,
          verifyValue: true
        }
      },
      {
        id: "enter-caller-task",
        type: "interact",
        action: {
          type: "fill",
          operationId: OPERATION_IDS.enterPrompt,
          target: { identity: promptCandidate.identity },
          value: task.prompt,
          verifyValue: true
        }
      },
      {
        id: "submit-authorized-test-task",
        type: "interact",
        action: {
          type: "click",
          operationId: OPERATION_IDS.submitTask,
          target: { identity: submitCandidate.identity }
        }
      }
    ]
  };
  const validation = validateWorkflow(workflow);
  if (!validation.valid) throw new Error(`Compiled Cloud Agent workflow is invalid: ${validation.errors.join(" ")}`);

  const expectedOperations = [
    { id: "freeinference.cloud_agent.select_repository", action: "select", identity: repositoryCandidate.identity, value: task.repository.repositoryId, targetRole: CLOUD_AGENT_TASK_ROLES.REPOSITORY_SELECTOR },
    { id: "freeinference.cloud_agent.select_ref", action: "select", identity: refCandidate.identity, value: task.repository.baseRef, targetRole: CLOUD_AGENT_TASK_ROLES.REF_SELECTOR },
    { id: "freeinference.cloud_agent.select_runtime", action: "select", identity: runtimeCandidate.identity, value: task.runtimeId, targetRole: CLOUD_AGENT_TASK_ROLES.RUNTIME_SELECTOR },
    { id: OPERATION_IDS.selectModel, action: "select", identity: modelCandidate.identity, value: task.modelId, targetRole: CLOUD_AGENT_TASK_ROLES.MODEL_SELECTOR },
    { id: OPERATION_IDS.enterPrompt, action: "fill", identity: promptCandidate.identity, value: task.prompt, targetRole: CLOUD_AGENT_TASK_ROLES.TASK_PROMPT },
    { id: OPERATION_IDS.submitTask, action: "click", identity: submitCandidate.identity, targetRole: CLOUD_AGENT_TASK_ROLES.SUBMIT_TASK }
  ];
  const semanticAnnotations = new Map((mapping.semanticAnnotations ?? []).map(annotation => [annotation.semanticRole, annotation]));
  const semanticEventIds = [...new Set(mapping.semanticEventIds ?? [])];
  let nextOperationIndex = 0;
  const operationAuthorizer = Object.freeze({
    decisionContext(operationId) {
      const operation = expectedOperations.find(item => item.id === operationId);
      if (!operation) return null;
      const annotation = semanticAnnotations.get(operation.targetRole);
      return Object.freeze({
        targetRole: operation.targetRole,
        operationClass: operation.id === OPERATION_IDS.submitTask ? "test_owned_mutation" : "unknown",
        reviewRequired: operation.id === OPERATION_IDS.submitTask,
        ...(semanticEventIds.length ? { semanticEventIds: Object.freeze(semanticEventIds) } : {}),
        ...(annotation ? {
          semanticAnnotation: Object.freeze({
            semanticRole: annotation.semanticRole,
            resultCode: annotation.resultCode,
            confidence: annotation.confidence
          })
        } : {})
      });
    },
    authorize({ operationId, action, candidate, value, observation: freshObservation, environment: binding } = {}) {
      const expected = expectedOperations[nextOperationIndex];
      if (!expected || operationId !== expected.id || action !== expected.action || candidate?.identity !== expected.identity) {
        return { allowed: false, reason: "Operation does not match the next step in the compiled Cloud Agent task." };
      }
      if (binding?.environmentId !== environmentId || freshObservation?.targetId !== observation.targetId || originOf(freshObservation?.page?.url) !== agentOrigin) {
        return { allowed: false, reason: "Cloud Agent operation target is not bound to the authorized staging environment." };
      }
      if (Object.hasOwn(expected, "value") && value !== expected.value) return { allowed: false, reason: "Operation input differs from the caller's exact typed task request." };
      if (action === "select" && candidate?.tag !== "select" && String(candidate?.role ?? "").toLowerCase() !== "combobox") {
        return { allowed: false, reason: "Cloud Agent job selection requires a freshly observed native selector or ARIA combobox." };
      }
      const editableText = candidate?.contentEditable === true
        && ["textbox", "searchbox"].includes(String(candidate?.role ?? "").toLowerCase());
      if (action === "fill" && !["input", "textarea"].includes(candidate?.tag) && !editableText) {
        return { allowed: false, reason: "Task entry requires a freshly observed text field or contenteditable textbox." };
      }
      if (action === "click" && !["button", "input"].includes(candidate?.tag)) {
        return { allowed: false, reason: "Task submission requires the mapped button control." };
      }
      return { allowed: true, category: "freeinference_cloud_agent_test_task" };
    },
    recordDispatch({ operationId, dispatchStatus } = {}) {
      const expected = expectedOperations[nextOperationIndex];
      if (!expected || operationId !== expected.id) throw new Error("Cloud Agent operation sequence changed during dispatch.");
      if (dispatchStatus !== "dispatched") return;
      nextOperationIndex++;
    }
  });

  return Object.freeze({
    workflow,
    operationAuthorizer,
    requestId: task.requestId,
    requestHash: task.requestHash,
    repository: task.repository,
    runtimeId: task.runtimeId,
    modelId: task.modelId,
    effectGrantId: task.effectGrantId,
    cleanupPolicyId: task.cleanupPolicyId,
    observationId: observation.evidenceId,
    expectedOutcome: task.expectedOutcome,
    diagnosticSources: task.diagnosticSources,
    verificationRequired: true,
    completionEvidence: Object.freeze({
      runIdentifierMustBeCapturedFrom: "fresh Cloud Agent UI evidence",
      backendCorrelationMustUseExactRunIdentifier: true,
      expectedOutcome: task.expectedOutcome,
      diagnosticSources: task.diagnosticSources
    })
  });
}
