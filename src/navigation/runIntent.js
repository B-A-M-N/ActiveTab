import { classifyTaskRequest } from "./taskIntentResolver.js";
import { createSearchSubmitAuthorizer, searchPhraseFromGoal, searchReadRequestFromGoal } from "./search.js";

/** Prepare run-local interpretation hints; this does not grant an executable capability. */
export function createNavigationRunIntent({
  goal,
  suppliedIntent = null,
  plannerMode = "auto",
  resumeState = null,
  canResumeWorkflowCheckpoint = false
} = {}) {
  const searchReadRequest = searchReadRequestFromGoal(goal);
  const searchPhrase = searchReadRequest?.query ?? searchPhraseFromGoal(goal);
  const taskRequest = classifyTaskRequest(goal, { suppliedIntent });
  const explicitReadWorkflowRequest = taskRequest.explicitReadRequest;
  const workflowModeActive = (!resumeState || Boolean(canResumeWorkflowCheckpoint))
    && ((plannerMode === "workflow" && (!searchPhrase || Boolean(searchReadRequest)))
      || (plannerMode === "auto" && (explicitReadWorkflowRequest || taskRequest.compoundRequest || taskRequest.typedWorkflowIntent)));
  const searchSubmitAuthorizer = searchPhrase ? createSearchSubmitAuthorizer(searchPhrase) : null;

  return {
    searchReadRequest,
    searchPhrase,
    taskRequest,
    explicitReadWorkflowRequest,
    workflowModeActive,
    searchSubmitAuthorizer
  };
}
