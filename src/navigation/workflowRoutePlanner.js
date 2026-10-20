import { DeterministicPlanner } from "./planner.js";
import { selectTaskExecutionRoute } from "./taskIntentResolver.js";
import { WorkflowGraphPlanner } from "./workflowPlanner.js";

class UnresolvedTaskRoutePlanner {
  constructor(reason) { this.reason = reason; }
  async plan() {
    return { status: "ambiguous", candidates: [], reason: this.reason };
  }
}

/**
 * Choose the existing planner only after task resolution against trusted
 * capabilities. This module constructs a planner or an explicit abstention;
 * it does not observe a browser or dispatch actions.
 */
export function createWorkflowRoutePlanner({
  requestedPlannerMode,
  classifiedTask,
  trustedCapabilities,
  taskResolution,
  workflowIntent,
  searchReadRequest,
  synthesizer,
  knowledge,
  inputs,
  decisionRuntime,
  episodeId,
  runId,
  scope,
  allowDeterministicShortcut,
  allowAtomicFallback
} = {}) {
  const executionRoute = selectTaskExecutionRoute({
    requestedPlannerMode,
    classifiedTask,
    trustedCapabilities,
    taskResolution
  });
  let effectiveWorkflowIntent = workflowIntent;
  if (searchReadRequest) {
    effectiveWorkflowIntent = taskResolution.status === "resolved" ? taskResolution.intent : null;
  } else if (taskResolution.status === "resolved") {
    effectiveWorkflowIntent = taskResolution.intent;
  }

  if (executionRoute.kind === "unresolved") {
    return {
      planner: new UnresolvedTaskRoutePlanner(
        `No trusted execution route can establish the requested outcome (${executionRoute.reasonCode}); no browser action was selected.`
      ),
      effectiveWorkflowIntent,
      executionRoute
    };
  }

  return {
    planner: new WorkflowGraphPlanner({
      synthesizer,
      capabilities: trustedCapabilities,
      knowledge,
      inputs,
      taskIntent: effectiveWorkflowIntent,
      decisionRuntime,
      episodeId,
      runId,
      scope,
      allowDeterministicShortcut,
      allowAtomicFallback,
      fallbackPlanner: new DeterministicPlanner()
    }),
    effectiveWorkflowIntent,
    executionRoute
  };
}
