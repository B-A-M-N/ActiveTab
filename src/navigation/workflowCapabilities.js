import { createHash } from "node:crypto";
import { executeExtractionCapability } from "../capabilities/recipeExecutor.js";
import { verifyExtractionResult } from "../extraction/extractionVerifier.js";
import { collectExtractionPages, extractionIdentityFingerprint, extractionPageCursorFingerprint } from "../extraction/collectionService.js";
import { OutputAccumulator } from "../extraction/outputAccumulator.js";
import { projectExtractionOutput } from "../extraction/outputRelease.js";
import { resolveObservedApplication, verifyObservedUrl } from "../environments/model.js";
import { classifyHumanHandoff } from "./handoff.js";
import { ACTION_VALUE_LIMITS } from "../browser/actionLimits.js";
import { isLowercaseCode } from "../telemetry/privacy.js";
import { isSearchFieldCandidate, SEARCH_SUBMIT_OPERATION_ID } from "./search.js";

/**
 * Capabilities available to every profile. These are intentionally limited
 * to following a visible link already present in fresh browser evidence.
 * Application profiles may register additional typed capabilities.
 */
function comparableRoute(value, base) {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href;
  } catch { return null; }
}

function visiblePageContext(observation) {
  const normalize = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const candidates = (observation?.candidates ?? [])
    .filter(candidate => candidate?.visible === true)
    .map(candidate => [candidate.role, candidate.tag, candidate.type, candidate.name, candidate.contextName]
      .map(normalize).join("\u001f"))
    .sort();
  const collections = (observation?.semanticPage?.collections ?? observation?.semanticPage?.data?.collections ?? [])
    .map(collection => JSON.stringify({
      kind: collection?.kind ?? "",
      records: (collection?.records ?? collection?.items ?? []).map(record =>
        (record?.fields ?? record ?? []).map?.(field => [field?.role ?? "", field?.value ?? field?.text ?? ""])
          ?? Object.values(record ?? {}).map(value => String(value ?? ""))
      )
    })).sort();
  return JSON.stringify({
    title: normalize(observation?.page?.title),
    headings: (observation?.headings ?? []).map(item => normalize(item?.text)).filter(Boolean),
    candidates,
    collections
  });
}

const SENSITIVE_FORM_LABEL = /pass(word|code)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf/i;
const SAFE_TEXT_INPUT_TYPES = new Set(["text", "email", "url", "tel", "search"]);

function hasSensitiveFormLabel(candidate) {
  return SENSITIVE_FORM_LABEL.test([
    candidate?.name,
    candidate?.label,
    candidate?.ariaLabel,
    candidate?.contextName,
    candidate?.type
  ].filter(value => typeof value === "string").join(" "));
}

function isSafeTextField(candidate) {
  if (!candidate || candidate.visible !== true || candidate.disabled !== false || candidate.readOnly === true
    || candidate.frameTargetId || candidate.submitsForm === true || hasSensitiveFormLabel(candidate)) return false;
  const tag = String(candidate.tag ?? "").toLowerCase();
  const role = String(candidate.role ?? "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") return SAFE_TEXT_INPUT_TYPES.has(String(candidate.type ?? "text").toLowerCase());
  return candidate.contentEditable === true && ["textbox", "searchbox"].includes(role);
}

function isSafeSelectable(candidate) {
  if (!candidate || candidate.visible !== true || candidate.disabled !== false || candidate.frameTargetId
    || candidate.submitsForm === true || hasSensitiveFormLabel(candidate)) return false;
  return String(candidate.tag ?? "").toLowerCase() === "select"
    || String(candidate.role ?? "").toLowerCase() === "combobox";
}

function isSafeCheckbox(candidate) {
  return candidate?.visible === true && candidate.disabled === false && candidate.readOnly !== true
    && candidate.frameTargetId == null && candidate.submitsForm !== true
    && String(candidate.tag ?? "").toLowerCase() === "input"
    && String(candidate.type ?? "").toLowerCase() === "checkbox"
    && !hasSensitiveFormLabel(candidate);
}

function isTrustedFilterButton(candidate) {
  return candidate?.visible === true && candidate.disabled === false && candidate.frameTargetId == null
    && candidate.submitsForm !== true
    && !hasSensitiveFormLabel(candidate)
    && (String(candidate.tag ?? "").toLowerCase() === "button" || String(candidate.role ?? "").toLowerCase() === "button")
    && /\b(?:apply|filter|show\s+results|update\s+results)\b/iu.test(candidate.name ?? "");
}

function sameApplicationTransition({ environment, applicationId, beforeObservation, afterObservation }) {
  const evidenceRefs = [beforeObservation?.evidenceId, afterObservation?.evidenceId];
  if (!evidenceRefs.every(value => typeof value === "string" && value) || evidenceRefs[0] === evidenceRefs[1]
    || beforeObservation?.targetId !== afterObservation?.targetId
    || !Number.isSafeInteger(beforeObservation?.documentGeneration)
    || beforeObservation.documentGeneration !== afterObservation?.documentGeneration
    || beforeObservation?.page?.url !== afterObservation?.page?.url) return null;
  const beforeApplication = applicationScope(environment, applicationId, beforeObservation);
  const afterApplication = applicationScope(environment, applicationId, afterObservation);
  if (!beforeApplication || !afterApplication || beforeApplication.authenticationRealm !== afterApplication.authenticationRealm) return null;
  return evidenceRefs;
}

function applicationScope(environment, applicationId, observation) {
  const url = observation?.page?.url;
  if (!url || !environment || !applicationId || !Array.isArray(environment.applications)) return null;
  if (!verifyObservedUrl(environment, url).ok) return null;
  const resolved = resolveObservedApplication(environment, url);
  return resolved.status === "matched" && resolved.applicationId === applicationId ? resolved : null;
}

function verifiedFormValue({ session, environment, applicationId, capabilityId, verificationCode, expectedCode,
  beforeObservation, afterObservation, target, inputValue, action, predicate }) {
  const evidenceRefs = [beforeObservation?.evidenceId, afterObservation?.evidenceId];
  if (verificationCode !== expectedCode) return { status: "uncertain", reasonCode: "verification_code_unsupported" };
  if (!evidenceRefs.every(value => typeof value === "string" && value.length > 0)
    || evidenceRefs[0] === evidenceRefs[1]
    || typeof target?.identity !== "string"
    || typeof inputValue !== "string"
    || inputValue.length > ACTION_VALUE_LIMITS[action]
    || !Number.isSafeInteger(beforeObservation?.documentGeneration)
    || beforeObservation.documentGeneration !== afterObservation?.documentGeneration
    || beforeObservation.targetId !== afterObservation?.targetId
    || target.targetId !== beforeObservation.targetId
    || target.documentGeneration !== beforeObservation.documentGeneration
    || beforeObservation.page?.url !== afterObservation?.page?.url) {
    return { status: "uncertain", reasonCode: "fresh_form_evidence_missing", evidenceRefs: evidenceRefs.filter(Boolean) };
  }

  const beforeTargets = (beforeObservation.candidates ?? []).filter(candidate => candidate.identity === target.identity);
  const afterTargets = (afterObservation.candidates ?? []).filter(candidate => candidate.identity === target.identity);
  if (beforeTargets.length !== 1 || afterTargets.length !== 1
    || beforeTargets[0].backendNodeId !== target.backendNodeId
    || afterTargets[0].backendNodeId !== target.backendNodeId
    || !predicate(beforeTargets[0]) || !predicate(afterTargets[0])) {
    return { status: "uncertain", reasonCode: "form_target_identity_changed", evidenceRefs };
  }
  const beforeApplication = applicationScope(environment, applicationId, beforeObservation);
  const afterApplication = applicationScope(environment, applicationId, afterObservation);
  if (!beforeApplication || !afterApplication
    || beforeApplication.authenticationRealm !== afterApplication.authenticationRealm) {
    return { status: "failed", reasonCode: "form_application_scope_changed", evidenceRefs };
  }

  return Promise.resolve(session.verifyControlValue(afterTargets[0], inputValue)).then(result => {
    if (result?.verified !== true) return { status: "uncertain", reasonCode: "form_value_verification_unavailable", evidenceRefs };
    if (result.matches !== true) return { status: "failed", reasonCode: "exact_form_value_not_observed", evidenceRefs };
    return {
      status: "verified",
      contractId: capabilityId,
      verifiedCode: expectedCode,
      verificationKind: "exact_form_value_observed",
      reasonCode: "exact_form_value_observed",
      valueLength: inputValue.length,
      targetId: target.targetId,
      applicationId,
      evidenceRefs
    };
  }, () => ({ status: "uncertain", reasonCode: "form_value_verification_unavailable", evidenceRefs }));
}

/**
 * Build standard field-editing capabilities for a trusted application adapter.
 * Each edit stays behind a profile-scoped operation authorizer; caller values
 * arrive only through WorkflowGraphPlanner inputRef bindings.
 */
export function createNativeFormWorkflowCapabilities({ session, getSession = null, environment, applicationId, operationIds } = {}) {
  if (operationIds == null) return [];
  if (!session || !environment || !applicationId || !operationIds || typeof operationIds !== "object" || Array.isArray(operationIds)) {
    throw new Error("Native form workflow capabilities require a session, environment, application ID, and operation IDs.");
  }
  if (Object.keys(operationIds).some(key => !["fill", "select", "toggle", "apply_filter"].includes(key))) {
    throw new Error("Native form operation IDs contain an unsupported operation.");
  }
  const currentSession = () => typeof getSession === "function" ? getSession() ?? session : session;

  const definitions = [
    {
      operation: "fill",
      id: "fill_observed_text_field",
      action: "fill",
      operationId: operationIds.fill,
      targetRole: "native_text_field",
      observedRoles: ["textbox", "searchbox"],
      observedTags: ["input", "textarea"],
      verificationCode: "exact_form_value_observed",
      purposeCode: "fill_form",
      preconditionCodes: ["authorized_application_scope", "visible_enabled_target"],
      postconditionCode: "exact_form_value_observed",
      predicate: isSafeTextField
    },
    {
      operation: "select",
      id: "select_observed_option",
      action: "select",
      operationId: operationIds.select,
      targetRole: "native_select_control",
      observedRoles: ["combobox"],
      observedTags: ["select"],
      verificationCode: "exact_selected_option_observed",
      purposeCode: "select_option",
      preconditionCodes: ["authorized_application_scope", "visible_enabled_target"],
      postconditionCode: "exact_selected_option_observed",
      predicate: isSafeSelectable
    },
    {
      operation: "toggle",
      id: "set_observed_checkbox_state",
      action: "toggle",
      operationId: operationIds.toggle,
      targetRole: "native_checkbox_filter",
      observedRoles: ["checkbox"],
      observedTags: ["input"],
      verificationCode: "exact_checkbox_state_observed",
      purposeCode: "set_filter_state",
      preconditionCodes: ["authorized_application_scope", "visible_enabled_target"],
      postconditionCode: "exact_checkbox_state_observed",
      predicate: isSafeCheckbox
    },
    {
      operation: "apply_filter",
      id: "apply_observed_filter",
      action: "click",
      operationId: operationIds.apply_filter,
      targetRole: "trusted_filter_apply_control",
      observedRoles: ["button"],
      observedTags: ["button"],
      verificationCode: "observed_filter_result_transition",
      purposeCode: "apply_filter",
      preconditionCodes: ["authorized_application_scope", "visible_enabled_target"],
      postconditionCode: "observed_filter_result_transition",
      predicate: isTrustedFilterButton
    }
  ];

  return definitions.filter(definition => definition.operationId !== undefined).map(definition => {
    if (!isLowercaseCode(definition.operationId, { maxLength: 96 })) {
      throw new Error(`Native form capability '${definition.id}' requires a trusted lowercase operation ID.`);
    }
    const validateTarget = (candidate, observation) => definition.predicate(candidate)
      && applicationScope(environment, applicationId, observation) !== null;
    return Object.freeze({
      id: definition.id,
      action: definition.action,
      effectClass: "shared_mutation",
      intentBinding: "caller_required",
      operationId: definition.operationId,
      requiresApproval: true,
      targetRole: definition.targetRole,
      purposeCodes: Object.freeze([definition.purposeCode]),
      preconditionCodes: Object.freeze(definition.preconditionCodes),
      postconditionCodes: Object.freeze([definition.postconditionCode]),
      observedRoles: Object.freeze(definition.observedRoles),
      observedTags: Object.freeze(definition.observedTags),
      verificationCodes: Object.freeze([definition.verificationCode]),
      validateTarget,
      resolveTarget(observation) {
        if (!applicationScope(environment, applicationId, observation)) return [];
        return (observation?.candidates ?? []).filter(definition.predicate).map(candidate => candidate.identity);
      },
      verify(args = {}) {
        if (definition.operation === "toggle") {
          const evidenceRefs = sameApplicationTransition({
            environment, applicationId,
            beforeObservation: args.beforeObservation,
            afterObservation: args.afterObservation
          });
          if (args.verificationCode !== definition.verificationCode || !evidenceRefs
            || !["checked", "unchecked"].includes(args.inputValue)) {
            return { status: "uncertain", reasonCode: "fresh_checkbox_state_evidence_missing", evidenceRefs: evidenceRefs ?? [] };
          }
          const fresh = (args.afterObservation.candidates ?? []).filter(candidate => candidate.identity === args.target?.identity);
          const activeSession = currentSession();
          if (fresh.length !== 1 || !definition.predicate(fresh[0])
            || typeof activeSession?.verifyCheckboxState !== "function") {
            return { status: "uncertain", reasonCode: "checkbox_state_verification_unavailable", evidenceRefs };
          }
          return Promise.resolve(activeSession.verifyCheckboxState(fresh[0], args.inputValue === "checked")).then(result => ({
            status: result?.verified === true && result.matches === true ? "verified" : result?.verified === true ? "failed" : "uncertain",
            contractId: definition.id,
            verifiedCode: definition.verificationCode,
            verificationKind: "exact_checkbox_state_observed",
            reasonCode: result?.verified === true && result.matches === true ? "exact_checkbox_state_observed" : "checkbox_state_mismatch",
            targetId: fresh[0].targetId,
            applicationId,
            evidenceRefs
          }), () => ({ status: "uncertain", reasonCode: "checkbox_state_verification_unavailable", evidenceRefs }));
        }
        if (definition.operation === "apply_filter") {
          const evidenceRefs = sameApplicationTransition({
            environment, applicationId,
            beforeObservation: args.beforeObservation,
            afterObservation: args.afterObservation
          });
          if (args.verificationCode !== definition.verificationCode || !evidenceRefs) {
            return { status: "uncertain", reasonCode: "fresh_filter_transition_evidence_missing", evidenceRefs: evidenceRefs ?? [] };
          }
          const beforeContext = visiblePageContext(args.beforeObservation);
          const afterContext = visiblePageContext(args.afterObservation);
          const targetPresent = (args.beforeObservation.candidates ?? []).filter(candidate => candidate.identity === args.target?.identity);
          if (targetPresent.length !== 1 || !definition.predicate(targetPresent[0]) || beforeContext === afterContext) {
            return { status: "uncertain", reasonCode: "filter_result_transition_not_observed", evidenceRefs };
          }
          return { status: "verified", contractId: definition.id, verifiedCode: definition.verificationCode,
            verificationKind: "visible_filter_result_transition", reasonCode: "visible_filter_result_transition",
            targetId: args.target.targetId, applicationId, evidenceRefs };
        }
        return verifiedFormValue({
          session: currentSession(),
          environment,
          applicationId,
          capabilityId: definition.id,
          verificationCode: args.verificationCode,
          expectedCode: definition.verificationCode,
          beforeObservation: args.beforeObservation,
          afterObservation: args.afterObservation,
          target: args.target,
          inputValue: args.inputValue,
          action: definition.action,
          predicate: definition.predicate
        });
      }
    });
  });
}

/** Build native form capabilities only from the exact verified application's profile declarations. */
export function createProfileFormWorkflowCapabilities({ session, getSession = null, environment, applicationId } = {}) {
  if (!environment || typeof applicationId !== "string" || !applicationId) return [];
  const applications = (environment.applications ?? []).filter(application => application?.applicationId === applicationId);
  if (applications.length !== 1) return [];
  const operationIds = applications[0].workflowOperations;
  if (!operationIds) return [];
  return createNativeFormWorkflowCapabilities({ session, getSession, environment, applicationId, operationIds });
}

export function createGenericWorkflowCapabilities({ environment = null } = {}) {
  return Object.freeze([Object.freeze({
    id: "follow_observed_link",
    action: "click",
    effectClass: "navigation",
    intentBinding: "generic_navigation",
    targetRole: "authorized_navigation_link",
    purposeCodes: Object.freeze(["navigate"]),
    preconditionCodes: Object.freeze(["observed_authorized_target"]),
    postconditionCodes: Object.freeze(["route_changed"]),
    observedRoles: Object.freeze(["link"]),
    observedTags: Object.freeze(["a"]),
    resolveTarget(observation) {
      return (observation?.candidates ?? [])
        .filter(candidate => candidate.visible === true && candidate.disabled !== true
          && (candidate.role === "link" || candidate.tag === "a"))
        .map(candidate => candidate.identity);
    },
    verificationCodes: Object.freeze(["authorized_route_changed"]),
    verify({ verificationCode, beforeObservation, afterObservation, target }) {
      if (verificationCode !== "authorized_route_changed") return { status: "uncertain", reasonCode: "verification_code_unsupported" };
      const evidenceRefs = [beforeObservation?.evidenceId, afterObservation?.evidenceId];
      if (!evidenceRefs.every(value => typeof value === "string" && value.length > 0)
        || evidenceRefs[0] === evidenceRefs[1]
        || !beforeObservation?.page?.url || !afterObservation?.page?.url
        || !target?.identity || typeof target?.href !== "string") {
        return { status: "uncertain", reasonCode: "fresh_route_evidence_missing" };
      }
      const targetId = target.targetId;
      const beforeGeneration = beforeObservation.documentGeneration;
      const targetGeneration = target.documentGeneration;
      const afterGeneration = afterObservation.documentGeneration;
      if (typeof targetId !== "string" || !targetId
        || beforeObservation.targetId !== targetId || afterObservation.targetId !== targetId
        || !Number.isSafeInteger(beforeGeneration) || targetGeneration !== beforeGeneration
        || !Number.isSafeInteger(afterGeneration) || afterGeneration < beforeGeneration) {
        return { status: "uncertain", reasonCode: "destination_target_or_generation_mismatch", evidenceRefs };
      }
      const freshTarget = (beforeObservation.candidates ?? []).filter(candidate => candidate.identity === target.identity);
      if (freshTarget.length !== 1 || freshTarget[0].href !== target.href
        || freshTarget[0].targetId !== targetId || freshTarget[0].documentGeneration !== beforeGeneration) {
        return { status: "uncertain", reasonCode: "target_not_bound_to_before_observation", evidenceRefs };
      }
      const expectedRoute = comparableRoute(target.href, beforeObservation.page.url);
      const beforeRoute = comparableRoute(beforeObservation.page.url, beforeObservation.page.url);
      const afterRoute = comparableRoute(afterObservation.page.url, beforeObservation.page.url);
      if (!expectedRoute || !beforeRoute || !afterRoute) return { status: "uncertain", reasonCode: "route_url_invalid", evidenceRefs };
      if (expectedRoute === beforeRoute) return { status: "failed", reasonCode: "expected_destination_not_new", evidenceRefs };
      if (afterRoute !== expectedRoute) return { status: "failed", reasonCode: "observed_destination_mismatch", evidenceRefs };
      if (visiblePageContext(beforeObservation) === visiblePageContext(afterObservation)) {
        return { status: "uncertain", reasonCode: "destination_content_not_observed", evidenceRefs };
      }
      if (!environment) return { status: "uncertain", reasonCode: "environment_binding_required", evidenceRefs };
      const expectedEnvironment = verifyObservedUrl(environment, expectedRoute);
      const observedEnvironment = verifyObservedUrl(environment, afterRoute);
      if (!expectedEnvironment.ok || !observedEnvironment.ok) return { status: "failed", reasonCode: "destination_outside_environment", evidenceRefs };
      if ((environment.applications ?? []).length > 0) {
        const expectedApplication = resolveObservedApplication(environment, expectedRoute);
        const observedApplication = resolveObservedApplication(environment, afterRoute);
        if (expectedApplication.status !== "matched" || observedApplication.status !== "matched"
          || expectedApplication.applicationId !== observedApplication.applicationId
          || expectedApplication.authenticationRealm !== observedApplication.authenticationRealm) {
          return { status: "failed", reasonCode: "destination_application_mismatch", evidenceRefs };
        }
      }
      if (classifyHumanHandoff(afterObservation)) return { status: "failed", reasonCode: "destination_requires_human_handoff", evidenceRefs };
      const errorPage = [afterObservation.page?.title, ...(afterObservation.headings ?? []).map(item => item.text)]
        .map(value => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim())
        .some(value => /^(?:404(?:\s|$)|not found$|page not found$|access denied$|forbidden$|internal server error$|service unavailable$|something went wrong$)/iu.test(value));
      const failedResponse = (afterObservation.networkSignals ?? []).some(signal => Number(signal?.status) >= 400);
      if (errorPage || failedResponse) return { status: "failed", reasonCode: "destination_error_observed", evidenceRefs };
      return {
        status: "verified",
        contractId: "follow_observed_link",
        verifiedCode: verificationCode,
        verificationKind: "destination_observed",
        expectedDestination: expectedRoute,
        observedDestination: afterRoute,
        targetId,
        reasonCode: "expected_destination_observed",
        evidenceRefs
      };
    }
  })]);
}

/**
 * Build a run-local pair for one explicit public search request. The only
 * admissible submitter is a unique, same-origin GET control in the exact form
 * that owns the unique observed search field. Query text stays in a private
 * caller input binding and capability closure; it is not part of the
 * capability or input-reference projection. Raw goal egress remains governed
 * by the separate workflow goal-text consent.
 */
export function createObservedSearchWorkflowCapabilities({ observation, session, getSession = null, inputRef, query } = {}) {
  if (!observation?.evidenceId || !observation?.targetId
    || !Number.isSafeInteger(observation?.documentGeneration)
    || session?.attached !== true || session.target?.id !== observation.targetId
    || session.documentGeneration !== observation.documentGeneration
    || !isLowercaseCode(inputRef, { maxLength: 64 })
    || typeof query !== "string" || !query.trim() || query.length > ACTION_VALUE_LIMITS.fill) return [];
  const currentSession = () => typeof getSession === "function" ? getSession() ?? session : session;

  let origin;
  try {
    const url = new URL(observation.page?.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
    origin = url.origin;
  } catch { return []; }

  const matchesBinding = (candidate, expected) => candidate?.identity === expected.identity
    && candidate?.backendNodeId === expected.backendNodeId
    && candidate?.targetId === observation.targetId
    && candidate?.documentGeneration === observation.documentGeneration
    && candidate?.formIdentity === expected.formIdentity
    && candidate?.formMethod === "get"
    && candidate?.formActionOrigin === origin
    && candidate?.formTargetSameContext === true
    && candidate?.frameTargetId == null;
  const fields = (observation.candidates ?? []).filter(candidate =>
    isSearchFieldCandidate(candidate, observation)
    && candidate.disabled === false
    && candidate.readOnly !== true
    && candidate.formIdentity
    && candidate.formMethod === "get"
    && candidate.formActionOrigin === origin
    && candidate.formTargetSameContext === true
    && candidate.targetId === observation.targetId
    && candidate.documentGeneration === observation.documentGeneration);
  if (fields.length !== 1) return [];
  const field = fields[0];
  const submitters = (observation.candidates ?? []).filter(candidate =>
    candidate.visible === true && candidate.disabled === false
    && candidate.submitsForm === true
    && candidate.formIdentity === field.formIdentity
    && candidate.formMethod === "get"
    && candidate.formActionOrigin === origin
    && candidate.formTargetSameContext === true
    && candidate.targetId === observation.targetId
    && candidate.documentGeneration === observation.documentGeneration
    && candidate.frameTargetId == null);
  if (submitters.length !== 1) return [];
  const submitter = submitters[0];
  let verifiedSearchSubmission = false;

  const exactField = candidate => matchesBinding(candidate, field)
    && isSearchFieldCandidate(candidate, { page: { url: observation.page.url } })
    && candidate.visible === true && candidate.disabled === false && candidate.readOnly !== true;
  const exactSubmitter = candidate => matchesBinding(candidate, submitter)
    && candidate.visible === true && candidate.disabled === false && candidate.submitsForm === true;
  const sameTargetObservation = (before, after) => Boolean(
    before?.evidenceId && after?.evidenceId && before.evidenceId !== after.evidenceId
      && before.targetId === observation.targetId && after.targetId === observation.targetId
      && after.targetId === currentSession()?.target?.id
      && Number.isSafeInteger(before.documentGeneration)
      && Number.isSafeInteger(after.documentGeneration)
      && after.documentGeneration === currentSession()?.documentGeneration
      && after.documentGeneration >= before.documentGeneration
      && after.page?.url
  );

  const fillCapability = Object.freeze({
    id: "observed_public_search_fill",
    action: "fill",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "public_search_field",
    requiredInputRef: inputRef,
    purposeCodes: Object.freeze(["search_records"]),
    preconditionCodes: Object.freeze(["unique_observed_same_origin_search_field"]),
    postconditionCodes: Object.freeze(["exact_search_query_observed"]),
    observedRoles: Object.freeze(["searchbox", "textbox"]),
    observedTags: Object.freeze(["input"]),
    verificationCodes: Object.freeze(["exact_search_query_observed"]),
    resolveTarget(current) {
      const matches = (current?.candidates ?? []).filter(exactField);
      return matches.length === 1 ? [matches[0].identity] : [];
    },
    validateTarget: exactField,
    async verify({ verificationCode, beforeObservation, afterObservation, target, inputValue } = {}) {
      const evidenceRefs = [beforeObservation?.evidenceId, afterObservation?.evidenceId];
      if (verificationCode !== "exact_search_query_observed") return { status: "uncertain", reasonCode: "verification_code_unsupported" };
      if (!sameTargetObservation(beforeObservation, afterObservation)
        || beforeObservation.page.url !== afterObservation.page.url
        || !exactField(target)
        || !(beforeObservation.candidates ?? []).some(candidate => exactField(candidate) && candidate.identity === target.identity)
        || !(afterObservation.candidates ?? []).some(candidate => exactField(candidate) && candidate.identity === target.identity)
        || inputValue !== query) return { status: "uncertain", reasonCode: "search_field_evidence_mismatch", evidenceRefs: evidenceRefs.filter(Boolean) };
      const result = await currentSession()?.verifyControlValue(target, query).catch(() => null);
      if (result?.verified !== true || result.matches !== true) return { status: result?.matches === false ? "failed" : "uncertain", reasonCode: "exact_search_query_not_observed", evidenceRefs };
      return { status: "verified", contractId: "observed_public_search_fill", verifiedCode: verificationCode,
        verificationKind: "exact_search_query_observed", reasonCode: "exact_search_query_observed", evidenceRefs,
        targetId: observation.targetId, valueLength: query.length };
    }
  });

  const submitCapability = Object.freeze({
    id: "observed_public_search_submit",
    action: "click",
    effectClass: "navigation",
    intentBinding: "caller_required",
    targetRole: "public_search_submit",
    operationId: SEARCH_SUBMIT_OPERATION_ID,
    purposeCodes: Object.freeze(["search_records"]),
    preconditionCodes: Object.freeze(["exact_caller_search_query_entered", "same_origin_get_form"]),
    postconditionCodes: Object.freeze(["search_results_observed"]),
    observedRoles: Object.freeze(["button"]),
    observedTags: Object.freeze(["button", "input"]),
    verificationCodes: Object.freeze(["search_results_observed"]),
    hasVerifiedSearchSubmission() { return verifiedSearchSubmission; },
    resolveTarget(current) {
      const matches = (current?.candidates ?? []).filter(exactSubmitter);
      return matches.length === 1 ? [matches[0].identity] : [];
    },
    validateTarget: exactSubmitter,
    async verify({ verificationCode, beforeObservation, afterObservation, target } = {}) {
      const evidenceRefs = [beforeObservation?.evidenceId, afterObservation?.evidenceId];
      verifiedSearchSubmission = false;
      if (verificationCode !== "search_results_observed") return { status: "uncertain", reasonCode: "verification_code_unsupported" };
      if (!sameTargetObservation(beforeObservation, afterObservation)
        || !(beforeObservation.candidates ?? []).some(candidate => exactSubmitter(candidate) && candidate.identity === target?.identity)) {
        return { status: "uncertain", reasonCode: "search_submit_evidence_mismatch", evidenceRefs: evidenceRefs.filter(Boolean) };
      }
      let beforeOrigin;
      let afterOrigin;
      try { beforeOrigin = new URL(beforeObservation.page.url).origin; afterOrigin = new URL(afterObservation.page.url).origin; }
      catch { return { status: "uncertain", reasonCode: "search_result_route_invalid", evidenceRefs }; }
      if (beforeOrigin !== origin || afterOrigin !== origin) return { status: "failed", reasonCode: "search_result_origin_changed", evidenceRefs };
      const routeChanged = beforeObservation.page.url !== afterObservation.page.url;
      const beforeContext = JSON.stringify([beforeObservation.page.title, beforeObservation.headings, (beforeObservation.candidates ?? []).map(candidate => [candidate.identity, candidate.name, candidate.contextName])]);
      const afterContext = JSON.stringify([afterObservation.page.title, afterObservation.headings, (afterObservation.candidates ?? []).map(candidate => [candidate.identity, candidate.name, candidate.contextName])]);
      if (!routeChanged && beforeContext === afterContext) return { status: "failed", reasonCode: "search_result_state_unchanged", evidenceRefs };
      const verified = await currentSession()?.verifySearchOutcome(query).catch(() => false);
      if (!verified) return { status: "failed", reasonCode: "search_results_not_verified", evidenceRefs };
      verifiedSearchSubmission = true;
      return { status: "verified", contractId: "observed_public_search_submit", verifiedCode: verificationCode,
        verificationKind: "search_results_observed", reasonCode: "search_results_observed", evidenceRefs,
        targetId: observation.targetId };
    }
  });
  return Object.freeze([fillCapability, submitCapability]);
}

/**
 * Build model-visible handles for qualified, exact-scope registered reads.
 * The handles retain the registry and policy callbacks locally; neither the
 * model nor a synthesized plan can supply execution code or scope.
 */
export function createExtractionWorkflowCapabilities({
  registry,
  session,
  getSession = null,
  environment,
  principalId = null,
  authorizeField = null,
  authorizeRelease = null,
  assertExecutionLease = null,
  advancePage = null,
  resumeCheckpoint = null,
  persistCheckpoint = null
} = {}) {
  if (!registry || typeof registry.list !== "function" || !session || !environment) return [];
  const environmentId = environment.environmentId ?? environment.id ?? null;
  if (!environmentId || !Array.isArray(environment.authorizedOrigins) || !Array.isArray(environment.applications)) return [];
  const currentSession = () => typeof getSession === "function" ? getSession() ?? session : session;
  const authorizedOrigins = new Set(environment.authorizedOrigins.map(origin => {
    try { return new URL(origin).origin; } catch { return null; }
  }).filter(Boolean));
  const eligible = registry.list().filter(manifest => {
    const origin = (() => { try { return new URL(manifest.origin).origin; } catch { return null; } })();
    const resolvedApplication = origin
      ? resolveObservedApplication(environment, new URL(manifest.pagePath, origin).href)
      : { status: "unmatched" };
    const contract = manifest.extractionContract;
    const supportedCompletion = contract?.completionPolicy === "exact_count"
      ? contract.pagination === undefined
      : contract?.completionPolicy === "pagination_exhausted"
        && new Set(["rel_next_same_path", "explicit_next_same_path", "page_number_query", "virtualized_list"]).has(contract.pagination?.kind)
        && typeof advancePage === "function";
    return manifest.kind
      && manifest.environmentId === environmentId
      && manifest.principalId === principalId
      && origin
      && authorizedOrigins.has(origin)
      && resolvedApplication.status === "matched"
      && resolvedApplication.applicationId === manifest.applicationId
      && supportedCompletion;
  });
  const idCounts = new Map();
  for (const manifest of eligible) idCounts.set(manifest.capabilityId, (idCounts.get(manifest.capabilityId) ?? 0) + 1);
  return eligible.filter(manifest => idCounts.get(manifest.capabilityId) === 1).map(manifest => Object.freeze({
    id: manifest.capabilityId,
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "registered_structured_records",
    purposeCodes: Object.freeze(["extract_records"]),
    preconditionCodes: Object.freeze(["qualified_capability_scope"]),
    postconditionCodes: Object.freeze(["complete_extraction_verified"]),
    observedRoles: Object.freeze([]),
    observedTags: Object.freeze([]),
    verificationCodes: Object.freeze(["complete_extraction_verified"]),
    outputSchema: Object.freeze(manifest.extractionContract.fields.map(field => Object.freeze({
      name: field.name,
      type: field.type,
      required: field.required === true
    }))),
    async execute({ signal } = {}) {
      if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_before_extraction" };
      const activeSession = currentSession();
      if (activeSession?.attached !== true || !activeSession.target?.id) return { status: "blocked", reasonCode: "authorized_target_unavailable" };
      try { await assertExecutionLease?.(); }
      catch { return { status: "blocked", reasonCode: "target_lease_unavailable" }; }
      const checkpoint = resumeCheckpoint?.capabilityId === manifest.capabilityId ? resumeCheckpoint : null;
      const contractFingerprint = createHash("sha256").update(JSON.stringify(manifest.extractionContract)).digest("hex");
      const fieldPolicyFingerprint = createHash("sha256").update(JSON.stringify(manifest.extractionContract.fields)).digest("hex");
      const releaseScope = {
        origin: manifest.origin,
        pagePath: manifest.pagePath,
        environmentId: manifest.environmentId,
        applicationId: manifest.applicationId
      };
      const releasePolicyFingerprint = createHash("sha256").update(JSON.stringify(manifest.extractionContract.fields.map(field => ({
        name: field.name,
        allowed: field.dataClass !== "credential" && (typeof authorizeRelease === "function"
          ? authorizeRelease(Object.freeze({ name: field.name, ...field, ...releaseScope }), { principalId, capabilityId: manifest.capabilityId }) === true
          : field.dataClass === "public")
      })))).digest("hex");
      let collection;
      try {
        let accumulator = null;
        let initialPageIdentityFingerprints = [];
        let initialCursorFingerprint = null;
        let initialDuplicateRecordCount = 0;
        let allowTerminalDuplicatePage = false;
        if (checkpoint) {
          const fields = manifest.extractionContract.fields.map(field => field.name);
          if (checkpoint.capabilityVersion !== manifest.capabilityVersion
            || checkpoint.contractFingerprint !== contractFingerprint
            || checkpoint.fieldPolicyFingerprint !== fieldPolicyFingerprint
            || checkpoint.releasePolicyFingerprint !== releasePolicyFingerprint
            || checkpoint.pageIdentityFingerprints?.length !== checkpoint.pageCount
            || checkpoint.output?.release?.status === "partial"
            || JSON.stringify(Object.keys(checkpoint.output?.schema?.items ?? {}).sort()) !== JSON.stringify([...fields].sort())
            || checkpoint.output?.scope?.origin !== manifest.origin
            || checkpoint.output?.scope?.pagePath !== manifest.pagePath
            || checkpoint.output?.scope?.environmentId !== manifest.environmentId
            || checkpoint.output?.scope?.applicationId !== manifest.applicationId) {
            return { status: "failed", reasonCode: "collection_checkpoint_binding_changed" };
          }
          const currentSessionForCheckpoint = currentSession();
          const current = await currentSessionForCheckpoint.observe().catch(() => null);
          if (!current?.page?.url || current.targetId !== currentSessionForCheckpoint.target.id
            || current.documentGeneration !== currentSessionForCheckpoint.documentGeneration) {
            return { status: "uncertain", reasonCode: "collection_checkpoint_observation_unavailable" };
          }
          const currentCursorFingerprint = extractionPageCursorFingerprint(current.page.url);
          const atLastPage = currentCursorFingerprint === checkpoint.cursorFingerprint;
          const atExpectedNextPage = currentCursorFingerprint === checkpoint.nextCursorFingerprint;
          if (!atLastPage && !atExpectedNextPage) return { status: "blocked", reasonCode: "collection_checkpoint_page_mismatch" };
          if (atLastPage) {
            const lastPage = await executeExtractionCapability({
              capabilityId: manifest.capabilityId, capabilityVersion: manifest.capabilityVersion,
              registry, session: currentSession(), environment, principalId, authorizeField
            });
            if (lastPage.status !== "available"
              || extractionIdentityFingerprint(lastPage.pageIdentity) !== checkpoint.pageIdentityFingerprints.at(-1)) {
              return { status: "blocked", reasonCode: "collection_checkpoint_source_changed" };
            }
            if (lastPage.nextPage?.status === "available") {
              if (typeof advancePage !== "function") return { status: "blocked", reasonCode: "authorized_pagination_executor_unavailable" };
              const advanced = await advancePage({
                url: lastPage.nextPage.url,
                fromPageUrl: lastPage.observation.page.url,
                nextPage: lastPage.nextPage,
                pageNumber: checkpoint.pageCount + 1,
                sourceObservationId: lastPage.observation.evidenceId,
                capabilityId: manifest.capabilityId,
                capabilityVersion: manifest.capabilityVersion,
                signal
              }).catch(() => ({ status: "uncertain", reasonCode: "pagination_navigation_result_unknown" }));
              if (!new Set(["verified", "PASS"]).has(advanced?.status)) return advanced;
            } else if (lastPage.nextPage?.status === "not_found" && checkpoint.nextPageStatus === "not_found") {
              allowTerminalDuplicatePage = true;
            } else return { status: "blocked", reasonCode: "collection_checkpoint_cursor_unavailable" };
          }
          accumulator = new OutputAccumulator();
          accumulator.restore(manifest.capabilityId, `${manifest.capabilityId}@${manifest.capabilityVersion}`, checkpoint.output, checkpoint.pageEvidence);
          initialPageIdentityFingerprints = checkpoint.pageIdentityFingerprints;
          initialCursorFingerprint = checkpoint.cursorFingerprint;
          initialDuplicateRecordCount = checkpoint.duplicateRecordCount ?? 0;
        }
        collection = await collectExtractionPages({
          outputName: manifest.capabilityId,
          capabilityId: manifest.capabilityId,
          capabilityVersion: manifest.capabilityVersion,
          ...(accumulator ? { accumulator } : {}),
          initialPageIdentityFingerprints,
          initialCursorFingerprint,
          initialDuplicateRecordCount,
          allowTerminalDuplicatePage,
          maxPages: manifest.extractionContract.pagination?.maxPages ?? 1,
          executePage: () => executeExtractionCapability({
            capabilityId: manifest.capabilityId,
            capabilityVersion: manifest.capabilityVersion,
            registry,
            session: currentSession(),
            environment,
            principalId,
            authorizeField
          }),
          advancePage: typeof advancePage === "function" ? details => advancePage({ ...details, signal }) : null,
          onPageCollected: async page => {
            if (typeof persistCheckpoint !== "function" || !page.contract?.pagination
              || page.contract.pagination.kind === "virtualized_list"
              || !new Set(["available", "not_found"]).has(page.nextPageStatus)
              || (page.nextPageStatus === "available" && !page.nextCursorFingerprint)
              || !page.output || page.output.completeness !== "incomplete") return;
            const released = projectExtractionOutput(page.output, authorizeRelease, { principalId, capabilityId: manifest.capabilityId });
            if (released.release?.status === "partial"
              || JSON.stringify(Object.keys(released.schema?.items ?? {}).sort()) !== JSON.stringify(manifest.extractionContract.fields.map(field => field.name).sort())) return;
            await persistCheckpoint({
              capabilityId: manifest.capabilityId,
              capabilityVersion: manifest.capabilityVersion,
              contractFingerprint,
              fieldPolicyFingerprint,
              releasePolicyFingerprint,
              sourceObservationRef: createHash("sha256").update(page.observationId).digest("hex"),
              pageIdentityFingerprints: page.pageIdentityFingerprints,
              cursorFingerprint: page.cursorFingerprint,
              duplicateRecordCount: page.cumulativeDuplicateRecordCount,
              nextCursorFingerprint: page.nextCursorFingerprint,
              nextPageStatus: page.nextPageStatus,
              terminalEvidence: page.terminalEvidence,
              pageCount: page.pageCount,
              pageEvidence: page.pageEvidence,
              output: released
            });
          },
          signal
        });
      } catch {
        return { status: "uncertain", reasonCode: "extraction_execution_failed" };
      }
      if (collection.status !== "complete") return {
        status: collection.status === "blocked" ? "blocked" : collection.status === "uncertain" ? "uncertain" : "failed",
        reasonCode: collection.reasonCode ?? "extraction_unavailable",
        evidenceRefs: collection.output?.verification?.evidenceIds ?? []
      };
      if (signal?.aborted) return { status: "uncertain", reasonCode: "canceled_after_extraction" };
      const output = collection.output;
      const released = projectExtractionOutput(output, authorizeRelease, { principalId, capabilityId: manifest.capabilityId });
      const verification = verifyExtractionResult(released);
      if (verification.status !== "complete") return {
        status: "failed",
        reasonCode: released.release?.status === "partial" ? "extraction_release_incomplete" : "extraction_verification_failed",
        evidenceRefs: released.verification?.evidenceIds ?? []
      };
      return {
        status: "verified",
        output: released,
        evidenceRefs: released.verification.evidenceIds
      };
    }
  }));
}
