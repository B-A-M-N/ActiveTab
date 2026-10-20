import { randomUUID } from "node:crypto";
import { ApplicationDiscoveryEngine } from "../../discovery/engine.js";
import { withTargetExecutionLease } from "../../testing/runState.js";
import { selectBrowserSession } from "../session-selection.js";
import { runMcpGoal } from "../runGoal.js";

/** Navigation entrypoints over the shared run service and trusted run state. */
export function createNavigationToolHandlers({
  sessions,
  principalId,
  loadEnvironmentProfile,
  taskJournalStore,
  workflowStore,
  decisionRuntime,
  capabilityRegistry,
  capabilityService,
  authorizeExtractionField,
  authorizeExtractionRelease,
  runStateStore
}) {
  return Object.freeze({
    read_page_records: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      const loaded = await loadEnvironmentProfile(args.profileId);
      return await capabilityService.readObservedRecords({
        session,
        environment: loaded?.environment ?? null,
        principalId,
        ...(args.candidateId ? { candidateId: args.candidateId } : {}),
        requestedFields: args.fields,
        maxRecords: args.maxRecords ?? 100,
        uniqueBy: args.uniqueBy ?? []
      });
    },

    discover_application: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      return await withTargetExecutionLease(runStateStore, session, `mcp-discovery-${randomUUID()}`, async lease => {
        const engine = new ApplicationDiscoveryEngine({
          session,
          maxSteps: args.maxSteps ?? 8,
          maxLinksPerStep: args.maxLinksPerStep ?? 4,
          decisionRuntime,
          assertExecutionLease: lease.assertCurrent
        });
        return await engine.discover();
      });
    },

    run_goal: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      const selectedProfile = await loadEnvironmentProfile(args.profileId);
      return await runMcpGoal(session, args, {
        journalStore: taskJournalStore,
        workflowStore,
        decisionRuntime,
        environment: selectedProfile?.environment ?? null,
        capabilityRegistry,
        capabilityService,
        authorizeExtractionField,
        authorizeExtractionRelease,
        runStateStore
      });
    }
  });
}
