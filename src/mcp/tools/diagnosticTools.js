import { DiagnosticCorrelator } from "../../diagnostics/correlator.js";
import { OPERATION } from "../../diagnostics/contracts.js";
import { InvestigationEngine } from "../../investigation/engine.js";
import { selectBrowserSession } from "../session-selection.js";

/** Read-only MCP diagnostics bound to server-owned runs and attached sessions. */
export function createDiagnosticToolHandlers({ testRuns, sessions, runStateStore }) {
  return Object.freeze({
    collect_diagnostics: async args => {
      const run = testRuns.get(args.runId);
      if (!run) throw new Error(`No test run found for runId '${args.runId}'.`);
      const results = await run.collector.collectAll([
        { sourceId: "browser-network", operation: OPERATION.READ },
        { sourceId: "browser-lifecycle", operation: OPERATION.READ }
      ]);
      return { runId: args.runId, results };
    },

    investigate_failure: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      const run = args.runId ? testRuns.get(args.runId) : null;
      const collector = run?.collector ?? null;
      const correlator = run?.correlator ?? new DiagnosticCorrelator();
      const engine = new InvestigationEngine({ collector, correlator, session, runStateStore });
      return await engine.investigate({
        subject: args.subject,
        reason: args.reason,
        runId: args.runId ?? null,
        stepId: args.stepId ?? null,
        operationId: args.operationId ?? null
      });
    }
  });
}
