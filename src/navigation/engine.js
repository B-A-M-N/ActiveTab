import { createHash } from "node:crypto";
import { configuredPlanner, DeterministicPlanner, goalExpectation } from "./planner.js";
import { searchPhraseFromGoal } from "./search.js";
import { authorizePlannedAction } from "./actionPolicy.js";
import { classifyHumanHandoff } from "./handoff.js";
import { newTaskState, taskGoalFingerprint, updateTaskJournal } from "../state/journal.js";
import { normalizeOrigin } from "../environments/model.js";
import { matchesScrollTargetSignature, matchesTargetSignature, observationSemanticFingerprint, observationStateFingerprint, routeFingerprint, scrollPositionFraction, scrollPositionMatches, scrollTargetSignature, targetSignature, visibleCandidatesFingerprint } from "../state/workflows.js";

function pageChangeWaitBaseline(observation, scrollTarget) {
  return {
    pageChangeFingerprint: observation.pageChangeFingerprint,
    domMutationCount: observation.domMutationCount,
    lifecycleEventCount: observation.lifecycleEventCount,
    ...(scrollTarget ? { scrollTarget } : {})
  };
}

function pageLabelEntries(observation) {
  const normalize = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const entries = [];
  const title = normalize(observation.page?.title);
  if (title) entries.push({ source: "title", text: title });
  for (const heading of observation.headings ?? []) {
    const text = normalize(heading.text);
    if (text) entries.push({ source: `heading:${heading.level ?? ""}:${heading.frameId ?? ""}`, text });
  }
  return entries;
}

function pageLabelHash(entry) {
  return createHash("sha256").update(JSON.stringify([entry.source, entry.text])).digest("hex");
}

function pageLabelHashes(observation) {
  return [...new Set(pageLabelEntries(observation).map(pageLabelHash))].sort();
}

function labelTerms(value) {
  return new Set(String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function hasVerifiedOutcome(observation, goal, initialPageLabelHashes, environment = null) {
  const expected = goalExpectation(goal);
  if (!expected.targetTokens.length) return false;
  const labels = pageLabelEntries(observation);
  const baselineLabels = new Set(initialPageLabelHashes ?? []);
  const changedLabels = labels.filter(label => !baselineLabels.has(pageLabelHash(label)));
  const changedLabelsMatch = changedLabels.some(label => {
    const observedTerms = labelTerms(label.text);
    return expected.targetTokens.every(token => observedTerms.has(token));
  });
  let pathTerms = new Set();
  try { pathTerms = labelTerms(new URL(observation.page.url).pathname); } catch { /* non-URL page */ }
  const pathMatches = expected.targetTokens.every(token => pathTerms.has(token));
  if (expected.searchQuery) {
    const resultsState = changedLabels.some(label => /\b(?:search results?|results? for|no results)\b/i.test(label.text));
    return resultsState;
  }
  // A matching label on the starting page is not proof that navigation happened. A matching route
  // is sufficient when already there; an SPA can instead prove the goal through a changed title/heading.
  if (!(pathMatches || changedLabelsMatch)) return false;
  // Environment guard: a goal whose label tokens happen to match on an
  // unrelated origin is NOT a verified outcome. When an environment binding
  // is supplied, the goal must be satisfied on one of its authorized origins
  // (or already be there). This prevents a blind navigation step from
  // "succeeding" after wandering onto an unauthorized site.
  if (environment?.authorizedOrigins?.length) {
    const observed = normalizeOrigin(observation.page.url);
    if (observed && !environment.authorizedOrigins.includes(observed)) return false;
  }
  return true;
}

function handoffResult(goal, reason, authorizationRequired, attempts, recoveries, evidenceId) {
  return { status: "needs_human", goal, reason, authorizationRequired, attempts, recoveries, evidenceId };
}

function unchangedAfterFailedClick(attempt) {
  return attempt?.action === "click" && Boolean(attempt.error) &&
    (attempt.sameTargetRemained === true || attempt.observationUnavailable === true ||
      /^[a-f0-9]{64}$/.test(attempt.beforeStateFingerprint ?? "") && attempt.beforeStateFingerprint === attempt.afterStateFingerprint);
}

export class NavigationEngine {
  constructor(session, { planner = configuredPlanner(), journal, workflowStore, maxActions = 8, maxRecoveries = 1, maxScrolls = 5, signal, environment = null } = {}) {
    this.signal = signal;
    this.session = session;
    this.planner = planner;
    // Optional verified environment binding. When present, the engine refuses
    // to count a navigation onto a non-authorized origin as goal progress.
    this.environment = environment;
    this.journal = journal;
    this.workflowStore = workflowStore;
    this.maxActions = Math.max(1, Math.min(maxActions, 10));
    this.maxRecoveries = Math.max(0, Math.min(maxRecoveries, 3));
    this.maxScrolls = Math.max(0, Math.min(maxScrolls, 8));
  }

  async run(goal, { resumeState, signal } = {}) {
    const abortSignal = signal ?? this.signal;
    const throwIfAborted = () => {
      if (abortSignal?.aborted) {
        const error = new Error("The navigation run was canceled.");
        error.name = "AbortError";
        error.code = 20;
        throw error;
      }
    };
    throwIfAborted();
    const searchPhrase = searchPhraseFromGoal(goal);
    const state = resumeState ?? newTaskState(goal, this.session.target, this.session.target.endpoint ?? "local-cdp");
    const resumedHandoff = resumeState?.status === "needs_human" ? resumeState.interventionRequired : undefined;
    if (resumeState?.requiresGoalInput && !resumeState.goalFingerprint) {
      throw new Error("This legacy task journal redacts its goal without a fingerprint and cannot safely resume; start a new task.");
    }
    const resumeGoalMatches = resumeState?.goalFingerprint
      ? resumeState.goalFingerprint === taskGoalFingerprint(goal)
      : resumeState?.requiresGoalInput
        ? false
        : resumeState?.goal === goal;
    if (resumeState && (resumeState.targetId !== this.session.target.id || !resumeGoalMatches || (resumeState.endpoint && this.session.target.endpoint && resumeState.endpoint !== this.session.target.endpoint))) {
      throw new Error("Resume state goal fingerprint or target does not match the current authorized session.");
    }
    let latest = await this.session.observe();
    state.initialUrl ??= latest.page.url;
    state.initialUrlFingerprint ??= routeFingerprint(latest.page.url);
    state.initialPageLabelHashes ??= pageLabelHashes(latest);
    state.status = "running";
    if (this.journal) await updateTaskJournal(this.journal, state);
    let recoveries = state.recoveryCount ?? 0;
    let scrollActionsUsed = (state.attempts ?? []).filter(attempt => attempt.action === "scroll").length;
    // Track per-identity scroll convergence: { identity, matchingCandidateCount, scrollActionsUsed }
    const scrollConvergenceStates = new Map();
    const failedClicks = (state.attempts ?? []).filter(attempt => attempt.action === "click" && attempt.error);
    const failedTargets = (state.attempts ?? []).filter(attempt => attempt.error && attempt.action !== "scroll");
    const excludedIdentities = new Set(failedTargets.map(attempt => attempt.targetIdentity).filter(value => typeof value === "string" && value));
    const excludedTargetSignatures = failedClicks
      .filter(attempt => attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt))
      .map(attempt => attempt.targetSignature)
      .filter(Boolean);
    const excludedScrollIdentities = new Set((state.attempts ?? [])
      .filter(attempt => attempt.action === "scroll" && attempt.error && attempt.scrollProgressObserved !== true)
      .map(attempt => attempt.targetIdentity)
      .filter(value => typeof value === "string" && value));
    if (state.scrollRecoveryBlocked === true) {
      for (const target of latest.scrollTargets ?? []) excludedScrollIdentities.add(target.identity);
    }
    const excludeFailedAttempt = attempt => {
      if (!attempt?.error) return;
      if (attempt.action !== "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity) excludedIdentities.add(attempt.targetIdentity);
      if (attempt.action === "scroll" && typeof attempt.targetIdentity === "string" && attempt.targetIdentity && attempt.scrollProgressObserved !== true) excludedScrollIdentities.add(attempt.targetIdentity);
      if (attempt.action === "click" && (attempt.uncertainOutcome === true || unchangedAfterFailedClick(attempt)) && attempt.targetSignature) excludedTargetSignatures.push(attempt.targetSignature);
    };
    const recordFailedTargetPresence = (attempt, observation) => {
      if (attempt?.action !== "click" || !attempt.error) return;
      attempt.sameTargetRemained = (observation.candidates ?? []).some(candidate => candidate.identity === attempt.targetIdentity);
    };
    const workflowReplay = { status: this.workflowStore ? searchPhrase ? "skipped_form_input" : "miss" : "disabled", actions: 0 };
    const workflowTraceAttempts = [];
    let workflowTraceSafe = true;
    const planner = searchPhrase ? new DeterministicPlanner() : this.planner;

    const updateJournal = async () => { if (this.journal) await updateTaskJournal(this.journal, state); };
    const isAbortError = error => error?.name === "AbortError" || error?.code === 20;
    // Cancellation after input dispatch keeps the action uncertain: the
    // dispatch receipt exists but the outcome was never observed, so the
    // task can never be reported as a success and must not be replayed
    // blindly on resume.
    const canceledWithPendingAction = async attempt => {
      attempt.error ??= { name: "AbortError", message: "The navigation run was canceled after dispatch; the action outcome is unknown." };
      attempt.uncertainOutcome = true;
      attempt.canceled = true;
      attempt.completedAt = new Date().toISOString();
      if (attempt.action === "click") recordFailedTargetPresence(attempt, latest);
      finishAction(attempt);
      state.status = "canceled";
      state.terminationReason = "The run was canceled; the last dispatched action has an unknown outcome and is preserved as uncertain.";
      await updateJournal();
      return resultWithWorkflow({ status: "canceled", goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, uncertain: true, evidenceId: latest.evidenceId });
    };
    const canceledBeforeDispatch = async () => {
      state.status = "canceled";
      state.terminationReason = "The run was canceled before the pending action was dispatched; no browser input was sent.";
      await updateJournal();
      return resultWithWorkflow({ status: "canceled", goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    };
    const beginAction = async attempt => {
      state.pendingAction = attempt;
      await updateJournal();
    };
    const finishAction = attempt => {
      delete state.pendingAction;
      state.attempts.push(attempt);
    };
    const resultWithWorkflow = result => ({
      ...result,
      goal: "[redacted task goal]",
      ...(this.workflowStore ? { workflowReplay: { ...workflowReplay } } : {})
    });
    const stopAfterObservationLoss = async (attempt, error) => {
      const observationError = { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
      attempt.error ??= observationError;
      attempt.observationUnavailable = true;
      attempt.observationError = observationError;
      attempt.uncertainOutcome = true;
      attempt.completedAt = new Date().toISOString();
      finishAction(attempt);
      state.status = "unresolved";
      state.terminationReason = "The browser target or observation connection was lost after the action; no retry was attempted. Reattach and resume from fresh evidence.";
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: attempt.beforeEvidenceId });
    };
    const outcomeVerified = async () => {
      if (!hasVerifiedOutcome(latest, goal, state.initialPageLabelHashes, this.environment)) return false;
      return !searchPhrase || await this.session.verifySearchOutcome(searchPhrase);
    };
    const handoffIfNeeded = async observation => {
      const handoff = classifyHumanHandoff(observation);
      if (!handoff) return undefined;
      state.status = "needs_human";
      state.terminationReason = handoff.reason;
      state.interventionRequired = { category: handoff.category, evidenceId: observation.evidenceId };
      await updateJournal();
      return resultWithWorkflow({ status: "needs_human", goal, reason: handoff.reason, interventionRequired: state.interventionRequired, attempts: state.attempts.length, recoveries, evidenceId: observation.evidenceId });
    };
    const succeed = async () => {
      state.status = "succeeded";
      state.resultEvidenceId = latest.evidenceId;
      if (this.workflowStore && !searchPhrase && workflowReplay.status !== "replayed") {
        try {
          const saved = workflowTraceSafe && workflowTraceAttempts.length
            ? await this.workflowStore.record(goal, state.initialUrlFingerprint, workflowTraceAttempts)
            : false;
          if (saved) workflowReplay.status = workflowReplay.status === "repairing" ? "repaired-and-recorded" : "recorded";
          else if (workflowReplay.status === "repairing") {
            workflowReplay.status = "repaired-not-recorded";
            workflowReplay.reason = workflowTraceSafe
              ? "No complete successful action trace was available for persistence."
              : "A failed action changed observable state, so workflow persistence was skipped.";
          }
        } catch (error) {
          workflowReplay.persistenceError = String(error.message).slice(0, 200);
        }
      }
      await updateJournal();
      return resultWithWorkflow({ status: "succeeded", goal, evidenceId: latest.evidenceId, attempts: state.attempts.length, recoveries, page: latest.page });
    };

    let recoveredPendingAction = false;
    if (state.pendingAction) {
      const pending = state.pendingAction;
      const interrupted = {
        ...pending,
        error: { name: "InterruptedAction", message: "The process ended while the browser action outcome was unknown." },
        uncertainOutcome: true,
        afterStateFingerprint: observationStateFingerprint(latest),
        afterRouteFingerprint: routeFingerprint(latest.page.url),
        afterEvidenceId: latest.evidenceId,
        completedAt: new Date().toISOString()
      };
      if (pending.action === "click") recordFailedTargetPresence(interrupted, latest);
      if (pending.action === "scroll") {
        const currentTarget = (latest.scrollTargets ?? []).find(target => target.identity === pending.targetIdentity);
        const moved = Boolean(currentTarget && currentTarget.scrollTop > Number(pending.scrollTopBefore ?? 0) + 2);
        interrupted.scrollTopAfter = currentTarget?.scrollTop ?? null;
        interrupted.scrollProgressObserved = moved;
        scrollActionsUsed++;
        if (!moved) {
          state.scrollRecoveryBlocked = true;
          for (const target of latest.scrollTargets ?? []) excludedScrollIdentities.add(target.identity);
        }
      }
      finishAction(interrupted);
      excludeFailedAttempt(interrupted);
      await updateJournal();
      recoveredPendingAction = true;
    }

    const initialHandoff = await handoffIfNeeded(latest);
    if (initialHandoff) return initialHandoff;
    if (resumedHandoff) {
      state.interventionContinuation = {
        category: resumedHandoff.category,
        handoffEvidenceId: resumedHandoff.evidenceId,
        observedEvidenceId: latest.evidenceId,
        resumedAt: new Date().toISOString()
      };
      delete state.interventionRequired;
      await updateJournal();
    }
    if (await outcomeVerified()) return await succeed();
    if (recoveredPendingAction) {
      if (recoveries >= this.maxRecoveries) {
        state.status = "unresolved";
        state.terminationReason = "An interrupted action could not be verified and the configured recovery bound is exhausted.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      recoveries++;
      state.recoveryCount = recoveries;
      await updateJournal();
    }

    // Replay only verified traces. Each step resolves a fresh, visible candidate from the current observation.
    // Candidate identities, raw labels, form values, and URL query data are never stored in the workflow file.
    if (this.workflowStore && !resumeState && !searchPhrase) {
      const workflow = await this.workflowStore.find(goal, latest);
      if (workflow) {
        const scrollSteps = workflow.steps.filter(step => step.action === "scroll").length;
        if (workflow.steps.length <= this.maxActions - state.attempts.length && scrollSteps <= this.maxScrolls - scrollActionsUsed) {
          workflowReplay.status = "replaying";
          let stale = false;
          for (const step of workflow.steps) {
            if (routeFingerprint(latest.page.url) !== step.routeFingerprint) { stale = true; break; }
            if (step.action === "scroll") {
              const beforePositionFraction = latest.scrollTargets
                ?.filter(target => matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true)
                .map(scrollPositionFraction)
                .find(Number.isFinite);
              if (!scrollPositionMatches(beforePositionFraction, step.beforePositionFraction) ||
                  visibleCandidatesFingerprint(latest) !== step.beforeCandidatesFingerprint) { stale = true; break; }
              const scrollMatches = (latest.scrollTargets ?? []).filter(target =>
                matchesScrollTargetSignature(target, step.scrollTarget) && target.canScrollDown === true
              );
              if (scrollMatches.length !== 1) { stale = true; break; }
              const target = scrollMatches[0];
              const beforeStateFingerprint = observationStateFingerprint(latest);
              const waitBaseline = pageChangeWaitBaseline(latest, target);
              const attempt = {
                action: "scroll",
                targetIdentity: target.identity,
                scrollTopBefore: target.scrollTop,
                beforeStateFingerprint,
                beforeRouteFingerprint: routeFingerprint(latest.page.url),
                beforeEvidenceId: latest.evidenceId,
                startedAt: new Date().toISOString()
              };
              await beginAction(attempt);
              try {
                throwIfAborted();
                await this.session.scroll(target);
              }
              catch (error) {
                if (isAbortError(error)) return await canceledWithPendingAction(attempt);
                attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
              }
              try {
                await this.session.waitForChange(1_500, waitBaseline);
                latest = await this.session.observe();
              } catch (error) {
                workflowReplay.actions++;
                if (isAbortError(error)) return await canceledWithPendingAction(attempt);
                workflowReplay.status = "interrupted";
                return await stopAfterObservationLoss(attempt, error);
              }
              throwIfAborted();
              const afterStateFingerprint = observationStateFingerprint(latest);
              const afterScrollMatches = (latest.scrollTargets ?? []).filter(item => matchesScrollTargetSignature(item, step.scrollTarget));
              const afterTarget = afterScrollMatches.length === 1 ? afterScrollMatches[0] : undefined;
              const afterPositionFraction = scrollPositionFraction(afterTarget);
              const afterCandidatesFingerprint = visibleCandidatesFingerprint(latest);
              const moved = Boolean(afterTarget && afterTarget.scrollTop > Number(target.scrollTop ?? 0) + 2);
              attempt.afterStateFingerprint = afterStateFingerprint;
              attempt.scrollTopAfter = afterTarget?.scrollTop ?? null;
              attempt.scrollProgressObserved = moved;
              attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
              attempt.afterEvidenceId = latest.evidenceId;
              attempt.completedAt = new Date().toISOString();
              finishAction(attempt);
              workflowReplay.actions++;
              scrollActionsUsed++;
              excludeFailedAttempt(attempt);
              if (attempt.error || !moved) {
                workflowTraceSafe = false;
                if (!moved) {
                  state.scrollRecoveryBlocked = true;
                  for (const item of latest.scrollTargets ?? []) excludedScrollIdentities.add(item.identity);
                }
              }
              await updateJournal();
              const replayHandoff = await handoffIfNeeded(latest);
              if (replayHandoff) return replayHandoff;
              if (await outcomeVerified()) {
                workflowReplay.status = "replayed";
                return await succeed();
              }
              const afterMatchesTrace = !attempt.error && moved &&
                afterCandidatesFingerprint === step.afterCandidatesFingerprint &&
                scrollPositionMatches(afterPositionFraction, step.afterPositionFraction);
              if (!afterMatchesTrace) {
                workflowTraceSafe = false;
                stale = true;
                break;
              }
              workflowTraceAttempts.push({
                ...attempt,
                scrollTargetSignature: step.scrollTarget,
                beforePositionFraction: step.beforePositionFraction,
                afterPositionFraction,
                beforeCandidatesFingerprint: step.beforeCandidatesFingerprint,
                afterCandidatesFingerprint
              });
              continue;
            }
            const matches = latest.candidates.filter(candidate => matchesTargetSignature(candidate, step.target));
            if (matches.length !== 1) { stale = true; break; }
            const target = matches[0];
            const authorization = authorizePlannedAction(goal, target);
            if (!authorization.authorized) {
              state.status = "needs_human";
              state.terminationReason = authorization.reason;
              state.authorizationRequired = { category: authorization.category, targetIdentity: target.identity, evidenceId: latest.evidenceId };
              await updateJournal();
              return resultWithWorkflow(handoffResult(goal, state.terminationReason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId));
            }
            const beforeStateFingerprint = observationStateFingerprint(latest);
            const beforeSemanticFingerprint = observationSemanticFingerprint(latest);
            const waitBaseline = pageChangeWaitBaseline(latest);
            const attempt = {
              action: "click",
              targetIdentity: target.identity,
              targetSignature: targetSignature(target),
              beforeStateFingerprint,
              beforeRouteFingerprint: routeFingerprint(latest.page.url),
              beforeEvidenceId: latest.evidenceId,
              startedAt: new Date().toISOString()
            };
            await beginAction(attempt);
            try {
              throwIfAborted();
              await this.session.click(target);
            } catch (error) {
              if (isAbortError(error)) return await canceledWithPendingAction(attempt);
              attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
            }
            excludedIdentities.add(target.identity);
            try {
              await this.session.waitForChange(2_000, waitBaseline);
              latest = await this.session.observe();
            } catch (error) {
              workflowReplay.actions++;
              if (isAbortError(error)) return await canceledWithPendingAction(attempt);
              workflowReplay.status = "interrupted";
              return await stopAfterObservationLoss(attempt, error);
            }
            throwIfAborted();
            const afterStateFingerprint = observationStateFingerprint(latest);
            const afterSemanticFingerprint = observationSemanticFingerprint(latest);
            attempt.afterStateFingerprint = afterStateFingerprint;
            recordFailedTargetPresence(attempt, latest);
            excludeFailedAttempt(attempt);
            if (attempt.error) {
              if (afterSemanticFingerprint !== beforeSemanticFingerprint) workflowTraceSafe = false;
            } else if (afterStateFingerprint !== beforeStateFingerprint) {
              workflowTraceAttempts.push(attempt);
            }
            attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
            attempt.afterEvidenceId = latest.evidenceId;
            attempt.completedAt = new Date().toISOString();
            finishAction(attempt);
            workflowReplay.actions++;
            await updateJournal();
            const replayHandoff = await handoffIfNeeded(latest);
            if (replayHandoff) return replayHandoff;
            if (await outcomeVerified()) {
              workflowReplay.status = "replayed";
              return await succeed();
            }
            if (attempt.error || afterStateFingerprint === beforeStateFingerprint) { stale = true; break; }
          }
          if (workflowReplay.actions === workflow.steps.length && !await outcomeVerified()) stale = true;
          if (stale) {
            await this.workflowStore.invalidate(goal, state.initialUrlFingerprint);
            if (workflowReplay.actions > 0) {
              recoveries++;
              state.recoveryCount = recoveries;
              workflowReplay.status = "repairing";
              await updateJournal();
            } else workflowReplay.status = "stale";
          } else if (workflowReplay.actions === workflow.steps.length) {
            workflowReplay.status = "replayed";
            return await succeed();
          }
        } else workflowReplay.status = "budget-skipped";
      }
    }

    if (recoveries > this.maxRecoveries) {
      state.status = "unresolved";
      state.terminationReason = "Workflow replay failed and the configured recovery bound is exhausted.";
      await updateJournal();
      return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
    }

    while (state.attempts.length < this.maxActions) {
      if (await outcomeVerified()) return await succeed();
      const planningObservation = {
        ...latest,
        candidates: (latest.candidates ?? []).filter(candidate =>
          !excludedIdentities.has(candidate.identity) &&
          !excludedTargetSignatures.some(signature => matchesTargetSignature(candidate, signature))
        ),
        scrollTargets: (latest.scrollTargets ?? []).filter(target => !excludedScrollIdentities.has(target.identity))
      };
      let plan;
      try {
        const previousScrollStates = [...scrollConvergenceStates.entries()].map(([identity, data]) => ({
          identity,
          matchingCandidateCount: data.matchingCandidateCount,
          scrollActionsUsed: data.scrollActionsUsed
        }));
        plan = await planner.plan(goal, planningObservation, { excludedIdentities: [...excludedIdentities], excludedScrollIdentities: [...excludedScrollIdentities], maxScrolls: this.maxScrolls, scrollActionsUsed, previousScrollStates, signal: abortSignal });
      } catch (error) {
        if (isAbortError(error)) return await canceledBeforeDispatch();
        throw error;
      }
      try { throwIfAborted(); }
      catch (error) {
        if (isAbortError(error)) return await canceledBeforeDispatch();
        throw error;
      }
      if (plan.status !== "planned") {
        state.status = recoveries ? "needs_human" : "unresolved";
        state.terminationReason = plan.reason;
        await updateJournal();
        const observedCandidates = new Map((latest.candidates ?? []).map(candidate => [candidate.identity, candidate]));
        const resolutionCandidates = (plan.candidates ?? []).flatMap(candidate => {
          const observed = observedCandidates.get(candidate.identity);
          if (!observed || !Number.isInteger(observed.backendNodeId)) return [];
          return [{
            backendNodeId: observed.backendNodeId,
            ...(observed.frameTargetId ? { frameTargetId: observed.frameTargetId } : {}),
            tag: observed.tag,
            role: observed.role,
            name: observed.name,
            contextName: observed.contextName ?? null,
            bounds: observed.bounds ?? null
          }];
        });
        return resultWithWorkflow({
          status: state.status,
          goal,
          reason: plan.reason,
          attempts: state.attempts.length,
          recoveries,
          evidenceId: latest.evidenceId,
          ...(resolutionCandidates.length ? {
            targetResolution: {
              evidenceId: latest.evidenceId,
              candidates: resolutionCandidates,
              nextStep: "Inspect retained evidence for these candidates, then submit the selected backendNodeId to click_observed_element. ActiveTab will revalidate it against a fresh observation."
            }
          } : {})
        });
      }
      const actionType = plan.action.type ?? "click";
      const plannedIdentity = plan.action.target?.identity;
      let selectedTarget = actionType === "scroll"
        ? planningObservation.scrollTargets.find(target => target.identity === plannedIdentity)
        : planningObservation.candidates.find(candidate => candidate.identity === plannedIdentity);
      if (!selectedTarget || selectedTarget.visible !== true || (actionType !== "scroll" && selectedTarget.disabled === true)) {
        state.status = recoveries ? "needs_human" : "unresolved";
        state.terminationReason = "The planner selected a target that is not present and interactable in the fresh observation; no action was dispatched.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      const authorization = authorizePlannedAction(goal, selectedTarget, actionType);
      if (!authorization.authorized) {
        state.status = "needs_human";
        state.terminationReason = authorization.reason;
        state.authorizationRequired = {
          category: authorization.category,
          targetIdentity: selectedTarget.identity,
          evidenceId: latest.evidenceId
        };
        await updateJournal();
        return resultWithWorkflow(handoffResult(goal, state.terminationReason, state.authorizationRequired, state.attempts.length, recoveries, latest.evidenceId));
      }
      const beforeStateFingerprint = observationStateFingerprint(latest);
      const beforeSemanticFingerprint = observationSemanticFingerprint(latest);
      const waitBaseline = pageChangeWaitBaseline(latest, actionType === "scroll" ? selectedTarget : undefined);
      const scrollTraceContext = actionType === "scroll" && this.workflowStore ? {
        scrollTargetSignature: scrollTargetSignature(selectedTarget),
        beforePositionFraction: scrollPositionFraction(selectedTarget),
        beforeCandidatesFingerprint: visibleCandidatesFingerprint(latest)
      } : null;
      const attempt = {
        action: actionType,
        targetIdentity: selectedTarget.identity,
        ...(actionType === "scroll" ? { scrollTopBefore: selectedTarget.scrollTop } : { targetSignature: targetSignature(selectedTarget) }),
        beforeStateFingerprint,
        beforeRouteFingerprint: routeFingerprint(latest.page.url),
        beforeEvidenceId: latest.evidenceId,
        startedAt: new Date().toISOString()
      };
      await beginAction(attempt);
      let dispatchOutcome = "dispatched";
      try {
        throwIfAborted(); // canceled before dispatch: no browser input was sent
        if (actionType === "type") await this.session.typeSearchPhrase(selectedTarget, plan.action.value);
        else if (actionType === "click") await this.session.click(selectedTarget);
        else if (actionType === "fill") await this.session.fillField(selectedTarget, plan.action.value ?? "");
        else if (actionType === "select") await this.session.selectOption(selectedTarget, plan.action.value ?? "");
        else if (actionType === "toggle") await this.session.click(selectedTarget); // checkbox/radio toggles via click
        else if (actionType === "upload") await this.session.uploadFile(selectedTarget, plan.action.filePaths ?? []);
        else if (actionType === "scroll" && plan.action.direction === "down") await this.session.scroll(selectedTarget);
        else throw new Error("Unsupported browser action.");
        if (actionType !== "scroll") excludedIdentities.add(selectedTarget.identity);
      } catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        // Stale element recovery: if the failure is specifically a staleness
        // error and recovery budget allows, reobserve and retry once with a
        // freshly resolved target. Do not count this against maxRecoveries.
        const isStaleError = /stale|no longer exists|no longer visible|changed since observation/.test(String(error?.message ?? ""));
        if (isStaleError && !attempt.retriedAfterStale && recoveries <= this.maxRecoveries) {
          attempt.retriedAfterStale = true;
          const freshObservation = await this.session.observe();
          const freshMatches = (freshObservation.candidates ?? []).filter(candidate =>
            candidate.visible === true && candidate.disabled !== true &&
            (candidate.name === selectedTarget.name || candidate.identity === selectedTarget.identity)
          );
          if (freshMatches.length === 1) {
            selectedTarget = freshMatches[0];
            excludedIdentities.delete(selectedTarget.identity);
            try {
              throwIfAborted();
              if (actionType === "type") await this.session.typeSearchPhrase(selectedTarget, plan.action.value);
              else if (actionType === "click") await this.session.click(selectedTarget);
              else if (actionType === "fill") await this.session.fillField(selectedTarget, plan.action.value ?? "");
              else if (actionType === "select") await this.session.selectOption(selectedTarget, plan.action.value ?? "");
              else if (actionType === "toggle") await this.session.click(selectedTarget);
              else if (actionType === "scroll" && plan.action.direction === "down") await this.session.scroll(selectedTarget);
              else throw new Error("Unsupported browser action.");
              dispatchOutcome = "dispatched";
              delete attempt.error;
              attempt.recoveredFromStale = true;
            } catch (retryError) {
              if (isAbortError(retryError)) return await canceledWithPendingAction(attempt);
              dispatchOutcome = "failed";
              attempt.error = { name: retryError.name, message: String(retryError.message).slice(0, 400) };
            }
          } else {
            dispatchOutcome = "failed";
            attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
          }
        } else {
          dispatchOutcome = "failed";
          attempt.error = { name: error.name, message: String(error.message).slice(0, 400) };
        }
        excludedIdentities.add(selectedTarget.identity);
      }
      try {
        await this.session.waitForChange(actionType === "type" ? 500 : actionType === "scroll" ? 1_500 : 2_000, waitBaseline);
        latest = await this.session.observe();
      } catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        return await stopAfterObservationLoss(attempt, error);
      }
      try { throwIfAborted(); }
      catch (error) {
        if (isAbortError(error)) return await canceledWithPendingAction(attempt);
        throw error;
      }
      const afterStateFingerprint = observationStateFingerprint(latest);
      const afterSemanticFingerprint = observationSemanticFingerprint(latest);
      attempt.afterStateFingerprint = afterStateFingerprint;
      if (dispatchOutcome === "dispatched") attempt.dispatched = true;
      recordFailedTargetPresence(attempt, latest);
      excludeFailedAttempt(attempt);
      if (actionType === "scroll") {
        scrollActionsUsed++;
        // Record convergence state for infinite-scroll detection.
        if (attempt.scrollProgressObserved === true) {
          const scrollIdentity = selectedTarget.identity;
          const candidateTexts = (latest.candidates ?? []).filter(c => c.visible === true).map(c => c.name ?? "");
          const matchingCount = candidateTexts.filter(text =>
            goalExpectation(goal).targetTokens.some(token => text.toLowerCase().includes(token))
          ).length;
          const previous = scrollConvergenceStates.get(scrollIdentity);
          scrollConvergenceStates.set(scrollIdentity, {
            matchingCandidateCount: matchingCount,
            scrollActionsUsed: scrollActionsUsed,
            previousMatchingCandidateCount: previous?.matchingCandidateCount ?? -1
          });
        }
        const observedScrollMatches = (latest.scrollTargets ?? []).filter(target =>
          scrollTraceContext?.scrollTargetSignature && matchesScrollTargetSignature(target, scrollTraceContext.scrollTargetSignature)
        );
        const movedTarget = observedScrollMatches.length === 1
          ? observedScrollMatches[0]
          : latest.scrollTargets?.find(target => target.identity === selectedTarget.identity);
        const moved = Boolean(movedTarget && movedTarget.scrollTop > Number(selectedTarget.scrollTop ?? 0) + 2);
        attempt.scrollTopAfter = movedTarget?.scrollTop ?? null;
        attempt.scrollProgressObserved = moved;
        attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
        attempt.afterEvidenceId = latest.evidenceId;
        attempt.completedAt = new Date().toISOString();
        finishAction(attempt);
        if (this.workflowStore && !attempt.error && moved && scrollTraceContext?.scrollTargetSignature && Number.isFinite(scrollTraceContext.beforePositionFraction)) {
          const matchingAfterTargets = (latest.scrollTargets ?? []).filter(target => matchesScrollTargetSignature(target, scrollTraceContext.scrollTargetSignature));
          const afterTarget = matchingAfterTargets.length === 1 ? matchingAfterTargets[0] : undefined;
          const afterPositionFraction = scrollPositionFraction(afterTarget);
          const afterCandidatesFingerprint = visibleCandidatesFingerprint(latest);
          if (afterTarget && Number.isFinite(afterPositionFraction) && afterPositionFraction > scrollTraceContext.beforePositionFraction) {
            Object.assign(attempt, {
              scrollTargetSignature: scrollTraceContext.scrollTargetSignature,
              beforePositionFraction: scrollTraceContext.beforePositionFraction,
              afterPositionFraction,
              beforeCandidatesFingerprint: scrollTraceContext.beforeCandidatesFingerprint,
              afterCandidatesFingerprint
            });
            workflowTraceAttempts.push(attempt);
          } else {
            workflowTraceSafe = false;
            workflowReplay.status = "skipped_scroll";
            workflowReplay.reason = "The scroll transition could not be tied to one fresh region and position; it was not saved for replay.";
          }
        } else if (this.workflowStore) {
          workflowTraceSafe = false;
          workflowReplay.status = "skipped_scroll";
          workflowReplay.reason = "The scroll transition did not produce enough fresh evidence to validate replay.";
        }
        await updateJournal();
        const scrollHandoff = await handoffIfNeeded(latest);
        if (scrollHandoff) return scrollHandoff;
        if (await outcomeVerified()) return await succeed();
        if (attempt.error || !moved) {
          if (!moved) state.scrollRecoveryBlocked = true;
          state.status = "unresolved";
          state.terminationReason = attempt.error
            ? "Native scrolling failed; no repeat was attempted. Observe the current page and continue with a fresh plan."
            : "The selected scroll region did not move; no repeat was attempted. Observe the current page and choose another region.";
          await updateJournal();
          return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
        }
        continue;
      }
      // Off-environment navigation guard: a click that carries the page onto
      // an origin not authorized by the environment binding is a misstep,
      // never goal progress. Record it, navigate back to the authorized
      // page, exclude the offending candidate, and recover.
      if (actionType === "click" && !attempt.error && this.environment?.authorizedOrigins?.length && typeof this.session.client?.send === "function") {
        const observed = normalizeOrigin(latest.page.url);
        if (observed && !this.environment.authorizedOrigins.includes(observed)) {
          attempt.error = {
            name: "OffEnvironmentNavigation",
            message: `Click navigated to non-authorized origin '${observed}'; returned to the authorized environment page.`
          };
          attempt.recoveredOffEnvironment = true;
          excludedIdentities.add(selectedTarget.identity);
          if (workflowTraceSafe) workflowTraceSafe = false;
          try {
            await this.session.client.send("Page.navigate", { url: state.initialUrl ?? "" });
            await this.session.waitForChange(2_500, waitBaseline).catch(() => {});
            latest = await this.session.observe();
          } catch (error) {
            if (isAbortError(error)) return await canceledWithPendingAction(attempt);
            return await stopAfterObservationLoss(attempt, error);
          }
        }
      }
      if (attempt.error) {
        if (afterSemanticFingerprint !== beforeSemanticFingerprint) workflowTraceSafe = false;
      } else if (afterStateFingerprint !== beforeStateFingerprint) {
        workflowTraceAttempts.push(attempt);
      }
      attempt.afterRouteFingerprint = routeFingerprint(latest.page.url);
      attempt.afterEvidenceId = latest.evidenceId;
      attempt.completedAt = new Date().toISOString();
      finishAction(attempt);
      await updateJournal();
      const actionHandoff = await handoffIfNeeded(latest);
      if (actionHandoff) return actionHandoff;
      if (await outcomeVerified()) return await succeed();
      if (actionType === "type") {
        if (attempt.error) {
          state.status = "unresolved";
          state.terminationReason = "Search text entry failed; no sensitive input was saved. Resume with a fresh authorized observation.";
          await updateJournal();
          return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
        }
        continue;
      }
      if (recoveries >= this.maxRecoveries) {
        state.status = "unresolved";
        state.terminationReason = "Outcome was not verified within the configured recovery bound.";
        await updateJournal();
        return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
      }
      recoveries++;
      state.recoveryCount = recoveries;
      if (this.workflowStore && workflowReplay.status === "repairing") workflowReplay.status = "repairing";
      await updateJournal();
      // Reobserve and replan; never repeat the stale element identity.
    }
    state.status = "unresolved";
    state.terminationReason = "Action budget exhausted before the requested outcome was verified.";
    await updateJournal();
    return resultWithWorkflow({ status: state.status, goal, reason: state.terminationReason, attempts: state.attempts.length, recoveries, evidenceId: latest.evidenceId });
  }
}
