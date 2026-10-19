import { blockingQualificationRuns } from "./runState.js";

/**
 * Select or explicitly abandon a durable staging qualification run before a
 * browser is attached. This module owns run-state eligibility only; it never
 * connects to or controls a browser target.
 */
export async function selectQualificationRunState({
  runStore,
  binding,
  profileId,
  mode,
  resumeRunId = null,
  discardRunId = null,
  discardSinglePending = false,
  requestedTargetId = null,
  runStoreDir = "<run-state directory>"
}) {
  const relevantRun = run => run.workflowId === "cloud-agent-staging-qualification"
    && run.environmentId === binding.environmentId
    && (!run.profileId || run.profileId === profileId);
  const pendingRuns = [...new Map([...runStore.listSuspended(), ...runStore.listActive()]
    .filter(relevantRun).map(run => [run.runId, run])).values()];

  let selectedDiscardId = discardRunId;
  if (!selectedDiscardId && discardSinglePending && pendingRuns.length === 1) {
    selectedDiscardId = pendingRuns[0].runId;
  }
  if (selectedDiscardId) {
    const abandoned = pendingRuns.find(run => run.runId === selectedDiscardId);
    if (!abandoned) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`--discard-run '${selectedDiscardId}' does not identify a pending run for profile '${profileId}'.`]
      };
    }
    await runStore.update(abandoned.runId, {
      status: "abandoned",
      pendingInterventionId: null,
      suspendedStepId: null,
      resumeCursor: null
    });
  }

  if (resumeRunId) {
    const candidate = pendingRuns.find(run => run.runId === resumeRunId);
    if (!candidate || !candidate.resumeCursor || !candidate.pendingInterventionId) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`Run '${resumeRunId}' has no resumable human-authentication cursor for profile '${profileId}'.`]
      };
    }
    if (candidate.mode && candidate.mode !== mode) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`Run '${resumeRunId}' was created in ${candidate.mode} mode; refusing to resume it in ${mode} mode.`]
      };
    }
    if (candidate.profileId && candidate.profileId !== profileId) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`Run '${resumeRunId}' belongs to profile '${candidate.profileId}', not '${profileId}'.`]
      };
    }
    if (mode === "owned" && !candidate.target?.targetId) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`Run '${resumeRunId}' has no exact owned browser target to resume.`]
      };
    }
    if (requestedTargetId && requestedTargetId !== candidate.target?.targetId) {
      return {
        ok: false,
        exitCode: 3,
        messages: [`--target-id does not match run '${resumeRunId}' exact target '${candidate.target?.targetId ?? "unknown"}'.`]
      };
    }
    return {
      ok: true,
      resumeRunState: candidate,
      messages: selectedDiscardId
        ? [`Explicitly abandoned suspended run ${selectedDiscardId}; its report and intervention records remain available.`]
        : []
    };
  }

  const remaining = blockingQualificationRuns(pendingRuns, { selectedDiscardId });
  if (remaining.length) {
    return {
      ok: false,
      exitCode: 3,
      messages: [
        `${remaining.length} unfinished run(s) exist in ${runStoreDir}; refusing to start a replacement run.`,
        ...remaining.map(run => `  runId=${run.runId} status=${run.status} pendingIntervention=${run.pendingInterventionId ?? "none"} suspendedStep=${run.suspendedStepId ?? "none"}`),
        "  Resume with --resume-run-id=<runId>, or explicitly abandon one with --discard-run=<runId>."
      ]
    };
  }

  return {
    ok: true,
    resumeRunState: null,
    messages: selectedDiscardId
      ? [`Explicitly abandoned suspended run ${selectedDiscardId}; its report and intervention records remain available.`]
      : []
  };
}
