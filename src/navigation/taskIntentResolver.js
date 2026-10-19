import { searchReadRequestFromGoal } from "./search.js";
import { hasSupportedLocalTransformationShape, parseVisibleRecordTransformation } from "../extraction/recordTransformations.js";

const NAVIGATION_REQUEST = /\b(?:navigate\s+to|go\s+to|open|visit|follow|browse\s+to)\b/iu;
const NON_NAVIGATION_INTENT = /\b(?:and\s+(?:then\s+)?(?:extract|read|collect|scrape|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|filter|search|fill|select|configure|approve)|(?:extract|collect|scrape|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|filter|search|fill|select|configure|approve))\b/iu;
const MULTI_PART_REQUEST = /\b(?:and then|then|after that|and also)\b/iu;
const EXPLICIT_READ_REQUEST = /\b(?:extract|read|collect|retrieve|summari[sz]e|compare|scrape)\b/iu;
const DATA_REQUEST_VERB = /\b(?:return|list|show|get|find|tell\s+me|give\s+me|what\s+(?:is|are)|which|look\s+up)\b/iu;
const DATA_OUTPUT_FIELD = /\b(?:names?|prices?|costs?|titles?|dates?|values?|results?|records?|rows?|products?|items?|alerts?|authors?|ratings?|reviews?|addresses?|emails?|locations?|scores?|counts?|statuses?|descriptions?|summaries?|details?)\b/iu;
const OBSERVED_CONTROL_REQUEST = /\b(?:navigate|go\s+to|open|visit|follow|browse|search|filter|click|select|fill|enter|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|configure|approve|toggle|scroll)\b/iu;
const FOLLOWING_ACTION = /\b(?:and(?:\s+then)?|then|after\s+that|and\s+also)\s+(?:navigate\s+to|go\s+to|open|visit|follow|browse(?:\s+to)?|search(?:\s+(?:for|within|the|this|current))?|filter(?:\s+(?:by|to|the|this))?|sort(?:\s+by)?|click|select|fill|enter|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|configure|approve|toggle|scroll)\b/iu;
const COMPOSITE_READ_ACTION = /\b(?:navigate\s+to|go\s+to|open|visit|follow|browse(?:\s+to)?|search\s+(?:for|within|the|this|current)|filter\s+(?:by|to|the|this)|sort(?:\s+by)?|select|click|fill|enter|toggle|scroll)\b/iu;
const UNSUPPORTED_READ_OPERATION = /\b(?:search\s+(?:for|within|the|this|current)|filter\s+(?:by|to|the|this)|sort(?:\s+by)?|cheapest|lowest|highest|top\s+\d+|rank(?:ed|ing)?|compare|summari[sz](?:e|ed|ing)|average|aggregate|total)\b/iu;

/** A read request needs a complete read contract; one navigation action cannot satisfy it. */
export function isExplicitReadWorkflowRequest(goal) {
  if (typeof goal !== "string" || goal.length > 4096) return false;
  if (EXPLICIT_READ_REQUEST.test(goal)) return true;
  const requestVerb = DATA_REQUEST_VERB.exec(goal);
  const outputField = DATA_OUTPUT_FIELD.exec(goal);
  return Boolean(requestVerb && outputField && outputField.index >= requestVerb.index + requestVerb[0].length);
}

/** True when a read request names browser work beyond the currently observed page. */
export function requiresCompositeReadWorkflow(goal) {
  return typeof goal === "string" && goal.length <= 4096 && isExplicitReadWorkflowRequest(goal)
    && (COMPOSITE_READ_ACTION.test(goal) || MULTI_PART_REQUEST.test(goal));
}

/** Read post-processing and interactive operations need a trusted operation contract. */
export function requiresUnsupportedReadOperation(goal) {
  if (typeof goal !== "string" || goal.length > 4096 || !isExplicitReadWorkflowRequest(goal)) return false;
  if (!hasSupportedLocalTransformationShape(goal)) return UNSUPPORTED_READ_OPERATION.test(goal);
  const recognized = goal.replace(/\b(?:cheapest|lowest[- ]priced|least expensive|most expensive|highest[- ]priced|priciest|under|below|less than|cheaper than|at most|how many|count|only|just|visible|shown|on this page|currently displayed)\b/giu, " ");
  return UNSUPPORTED_READ_OPERATION.test(recognized);
}

/**
 * Classify only the first observation need. This is not an intent grant or an
 * executable task contract; final capability binding still follows fresh
 * observation and trusted capability discovery.
 */
export function classifyTaskRequest(goal, { suppliedIntent = null } = {}) {
  const explicitRead = isExplicitReadWorkflowRequest(goal);
  const needsObservedControl = suppliedIntent !== null && suppliedIntent !== undefined
    || typeof goal !== "string"
    || goal.length > 4096
    || OBSERVED_CONTROL_REQUEST.test(goal);
  const observationProfile = explicitRead && !needsObservedControl ? "structural" : "interaction";
  const validGoal = typeof goal === "string" && goal.length <= 4096;
  const compoundRequest = validGoal && !explicitRead && FOLLOWING_ACTION.test(goal);
  const requiredCapabilityIds = Array.isArray(suppliedIntent?.requiredCapabilityIds)
    ? [...new Set(suppliedIntent.requiredCapabilityIds.filter(id => typeof id === "string"))]
    : [];
  const completeTypedIntent = suppliedIntent !== null && typeof suppliedIntent === "object"
    && !Array.isArray(suppliedIntent)
    && typeof suppliedIntent.purposeCode === "string" && suppliedIntent.purposeCode.length > 0
    && typeof suppliedIntent.outcomeCode === "string" && suppliedIntent.outcomeCode.length > 0
    && (suppliedIntent.cardinality === undefined || ["atomic", "compound", "unknown"].includes(suppliedIntent.cardinality));
  const genericAtomicNavigation = completeTypedIntent
    && suppliedIntent?.purposeCode === "navigate"
    && suppliedIntent?.outcomeCode === "route_changed"
    && suppliedIntent?.cardinality === "atomic"
    && requiredCapabilityIds.length === 0;
  const typedWorkflowIntent = completeTypedIntent && !genericAtomicNavigation;
  return Object.freeze({
    status: suppliedIntent !== null && suppliedIntent !== undefined ? "caller_typed" : explicitRead ? "read_candidate" : "unresolved",
    observationProfile,
    requiresCandidateDiscovery: observationProfile === "interaction",
    requiresSemanticCompilation: observationProfile !== "lightweight",
    explicitReadRequest: explicitRead,
    compoundRequest,
    typedWorkflowIntent,
    requiredCapabilityIds: Object.freeze(requiredCapabilityIds)
  });
}

/**
 * Select existing execution machinery after fresh observation and trusted
 * capability construction. This is a routing decision only: the workflow
 * planner and authorized executor still enforce capability scope and policy.
 */
export function selectTaskExecutionRoute({
  requestedPlannerMode = "auto",
  classifiedTask = {},
  trustedCapabilities = [],
  taskResolution = null
} = {}) {
  if (requestedPlannerMode === "workflow") return Object.freeze({ kind: "workflow", reasonCode: "explicit_workflow_mode" });
  if (requestedPlannerMode === "deterministic") return Object.freeze({ kind: "direct_navigation", reasonCode: "explicit_deterministic_mode" });
  if (requestedPlannerMode === "model") return Object.freeze({ kind: "semantic_navigation", reasonCode: "explicit_model_mode" });
  if (requestedPlannerMode !== "auto") return Object.freeze({ kind: "unresolved", reasonCode: "unsupported_planner_mode" });

  const capabilities = Array.isArray(trustedCapabilities) ? trustedCapabilities : [];
  const capabilityIds = new Set(capabilities.map(capability => capability?.id).filter(id => typeof id === "string"));
  const missingRequestedIds = (classifiedTask.requiredCapabilityIds ?? []).filter(id => !capabilityIds.has(id));
  if (missingRequestedIds.length) {
    return Object.freeze({ kind: "unresolved", reasonCode: "requested_workflow_capability_unavailable" });
  }

  if (classifiedTask.explicitReadRequest) {
    if (["read_requires_unsupported_operation", "search_read_requires_unsupported_operation"].includes(taskResolution?.reasonCode)) {
      return Object.freeze({ kind: "unresolved", reasonCode: taskResolution.reasonCode });
    }
    const trustedReadAvailable = capabilities.some(capability => capability?.action === "extract"
      && capability?.effectClass === "read"
      && Array.isArray(capability?.outputSchema)
      && capability.outputSchema.length > 0
      && Array.isArray(capability?.postconditionCodes)
      && capability.postconditionCodes.length > 0
      && Array.isArray(capability?.verificationCodes)
      && capability.verificationCodes.length > 0);
    if (taskResolution?.status === "resolved"
      || taskResolution?.reasonCode === "composite_read_requires_workflow_synthesis"
      || trustedReadAvailable) {
      return Object.freeze({ kind: "workflow", reasonCode: "guarded_read_workflow" });
    }
    return Object.freeze({ kind: "unresolved", reasonCode: taskResolution?.reasonCode ?? "read_capability_unavailable" });
  }

  if (classifiedTask.typedWorkflowIntent) {
    return taskResolution?.status === "resolved"
      ? Object.freeze({ kind: "workflow", reasonCode: "caller_typed_workflow" })
      : Object.freeze({ kind: "unresolved", reasonCode: taskResolution?.reasonCode ?? "typed_workflow_unresolved" });
  }

  if (classifiedTask.compoundRequest) {
    return capabilities.length
      ? Object.freeze({ kind: "workflow", reasonCode: "compound_task_requires_complete_plan" })
      : Object.freeze({ kind: "unresolved", reasonCode: "compound_task_capabilities_unavailable" });
  }

  return Object.freeze({ kind: "direct_navigation", reasonCode: "ordinary_auto_navigation" });
}

/**
 * Resolve only task contracts that can be established from trusted capability
 * metadata and an explicit, bounded request shape. This resolver never grants
 * capabilities or infers an application effect.
 */
export function resolveTaskIntent({ goal, suppliedIntent = null, capabilities = [], observedReadCapabilityIds = [], searchCapabilityIds = [] } = {}) {
  const searchReadRequest = isExplicitReadWorkflowRequest(goal) ? searchReadRequestFromGoal(goal) : null;
  if (searchReadRequest) {
    const forbiddenReadOperation = /\b(?:filter|sort|rank|cheapest|lowest|highest|top\s+\d+|compare|summari[sz]e|average|aggregate|total|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|configure|approve|fill|select|toggle|create|edit|cancel|book|order|transfer|invite|share|post|comment|message)\b/iu;
    if (forbiddenReadOperation.test(searchReadRequest.resultRequest)) {
      return Object.freeze({ status: "unresolved", reasonCode: "search_read_requires_unsupported_operation" });
    }
    const capabilityList = Array.isArray(capabilities) ? capabilities : [];
    const searchIds = Array.isArray(searchCapabilityIds) ? [...new Set(searchCapabilityIds)] : [];
    const searchCapabilities = capabilityList.filter(capability => searchIds.includes(capability?.id));
    const searchInputRefs = searchCapabilities.map(capability => capability?.requiredInputRef).filter(Boolean);
    const searchPairValid = searchIds.length === 2 && searchCapabilities.length === 2
      && searchInputRefs.length === 1
      && /^[a-z][a-z0-9_]{0,63}$/u.test(searchInputRefs[0])
      && searchCapabilities.some(capability => capability.action === "fill"
        && capability.effectClass === "read" && capability.targetRole === "public_search_field"
        && capability.requiredInputRef === searchInputRefs[0] && capability.purposeCodes?.length === 1
        && capability.purposeCodes[0] === "search_records")
      && searchCapabilities.some(capability => capability.action === "click"
        && capability.effectClass === "navigation" && capability.targetRole === "public_search_submit"
        && capability.purposeCodes?.length === 1 && capability.purposeCodes[0] === "search_records");
    const readIds = new Set(observedReadCapabilityIds);
    const readCapabilities = capabilityList.filter(capability => readIds.has(capability?.id)
      && capability?.action === "extract" && capability?.effectClass === "read"
      && capability?.targetRole === "observed_records"
      && capability?.purposeCodes?.length === 1 && capability.purposeCodes[0] === "extract_records"
      && capability?.postconditionCodes?.length === 1 && capability.postconditionCodes[0] === "observed_records_returned"
      && Array.isArray(capability.outputSchema) && capability.outputSchema.length > 0);
    if (!searchPairValid || readCapabilities.length !== 1) {
      return Object.freeze({ status: "unresolved", reasonCode: "search_read_capability_unavailable" });
    }
    const capability = readCapabilities[0];
    const requiredCapabilityIds = Object.freeze([...searchIds, capability.id]);
    const permittedPurposeCodes = Object.freeze(["search_records", "extract_records"]);
    const inferredIntent = Object.freeze({
      purposeCode: "extract_records",
      outcomeCode: "observed_records_returned",
      cardinality: "compound",
      permittedPurposeCodes,
      targetRoles: Object.freeze(["public_search_field", "public_search_submit", "observed_records"]),
      constraints: Object.freeze(["observed_partial"]),
      requiredCapabilityIds
    });
    if (suppliedIntent !== null && suppliedIntent !== undefined) {
      const suppliedIds = new Set(suppliedIntent.requiredCapabilityIds ?? []);
      if (suppliedIntent.purposeCode !== inferredIntent.purposeCode
        || suppliedIntent.outcomeCode !== inferredIntent.outcomeCode
        || requiredCapabilityIds.some(id => !suppliedIds.has(id))) {
        return Object.freeze({ status: "unresolved", reasonCode: "caller_intent_omits_required_search_read_capability" });
      }
      return Object.freeze({ status: "resolved", source: "caller_typed", intent: suppliedIntent });
    }
    return Object.freeze({ status: "resolved", source: "trusted_same_origin_search_and_read", intent: inferredIntent });
  }
  if (suppliedIntent !== null && suppliedIntent !== undefined) {
    return Object.freeze({ status: "resolved", source: "caller_typed", intent: suppliedIntent });
  }
  if (isExplicitReadWorkflowRequest(goal)) {
    if (requiresUnsupportedReadOperation(goal)) {
      return Object.freeze({ status: "unresolved", reasonCode: "read_requires_unsupported_operation" });
    }
    const observedReadIds = new Set(observedReadCapabilityIds);
    const observedReads = (Array.isArray(capabilities) ? capabilities : []).filter(capability =>
      observedReadIds.has(capability?.id)
      && capability?.action === "extract"
      && capability?.effectClass === "read"
      && capability?.targetRole === "observed_records"
      && capability?.purposeCodes?.length === 1
      && capability.purposeCodes[0] === "extract_records"
      && capability?.postconditionCodes?.length === 1
      && capability.postconditionCodes[0] === "observed_records_returned"
      && Array.isArray(capability.outputSchema)
      && capability.outputSchema.length > 0
    );
    if (hasSupportedLocalTransformationShape(goal)) {
      if (requiresCompositeReadWorkflow(goal) || observedReads.length !== 1) {
        return Object.freeze({ status: "unresolved", reasonCode: observedReads.length > 1
          ? "observed_read_source_ambiguous" : "local_transform_requires_one_visible_read" });
      }
      const capability = observedReads[0];
      const schema = Object.fromEntries(capability.outputSchema.map(field => [field.name, field]));
      const transformation = parseVisibleRecordTransformation(goal, schema);
      if (transformation?.status !== "resolved") {
        return Object.freeze({ status: "unresolved", reasonCode: transformation?.reasonCode ?? "local_transform_unavailable" });
      }
      return Object.freeze({
        status: "resolved",
        source: "deterministic_visible_record_transformation",
        intent: Object.freeze({
          purposeCode: "extract_records",
          outcomeCode: "observed_records_returned",
          cardinality: "atomic",
          permittedPurposeCodes: Object.freeze(["extract_records"]),
          targetRoles: Object.freeze(["observed_records"]),
          constraints: Object.freeze(["observed_partial"]),
          requiredCapabilityIds: Object.freeze([capability.id]),
          localTransform: transformation.plan
        })
      });
    }
    // A read capability discovered on the current page proves only that a
    // current-page extraction can be attempted. It must not collapse a goal
    // that also asks us to navigate, search, filter, sort, or operate controls
    // into an atomic read that can silently miss the requested workflow.
    const compositeRead = requiresCompositeReadWorkflow(goal);
    if (observedReads.length === 1 && !compositeRead) {
      const capability = observedReads[0];
      return Object.freeze({
        status: "resolved",
        source: "trusted_ephemeral_observed_read",
        intent: Object.freeze({
          purposeCode: "extract_records",
          outcomeCode: "observed_records_returned",
          cardinality: "atomic",
          permittedPurposeCodes: Object.freeze(["extract_records"]),
          targetRoles: Object.freeze(["observed_records"]),
          constraints: Object.freeze(["observed_partial"]),
          requiredCapabilityIds: Object.freeze([capability.id])
        })
      });
    }
    if (observedReads.length > 1 && !compositeRead) {
      return Object.freeze({ status: "unresolved", reasonCode: "observed_read_source_ambiguous" });
    }
    if (compositeRead) {
      return Object.freeze({ status: "unresolved", reasonCode: "composite_read_requires_workflow_synthesis" });
    }
  }
  if (typeof goal !== "string" || goal.length > 4096 || !NAVIGATION_REQUEST.test(goal)
    || NON_NAVIGATION_INTENT.test(goal) || MULTI_PART_REQUEST.test(goal)) {
    return Object.freeze({ status: "unresolved", reasonCode: "task_intent_requires_typed_contract" });
  }
  const genericNavigation = (Array.isArray(capabilities) ? capabilities : []).filter(capability =>
    capability?.intentBinding === "generic_navigation"
    && capability?.action === "click"
    && capability?.effectClass === "navigation"
    && Array.isArray(capability?.purposeCodes)
    && Array.isArray(capability?.postconditionCodes)
    && capability.purposeCodes.includes("navigate")
    && capability.postconditionCodes.includes("route_changed")
  );
  if (genericNavigation.length !== 1) {
    return Object.freeze({ status: "unresolved", reasonCode: "generic_navigation_contract_unavailable" });
  }
  return Object.freeze({
    status: "resolved",
    source: "trusted_generic_navigation",
    intent: Object.freeze({
      purposeCode: "navigate",
      outcomeCode: "route_changed",
      // Model-derived or lexical cardinality is never used to permit a
      // partial deterministic fallback.
      cardinality: "unknown",
      permittedPurposeCodes: Object.freeze(["navigate"]),
      targetRoles: Object.freeze([]),
      constraints: Object.freeze([]),
      requiredCapabilityIds: Object.freeze([])
    })
  });
}
