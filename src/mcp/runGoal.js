import { environmentBindingFingerprint } from "../navigation/engine.js";
import { ApplicationRunService } from "../navigation/applicationRunService.js";
import { projectExtractionOutput } from "../extraction/outputRelease.js";
import { verifyExtractionResult } from "../extraction/extractionVerifier.js";
import { taskGoalFingerprint } from "../state/journal.js";
import { resolveObservedApplication } from "../environments/model.js";
import { createHash, randomUUID } from "node:crypto";

const activeTargets = new Set();

function workflowIntentFingerprint(intent) {
  const normalized = intent && typeof intent === "object" && !Array.isArray(intent) ? intent : {};
  return createHash("sha256").update(JSON.stringify({
    purposeCode: typeof normalized.purposeCode === "string" ? normalized.purposeCode : "",
    outcomeCode: typeof normalized.outcomeCode === "string" ? normalized.outcomeCode : "",
    cardinality: ["atomic", "compound", "unknown"].includes(normalized.cardinality) ? normalized.cardinality : "unknown",
    targetRoles: Array.isArray(normalized.targetRoles) ? normalized.targetRoles.map(String) : [],
    constraints: Array.isArray(normalized.constraints) ? normalized.constraints.map(String) : [],
    requiredCapabilityIds: Array.isArray(normalized.requiredCapabilityIds) ? normalized.requiredCapabilityIds.map(String) : []
  })).digest("hex");
}

function capabilityBindings(requiredCapabilityIds, registry, environment, principalId) {
  if (!requiredCapabilityIds.length) return {};
  if (typeof registry?.list !== "function") return null;
  const environmentId = environment?.environmentId ?? environment?.id ?? null;
  if (!environmentId || !Array.isArray(environment?.applications) || !Array.isArray(environment?.authorizedOrigins)) return null;
  const bindings = {};
  for (const capabilityId of requiredCapabilityIds) {
    const matches = registry.list().filter(manifest => {
      let application = { status: "unmatched" };
      try { application = resolveObservedApplication(environment, new URL(manifest.pagePath, manifest.origin).href); } catch { /* invalid manifest scope */ }
      return manifest.capabilityId === capabilityId
        && manifest.environmentId === environmentId
        && manifest.principalId === principalId
        && typeof manifest.capabilityVersion === "number"
        && typeof manifest.pagePath === "string"
        && application.status === "matched"
        && application.applicationId === manifest.applicationId
        && environment.authorizedOrigins.includes(manifest.origin);
    });
    if (matches.length !== 1) return null;
    const manifest = matches[0];
    bindings[capabilityId] = {
      capabilityVersion: manifest.capabilityVersion,
      environmentId: manifest.environmentId,
      origin: manifest.origin,
      applicationId: manifest.applicationId,
      pagePath: manifest.pagePath,
      principalId: manifest.principalId,
      manifestFingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
    };
  }
  return bindings;
}

function outputsMatchCapabilityBindings(outputs, bindings) {
  return Object.entries(bindings ?? {}).every(([capabilityId, binding]) => {
    const scope = outputs?.[capabilityId]?.scope;
    return scope?.origin === binding.origin && scope?.pagePath === binding.pagePath &&
      scope?.environmentId === binding.environmentId && scope?.applicationId === binding.applicationId;
  });
}

function checkpointPageUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return null; }
}

function sanitizeCheckpointOutput(output) {
  const safe = structuredClone(output);
  for (const provenance of safe.fieldProvenance ?? []) {
    for (const field of Object.values(provenance.fields ?? {})) {
      if (typeof field.pageUrl === "string") {
        const pageUrl = checkpointPageUrl(field.pageUrl);
        if (!pageUrl) throw new Error("Collection checkpoint contains an unsupported source route.");
        field.pageUrl = pageUrl;
      }
    }
  }
  return safe;
}

function unavailableArtifactResult(resumeState, reason) {
  return {
    status: "unresolved",
    goal: "[redacted task goal]",
    taskId: resumeState.taskId,
    attempts: resumeState.attempts.length,
    recoveries: resumeState.recoveryCount ?? 0,
    reason
  };
}

/** Persist only complete, released outputs tied to current qualified manifests. */
export async function persistWorkflowResultArtifact({
  resultArtifact,
  taskId,
  target,
  goal,
  environment,
  environmentFingerprint,
  principalId,
  intentFingerprint,
  requiredCapabilityIds = [],
  expectedCapabilityBindings = null,
  capabilityRegistry,
  authorizeExtractionRelease = null,
  outputs
} = {}) {
  const outputIds = Object.keys(outputs ?? {});
  if (!outputIds.length) return false;
  const artifactCapabilityIds = requiredCapabilityIds.length ? [...requiredCapabilityIds] : outputIds;
  const validIds = artifactCapabilityIds.length > 0 && artifactCapabilityIds.length <= 24
    && artifactCapabilityIds.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id));
  const bindings = validIds ? capabilityBindings(artifactCapabilityIds, capabilityRegistry, environment, principalId) : null;
  const bindingsMatchExpected = !requiredCapabilityIds.length
    || expectedCapabilityBindings && JSON.stringify(bindings) === JSON.stringify(expectedCapabilityBindings);
  if (!validIds || !bindings || !bindingsMatchExpected ||
      !outputsMatchCapabilityBindings(outputs, bindings) ||
      artifactCapabilityIds.some(id => !Object.hasOwn(outputs ?? {}, id))) {
    throw new Error("Workflow extraction outputs must match currently qualified capability manifests.");
  }
  const releasedOutputs = Object.fromEntries(artifactCapabilityIds.map(capabilityId => [
    capabilityId,
    projectExtractionOutput(outputs[capabilityId], authorizeExtractionRelease, { taskId, principalId, capabilityId })
  ]));
  if (Object.values(releasedOutputs).some(output => verifyExtractionResult(output).status !== "complete")) {
    throw new Error("Workflow extraction outputs must pass current release policy and independent verification before they can be persisted.");
  }
  await resultArtifact.write({
    schemaVersion: 1,
    taskId,
    targetId: target.id,
    endpoint: target.endpoint ?? "local-cdp",
    goalFingerprint: taskGoalFingerprint(goal),
    environmentFingerprint,
    principalId,
    intentFingerprint,
    capabilityBindings: bindings,
    requiredCapabilityIds: artifactCapabilityIds,
    outputs: releasedOutputs,
    createdAt: new Date().toISOString()
  });
  await resultArtifact.clearCheckpoint?.();
  return true;
}

export function resolveWorkflowStoreOption(args = {}, workflowStore = null) {
  if (args.reuseWorkflows === true && !workflowStore) throw new Error("Set ACTIVETAB_WORKFLOW_STORE before enabling workflow reuse.");
  return args.reuseWorkflows === false ? null : workflowStore ?? null;
}

export async function runMcpGoal(session, args, { journalStore, workflowStore, decisionRuntime = null, environment = null, capabilityRegistry = null, capabilityService = null, authorizeExtractionField = null, authorizeExtractionRelease = null, workflowSynthesizer = null, runStateStore = null } = {}) {
  if (!journalStore) throw new Error("MCP task journal storage is unavailable.");
  const selectedWorkflowStore = resolveWorkflowStoreOption(args, workflowStore);
  const suppliedCapabilityIds = args.workflowIntent?.requiredCapabilityIds;
  if (suppliedCapabilityIds !== undefined && (!Array.isArray(suppliedCapabilityIds) || suppliedCapabilityIds.length > 24 ||
      suppliedCapabilityIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id)) ||
      new Set(suppliedCapabilityIds).size !== suppliedCapabilityIds.length)) {
    throw new Error("workflowIntent.requiredCapabilityIds must contain at most 24 unique registered capability IDs.");
  }
  const requiredCapabilityIds = suppliedCapabilityIds ?? [];
  if (requiredCapabilityIds.length && args.plannerMode !== "workflow") {
    throw new Error("workflowIntent.requiredCapabilityIds requires plannerMode=workflow.");
  }

  const targetLock = JSON.stringify([session.target?.endpoint ?? "local-cdp", session.target?.id ?? ""]);
  if (activeTargets.has(targetLock)) throw new Error("A run_goal task is already active on this browser target.");
  activeTargets.add(targetLock);
  try {
    const runService = new ApplicationRunService({ runStateStore });
    return await runService.withTargetLease(session, `mcp-goal-${randomUUID()}`, async ({ runNavigation }) => {
      const { journal, resultArtifact } = await journalStore.forTask(session.target, args.goal);
      const principalId = session.principalId ?? session.authorizationPrincipalId ?? "local_mcp_automation";
      const currentEnvironmentFingerprint = environmentBindingFingerprint(environment);
      const intentFingerprint = workflowIntentFingerprint(args.workflowIntent);
      const currentCapabilityBindings = capabilityBindings(requiredCapabilityIds, capabilityRegistry, environment, principalId);
      let resumeState;
      if (args.newTask === true) {
        await journal.clear();
        await resultArtifact.clear();
      } else {
        try { resumeState = await journal.read(); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }

      let resumeWorkflowCheckpoint = null;
      if (args.newTask !== true) {
        let checkpoint = null;
        try { checkpoint = await resultArtifact.readCheckpoint?.(); }
        catch { return unavailableArtifactResult(resumeState ?? { taskId: "unknown", attempts: [], recoveryCount: 0 }, "The partial collection checkpoint is invalid or unavailable; pass newTask=true to rebuild it from fresh evidence."); }
        if (checkpoint) {
          const checkpointBindings = capabilityBindings([checkpoint.capabilityId], capabilityRegistry, environment, principalId);
          const validCheckpoint = resumeState
            && checkpoint.taskId === resumeState.taskId
            && checkpoint.targetId === session.target.id
            && checkpoint.endpoint === (session.target.endpoint ?? "local-cdp")
            && checkpoint.goalFingerprint === taskGoalFingerprint(args.goal)
            && checkpoint.environmentFingerprint === currentEnvironmentFingerprint
            && checkpoint.principalId === principalId
            && checkpoint.intentFingerprint === intentFingerprint
            && checkpointBindings
            && JSON.stringify(checkpoint.capabilityBindings) === JSON.stringify(checkpointBindings)
            && (!requiredCapabilityIds.length || requiredCapabilityIds.includes(checkpoint.capabilityId))
            && Array.isArray(checkpoint.unresolvedOperationIds) && checkpoint.unresolvedOperationIds.length === 0;
          if (!validCheckpoint) {
            return unavailableArtifactResult(resumeState ?? { taskId: checkpoint.taskId, attempts: [], recoveryCount: 0 }, "The partial collection checkpoint no longer matches its target, profile, principal, intent, or qualified capability; pass newTask=true to rebuild it.");
          }
          resumeWorkflowCheckpoint = checkpoint;
        }
      }

      if (resumeState?.status === "succeeded") {
        let artifact;
        try { artifact = await resultArtifact.read(); }
        catch { return unavailableArtifactResult(resumeState, "The completed task's extracted artifact is invalid or unavailable; pass newTask=true to reobserve and rebuild it."); }
        if (artifact) {
          const artifactCapabilityIds = requiredCapabilityIds.length ? requiredCapabilityIds : artifact.requiredCapabilityIds;
          const currentArtifactBindings = capabilityBindings(artifactCapabilityIds, capabilityRegistry, environment, principalId);
          if (artifact.taskId !== resumeState.taskId || artifact.targetId !== session.target.id ||
              artifact.endpoint !== (session.target.endpoint ?? "local-cdp") || artifact.goalFingerprint !== taskGoalFingerprint(args.goal) ||
              artifact.environmentFingerprint !== currentEnvironmentFingerprint || artifact.principalId !== principalId ||
              artifact.intentFingerprint !== intentFingerprint ||
              !currentArtifactBindings || JSON.stringify(artifact.capabilityBindings) !== JSON.stringify(currentArtifactBindings) ||
              !outputsMatchCapabilityBindings(artifact.outputs, currentArtifactBindings) ||
              (requiredCapabilityIds.length && JSON.stringify(artifact.requiredCapabilityIds) !== JSON.stringify(requiredCapabilityIds))) {
            return unavailableArtifactResult(resumeState, "The completed task's extracted artifact is missing or its target, profile, principal, or intent binding changed; pass newTask=true to reobserve and rebuild it.");
          }
          const workflowOutputs = Object.fromEntries(artifactCapabilityIds.map(capabilityId => [
            capabilityId,
            projectExtractionOutput(artifact.outputs[capabilityId], authorizeExtractionRelease, { taskId: resumeState.taskId, principalId, capabilityId })
          ]));
          if (artifactCapabilityIds.some(id => !Object.hasOwn(workflowOutputs, id)) ||
              Object.values(workflowOutputs).some(output => verifyExtractionResult(output).status !== "complete")) {
            return unavailableArtifactResult(resumeState, "Current extraction release policy or artifact verification does not permit returning a complete result; pass newTask=true to rebuild under current policy.");
          }
          return {
            status: "succeeded",
            goal: "[redacted task goal]",
            taskId: resumeState.taskId,
            attempts: resumeState.attempts.length,
            recoveries: resumeState.recoveryCount ?? 0,
            ...(resumeState.resultEvidenceId ? { evidenceId: resumeState.resultEvidenceId } : {}),
            workflowOutputs,
            resumed: false,
            alreadySucceeded: true
          };
        }
        if (requiredCapabilityIds.length) {
          return unavailableArtifactResult(resumeState, "The completed task's extracted artifact is missing; pass newTask=true to reobserve and rebuild it.");
        }
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

      const result = await runNavigation({
        goal: args.goal,
        journal,
        resumeState,
        workflowIntent: args.workflowIntent ?? null,
        signal: null,
        engineOptions: {
          executionMode: "standalone",
          plannerMode: args.plannerMode ?? "auto",
          principalId,
          capabilityRegistry,
          capabilityService,
          authorizeExtractionField,
          authorizeExtractionRelease,
          resumeWorkflowCheckpoint,
          persistWorkflowCheckpoint: async checkpoint => {
            const state = await journal.read();
            if (!state?.taskId || state.taskId !== checkpoint.taskId || state.pendingAction) throw new Error("Cannot checkpoint collection output while a browser operation is unresolved.");
            const bindings = capabilityBindings([checkpoint.capabilityId], capabilityRegistry, environment, principalId);
            if (!bindings) throw new Error("Collection checkpoint capability is no longer uniquely qualified.");
            const pageEvidence = checkpoint.pageEvidence.map(page => ({
              ...page,
              pageUrl: checkpointPageUrl(page.pageUrl)
            }));
            if (pageEvidence.some(page => !page.pageUrl)) throw new Error("Collection checkpoint contains an unsupported page route.");
            await resultArtifact.writeCheckpoint({
              schemaVersion: 1,
              kind: "partial_collection_checkpoint",
              taskId: state.taskId,
              targetId: session.target.id,
              endpoint: session.target.endpoint ?? "local-cdp",
              goalFingerprint: taskGoalFingerprint(args.goal),
              environmentFingerprint: checkpoint.environmentFingerprint,
              principalId: checkpoint.principalId,
              intentFingerprint,
              capabilityId: checkpoint.capabilityId,
              capabilityVersion: checkpoint.capabilityVersion,
              capabilityBindings: bindings,
              contractFingerprint: checkpoint.contractFingerprint,
              fieldPolicyFingerprint: checkpoint.fieldPolicyFingerprint,
              releasePolicyFingerprint: checkpoint.releasePolicyFingerprint,
              sourceObservationRef: checkpoint.sourceObservationRef,
              pageIdentityFingerprints: checkpoint.pageIdentityFingerprints,
              cursorFingerprint: checkpoint.cursorFingerprint,
              nextCursorFingerprint: checkpoint.nextCursorFingerprint,
              nextPageStatus: checkpoint.nextPageStatus,
              duplicateRecordCount: checkpoint.duplicateRecordCount,
              terminalEvidence: checkpoint.terminalEvidence,
              pageCount: checkpoint.pageCount,
              pageEvidence,
              unresolvedOperationIds: [],
              output: sanitizeCheckpointOutput(checkpoint.output),
              createdAt: new Date().toISOString()
            });
          },
          clearWorkflowCheckpoint: () => resultArtifact.clearCheckpoint?.(),
          ...(workflowSynthesizer ? { workflowSynthesizer } : {}),
          persistWorkflowOutputs: ({ taskId, environmentFingerprint: boundEnvironment, principalId: boundPrincipal, outputs }) => persistWorkflowResultArtifact({
            resultArtifact,
            taskId,
            target: session.target,
            goal: args.goal,
            environment,
            environmentFingerprint: boundEnvironment,
            principalId: boundPrincipal,
            intentFingerprint,
            requiredCapabilityIds,
            expectedCapabilityBindings: currentCapabilityBindings,
            capabilityRegistry,
            authorizeExtractionRelease,
            outputs
          }),
          maxActions: args.maxActions ?? 8,
          maxScrolls: args.maxScrolls ?? 5,
          environment,
          decisionRuntime,
          ...(selectedWorkflowStore ? { workflowStore: selectedWorkflowStore } : {})
        }
      });
      const finalState = await journal.read();
      return { ...result, taskId: finalState.taskId, resumed: Boolean(resumeState) };
    });
  } finally {
    activeTargets.delete(targetLock);
  }
}
