import { randomUUID } from "node:crypto";
import { NavigationEngine } from "./engine.js";
import { DiagnosticCollector } from "../diagnostics/collector.js";
import { DiagnosticCorrelator } from "../diagnostics/correlator.js";
import { registerBrowserDiagnosticSources } from "../diagnostics/adapters/browserSources.js";
import { TestRunner } from "../testing/runner.js";
import { withTargetExecutionLease } from "../testing/runState.js";
import { createAuthorizedSameTargetReattacher, supportsAuthorizedSameTargetReattachment } from "../browser/targetReattachment.js";

/** Shared authorized execution service used by the HTTP and MCP adapters. */
export class ApplicationRunService {
  constructor({ runStateStore } = {}) {
    if (!runStateStore || typeof runStateStore.acquireTargetLease !== "function") {
      throw new Error("ApplicationRunService requires a durable RunStateStore.");
    }
    this.runStateStore = runStateStore;
  }

  /** Keep task preparation and execution under one exclusive target lease. */
  async withTargetLease(session, leaseOwner, callback) {
    if (typeof callback !== "function") throw new Error("ApplicationRunService requires a leased callback.");
    const owner = leaseOwner ?? `application-run-${randomUUID()}`;
    return await withTargetExecutionLease(this.runStateStore, session, owner, lease => {
      let invoked = false;
      const runNavigation = options => {
        if (invoked) throw new Error("A leased application run may invoke one navigation task.");
        invoked = true;
        return this.#runNavigation(session, lease, options);
      };
      return callback(Object.freeze({ runNavigation }));
    });
  }

  async runNavigation({ session, leaseOwner, ...options } = {}) {
    return await this.withTargetLease(session, leaseOwner, ({ runNavigation }) => runNavigation(options));
  }

  /** Start or resume a declarative workflow using the shared run composition. */
  startWorkflowRun({
    session,
    workflow,
    runId,
    signal,
    runnerOptions = {},
    resumeReceipt = null,
    resumeOptions = {}
  } = {}) {
    if (session?.attached !== true || !session.target?.id) {
      throw new Error("ApplicationRunService requires an attached, explicitly selected browser target.");
    }
    const effectiveRunId = runId ?? `workflow-${randomUUID()}`;
    const collector = new DiagnosticCollector({ runId: effectiveRunId });
    registerBrowserDiagnosticSources(session, collector);
    const correlator = new DiagnosticCorrelator();
    const runner = new TestRunner({
      ...runnerOptions,
      session,
      collector,
      correlator,
      signal,
      runStateStore: this.runStateStore
    });
    const runPromise = resumeReceipt
      ? runner.resume(resumeReceipt, resumeOptions)
      : runner.run(workflow, { runId: effectiveRunId });
    return { runId: effectiveRunId, collector, correlator, runner, runPromise };
  }

  async #runNavigation(session, lease, {
    goal,
    journal,
    resumeState,
    workflowIntent = null,
    inputBindings = {},
    workflowInputs = inputBindings,
    signal,
    engineOptions = {}
  } = {}) {
    if (session?.attached !== true || !session.target?.id) {
      throw new Error("ApplicationRunService requires an attached, explicitly selected browser target.");
    }
    if (typeof goal !== "string" || !goal.trim()) throw new Error("ApplicationRunService requires a non-empty task goal.");
    const reattachedSessions = new Set();
    const reattachSameTarget = supportsAuthorizedSameTargetReattachment(session)
      ? createAuthorizedSameTargetReattacher({
        session,
        environment: engineOptions.environment ?? null,
        assertLeaseTokenCurrent: lease.assertLeaseTokenCurrent,
        bindSession: lease.bindSession,
        onSessionCreated: nextSession => reattachedSessions.add(nextSession)
      })
      : null;
    const engine = new NavigationEngine(session, {
      ...engineOptions,
      reattachSameTarget,
      signal,
      journal,
      workflowIntent,
      assertExecutionLease: lease.assertCurrent
    });
    try {
      return await engine.run(goal, { ...(resumeState ? { resumeState } : {}), signal, workflowIntent, inputBindings, workflowInputs });
    } finally {
      for (const replacement of reattachedSessions) await replacement.close().catch(() => {});
    }
  }
}
