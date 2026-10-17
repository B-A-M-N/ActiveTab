import { NavigationEngine } from "../navigation/engine.js";

const activeTargets = new Set();

export async function runMcpGoal(session, args, { journalStore, workflowStore } = {}) {
  if (!journalStore) throw new Error("MCP task journal storage is unavailable.");
  if (args.reuseWorkflows === true && !workflowStore) throw new Error("Set ACTIVETAB_WORKFLOW_STORE before enabling workflow reuse.");

  const targetLock = JSON.stringify([session.target?.endpoint ?? "local-cdp", session.target?.id ?? ""]);
  if (activeTargets.has(targetLock)) throw new Error("A run_goal task is already active on this browser target.");
  activeTargets.add(targetLock);
  try {
    const { journal } = await journalStore.forTask(session.target, args.goal);
    let resumeState;
    if (args.newTask === true) {
      await journal.clear();
    } else {
      try { resumeState = await journal.read(); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }

    if (resumeState?.status === "succeeded") {
      return {
        status: "succeeded",
        goal: "[redacted task goal]",
        taskId: resumeState.taskId,
        attempts: resumeState.attempts.length,
        recoveries: resumeState.recoveryCount ?? 0,
        ...(resumeState.resultEvidenceId ? { evidenceId: resumeState.resultEvidenceId } : {}),
        resumed: false,
        alreadySucceeded: true
      };
    }

    const result = await new NavigationEngine(session, {
      maxActions: args.maxActions ?? 8,
      maxScrolls: args.maxScrolls ?? 5,
      journal,
      ...(args.reuseWorkflows === true ? { workflowStore } : {})
    }).run(args.goal, { ...(resumeState ? { resumeState } : {}) });
    const finalState = await journal.read();
    return { ...result, taskId: finalState.taskId, resumed: Boolean(resumeState) };
  } finally {
    activeTargets.delete(targetLock);
  }
}
