import { STEP_STATUS } from "../schema.js";

/** Routes validated workflow steps to their focused handlers. */
export class StepDispatcher {
  constructor({
    executeSetup,
    executeNavigate,
    executeInteract,
    executeGoal,
    apiStepHandler,
    verificationStepHandler,
    qualificationStepHandler,
    controlFlowStepHandler,
    getTelemetryStepId
  } = {}) {
    this.executeSetup = executeSetup;
    this.executeNavigate = executeNavigate;
    this.executeInteract = executeInteract;
    this.executeGoal = executeGoal;
    this.apiStepHandler = apiStepHandler;
    this.verificationStepHandler = verificationStepHandler;
    this.qualificationStepHandler = qualificationStepHandler;
    this.controlFlowStepHandler = controlFlowStepHandler;
    this.getTelemetryStepId = getTelemetryStepId ?? (() => null);
  }

  async execute(step, receipt, context = null, stepStatuses = new Map()) {
    const startedAt = new Date().toISOString();
    try {
      switch (step.type) {
        case "setup": return await this.executeSetup(step, receipt, startedAt);
        case "navigate": return await this.executeNavigate(step, receipt, startedAt, context);
        case "interact": return await this.executeInteract(step, receipt, startedAt, context);
        case "api_call": return await this.apiStepHandler.execute(step, receipt, startedAt);
        case "wait_for": return await this.verificationStepHandler.executeWaitFor(step, receipt, startedAt);
        case "assert": return await this.verificationStepHandler.executeAssert(step, receipt, startedAt);
        case "diagnostic_snapshot": return await this.verificationStepHandler.executeDiagnosticSnapshot(step, receipt, startedAt);
        case "controlled_failure": return await this.verificationStepHandler.executeControlledFailure(step, receipt, startedAt);
        case "retry_verification": return await this.verificationStepHandler.executeRetryVerification(step, receipt, startedAt);
        case "postcondition": return await this.verificationStepHandler.executePostcondition(step, receipt, startedAt);
        case "cleanup": return await this.verificationStepHandler.executeCleanup(step, receipt, startedAt, context);
        case "goal": return await this.executeGoal(step, receipt, startedAt);
        case "qualify": return await this.qualificationStepHandler.execute(
          step,
          receipt,
          startedAt,
          context,
          this.getTelemetryStepId(step)
        );
        case "set_variable": return this.controlFlowStepHandler.executeSetVariable(step, receipt, startedAt, context, stepStatuses);
        case "repeat": return await this.controlFlowStepHandler.executeRepeat(step, receipt, startedAt, context);
        case "subworkflow": return await this.controlFlowStepHandler.executeSubworkflow(step, receipt, startedAt, context);
        default: {
          const message = `Unsupported step type '${step.type}'.`;
          receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.BLOCKED, reason: message, startedAt });
          return { status: STEP_STATUS.BLOCKED, reason: message };
        }
      }
    } catch (error) {
      const reason = String(error?.message ?? error).slice(0, 500);
      receipt.recordStep({ stepId: step.id, type: step.type, status: STEP_STATUS.FAIL, reason, startedAt });
      return { status: STEP_STATUS.FAIL, reason };
    }
  }
}
