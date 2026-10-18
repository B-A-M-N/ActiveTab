import { evaluateAssertion } from "../assertions.js";
import { STEP_STATUS } from "../schema.js";
import { executeAuthorizedAction } from "../../runtime/authorizedExecutor.js";

/** Runs browser workflow steps through ActiveTab's sole authorized executor. */
export class BrowserStepHandler {
  constructor({
    session,
    environment = null,
    localFixture = false,
    collector = null,
    correlator = null,
    operationAuthorizer = null,
    resolveWorkflowValue,
    createTelemetryHooks,
    emitTraceEvent,
    getExecutionLeaseAssertion
  } = {}) {
    this.session = session;
    this.environment = environment;
    this.localFixture = localFixture;
    this.collector = collector;
    this.correlator = correlator;
    this.operationAuthorizer = operationAuthorizer;
    this.resolveWorkflowValue = resolveWorkflowValue ?? (value => value);
    this.createTelemetryHooks = createTelemetryHooks ?? (async () => null);
    this.emitTraceEvent = emitTraceEvent ?? (() => {});
    this.getExecutionLeaseAssertion = getExecutionLeaseAssertion ?? (() => null);
  }

  async executeNavigate(step, receipt, startedAt, context = null) {
    if (!this.session) {
      const reason = "No browser session available for navigation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const url = this.resolveWorkflowValue(step.url, context);
    if (typeof url !== "string" || url.length === 0) {
      const reason = "Navigation URL is unavailable in the current scoped workflow inputs.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const preObservation = await this.session.observe();
    const telemetry = await this.createTelemetryHooks(receipt, "navigate");
    this.emitTraceEvent({ eventId: `step:${step.id}:start`, runId: receipt.runId, stepId: step.id, event: "step_start", actionType: "navigate" });
    let authResult;
    try {
      this.emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: "navigate" });
      authResult = await executeAuthorizedAction({
        session: this.session,
        environment: this.environment,
        action: "navigate",
        url,
        expectedUrlPattern: step.expectedUrlPattern ?? null,
        localFixture: this.localFixture,
        assertExecutionLease: this.getExecutionLeaseAssertion(),
        ...(telemetry ? { onAdmission: telemetry.onAdmission, onReserve: telemetry.onReserve, onDispatch: telemetry.onDispatch } : {})
      });
      if (!authResult.dispatched) {
        if (telemetry && !authResult.authorized) await telemetry.recordDenied(authResult.observation ?? preObservation);
        const status = authResult.status === "uncertain" ? STEP_STATUS.UNCERTAIN
          : authResult.authorized ? STEP_STATUS.FAIL : STEP_STATUS.BLOCKED;
        const reason = authResult.status === "uncertain"
          ? `Navigation outcome is uncertain: ${authResult.reason}`
          : authResult.authorized
            ? `Navigation dispatch failed: ${authResult.reason}`
            : `Navigation refused by policy: ${authResult.reason}`;
        receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt });
        return { status, reason };
      }
    } catch (error) {
      const reason = `Navigation dispatch failed: ${String(error.message ?? error).slice(0, 200)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
    const waitBaseline = {
      pageChangeFingerprint: preObservation.pageChangeFingerprint,
      domMutationCount: preObservation.domMutationCount,
      lifecycleEventCount: preObservation.lifecycleEventCount
    };
    try { await this.session.waitForChange(step.timeoutMs ?? 5_000, waitBaseline); }
    catch { /* Wait may time out; the postcondition check below is the authority. */ }
    const postObservation = await this.session.observe();
    const navigationSucceeded = postObservation?.page?.url && (
      url === postObservation.page.url ||
      postObservation.page.url.startsWith(url) ||
      (step.expectedUrlPattern ? new RegExp(step.expectedUrlPattern).test(postObservation.page.url) : false)
    );
    const telemetryChanged = postObservation?.pageChangeFingerprint !== preObservation.pageChangeFingerprint;
    if (telemetry) await telemetry.recordObserved(postObservation, telemetryChanged, navigationSucceeded ? "navigation_destination_observed" : "navigation_mismatch_observed");
    let status = authResult?.telemetryError ? STEP_STATUS.UNCERTAIN : navigationSucceeded ? STEP_STATUS.PASS : STEP_STATUS.FAIL;
    let reason = navigationSucceeded
      ? `Navigated to ${postObservation.page.url}.`
      : "Post-navigation URL did not match the requested destination.";
    if (telemetry) {
      try {
        await telemetry.recordVerification({
          status,
          oracleType: "authorized_destination_url",
          reasonCode: navigationSucceeded ? "destination_observed" : "destination_mismatch",
          observation: postObservation,
          evidenceIds: [preObservation.evidenceId, postObservation?.evidenceId].filter(Boolean)
        });
      } catch {
        status = STEP_STATUS.UNCERTAIN;
        reason = "Navigation was observed but its durable operation receipt could not be reconciled.";
      }
    }
    this.emitTraceEvent({ eventId: `step:${step.id}:verify`, runId: receipt.runId, stepId: step.id, event: "outcome_verification", status, observedUrl: postObservation?.page?.url, evidenceId: postObservation?.evidenceId });
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [postObservation?.evidenceId ?? ""].filter(Boolean),
      details: { finalUrl: postObservation?.page?.url ?? null, title: postObservation?.page?.title ?? null }
    });
    return { status, reason, observation: postObservation };
  }

  async executeInteract(step, receipt, startedAt, context = null) {
    if (!this.session) {
      const reason = "No browser session available for interaction.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const observation = await this.session.observe();
    if (!observation?.candidates?.length) {
      const reason = "No candidates available in the current observation.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.UNCERTAIN, reason, startedAt, evidenceIds: [observation?.evidenceId ?? ""].filter(Boolean) });
      return { status: STEP_STATUS.UNCERTAIN, reason };
    }
    const action = { ...step.action, value: this.resolveWorkflowValue(step.action.value, context) };
    if (step.action.value !== undefined && action.value === undefined) {
      const reason = "Interaction value is unavailable in the current scoped workflow inputs.";
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const candidate = this.resolveCandidate(observation, action);
    if (!candidate) {
      const reason = `No unique candidate matched the action target: ${JSON.stringify(action.target ?? {})}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.BLOCKED, reason };
    }
    const decisionContext = this.operationAuthorizer?.decisionContext?.(action.operationId) ?? null;
    const telemetry = await this.createTelemetryHooks(receipt, action.type, candidate, decisionContext);
    this.emitTraceEvent({ eventId: `step:${step.id}:dispatch`, runId: receipt.runId, stepId: step.id, event: "action_dispatch", actionType: action.type, backendNodeId: candidate.backendNodeId });
    let dispatchResult;
    let authResult;
    try {
      authResult = await executeAuthorizedAction({
        session: this.session,
        environment: this.environment,
        goal: step.goal ?? null,
        action: action.type,
        candidate,
        value: action.value ?? null,
        filePaths: action.filePaths ?? null,
        localFixture: this.localFixture,
        operationId: action.operationId ?? null,
        operationAuthorizer: this.operationAuthorizer,
        assertExecutionLease: this.getExecutionLeaseAssertion(),
        ...(telemetry ? { onAdmission: telemetry.onAdmission, onReserve: telemetry.onReserve, onDispatch: telemetry.onDispatch } : {})
      });
      if (!authResult.dispatched) {
        if (telemetry && !authResult.authorized) await telemetry.recordDenied(authResult.observation ?? observation);
        const status = authResult.status === "uncertain" ? STEP_STATUS.UNCERTAIN
          : authResult.authorized ? STEP_STATUS.FAIL : STEP_STATUS.BLOCKED;
        const reason = authResult.status === "uncertain"
          ? `Interaction outcome is uncertain: ${authResult.reason}`
          : authResult.authorized
            ? `Interaction dispatch failed: ${authResult.reason}`
            : `Interaction refused by policy: ${authResult.reason}`;
        receipt.recordStep({ stepId: step.id, type: step.type, status, reason, startedAt, evidenceIds: [observation.evidenceId] });
        return { status, reason };
      }
      dispatchResult = authResult.dispatchResult;
    } catch (error) {
      const reason = `Interaction dispatch failed: ${String(error.message ?? error).slice(0, 300)}`;
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt, evidenceIds: [observation.evidenceId] });
      return { status: STEP_STATUS.FAIL, reason };
    }
    const waitBaseline = {
      pageChangeFingerprint: observation.pageChangeFingerprint,
      domMutationCount: observation.domMutationCount,
      lifecycleEventCount: observation.lifecycleEventCount
    };
    try { await this.session.waitForChange(action.timeoutMs ?? 2_000, waitBaseline); }
    catch { /* Wait may time out; postcondition below is the authority. */ }
    const postObservation = await this.session.observe();
    const stateChanged = postObservation?.pageChangeFingerprint !== observation.pageChangeFingerprint;
    if (telemetry) await telemetry.recordObserved(postObservation, stateChanged, stateChanged ? "interaction_state_changed" : "interaction_state_unchanged");
    let valueVerification = null;
    if (action.verifyValue === true) {
      if (typeof this.session.verifyControlValue !== "function") {
        valueVerification = { verified: false, matches: false, reason: "The browser adapter cannot verify the exact control value." };
      } else {
        try { valueVerification = await this.session.verifyControlValue(candidate, action.value ?? ""); }
        catch { valueVerification = { verified: false, matches: false, reason: "Exact control-value verification failed." }; }
      }
    }
    const actionPostcondition = action.postcondition
      ? evaluateAssertion(action.postcondition, { observation: postObservation, collector: this.collector, correlator: this.correlator })
      : null;
    let status = authResult.telemetryError || authResult.operationError
      ? STEP_STATUS.UNCERTAIN
      : action.verifyValue === true
        ? valueVerification?.verified ? valueVerification.matches ? STEP_STATUS.PASS : STEP_STATUS.FAIL : STEP_STATUS.UNCERTAIN
        : actionPostcondition
          ? actionPostcondition.status
          : STEP_STATUS.UNCERTAIN;
    let reason = action.verifyValue === true
      ? valueVerification?.matches === true
        ? `Interaction '${action.type}' value was verified locally.`
        : valueVerification?.verified
          ? `Interaction '${action.type}' value did not match the caller-supplied value.`
          : `Interaction '${action.type}' was dispatched, but its exact value could not be verified.`
      : actionPostcondition
        ? actionPostcondition.reason
        : stateChanged
          ? `Interaction '${action.type}' changed page state, but no independent postcondition was supplied.`
          : `Interaction '${action.type}' was dispatched, but no independent postcondition was supplied.`;
    if (telemetry) {
      try {
        await telemetry.recordVerification({
          status,
          oracleType: actionPostcondition ? `assertion:${action.postcondition.type}` : action.verifyValue === true ? "control_value" : "none",
          reasonCode: status === STEP_STATUS.PASS ? "postcondition_verified"
            : status === STEP_STATUS.FAIL ? "postcondition_failed" : "independent_postcondition_missing_or_uncertain",
          observation: postObservation,
          evidenceIds: [...new Set([observation.evidenceId, postObservation?.evidenceId, ...(actionPostcondition?.evidenceIds ?? [])].filter(Boolean))]
        });
      } catch {
        status = STEP_STATUS.UNCERTAIN;
        reason = "Interaction was observed but its durable operation receipt could not be reconciled.";
      }
    }
    receipt.recordStep({
      stepId: step.id, type: step.type, status, reason, startedAt,
      evidenceIds: [...new Set([observation.evidenceId, postObservation?.evidenceId ?? "", ...(actionPostcondition?.evidenceIds ?? [])].filter(Boolean))],
      details: {
        actionType: action.type,
        backendNodeId: candidate.backendNodeId,
        dispatchStatus: authResult.status,
        beforeEvidenceId: observation.evidenceId,
        afterEvidenceId: postObservation?.evidenceId ?? null,
        ...(telemetry ? { decisionId: telemetry.decisionId, operationId: telemetry.operationId } : {}),
        stateChanged,
        ...(action.verifyValue === true ? { valueVerified: valueVerification?.matches === true } : {}),
        ...(actionPostcondition ? { postconditionStatus: actionPostcondition.status } : {})
      }
    });
    return { status, reason, observation: postObservation };
  }

  resolveCandidate(observation, action) {
    if (!observation?.candidates || !action?.target) return null;
    const target = action.target;
    if (target.observationId !== undefined && target.observationId !== observation.evidenceId) return null;
    const matches = observation.candidates.filter(candidate => {
      if (target.identity && candidate.identity !== target.identity) return false;
      if (target.backendNodeId !== undefined && candidate.backendNodeId !== target.backendNodeId) return false;
      if (target.name && candidate.name !== target.name) return false;
      if (target.role && candidate.role !== target.role) return false;
      if (target.tag && candidate.tag !== target.tag) return false;
      if (target.visible !== undefined && candidate.visible !== target.visible) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }
}
