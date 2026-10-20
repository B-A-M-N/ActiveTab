import { randomUUID } from "node:crypto";
import { listTargets, resolveAuthorizedTarget } from "../browser/targets.js";
import { BrowserSession } from "../browser/session.js";
import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "../browser/chrome-autoconnect.js";
import { clickObservedElement } from "../navigation/observedAction.js";
import { withTargetExecutionLease } from "../testing/runState.js";
import { assertRedactedEvidenceOnly } from "../diagnostics/evidenceReleasePolicy.js";
import { selectBrowserSession } from "./session-selection.js";

/**
 * Build browser-facing MCP handlers from trusted server composition.
 * Tool arguments select evidence and already-authorized targets; they never
 * provide a session, execution lease, decision runtime, or attachment grant.
 */
export function createBrowserToolHandlers({
  sessions,
  endpoint,
  autoConnect,
  extensionMode,
  extensionBroker,
  runStateStore,
  decisionRuntime
}) {
  let chromeConnection;

  const handlers = Object.freeze({
    list_tabs: async () => {
      if (extensionMode) return await extensionBroker.listTabs();
      if (!autoConnect) return await listTargets(endpoint);
      chromeConnection ??= await connectChromeAuto();
      return await listChromeTargets(chromeConnection);
    },

    attach_tab: async args => {
      const existing = sessions.get(args.targetId);
      if (existing?.attached) return { status: "attached", targetId: existing.target.id, url: existing.target.url };
      if (existing) {
        sessions.delete(args.targetId);
        await existing.close();
      }
      let target;
      if (extensionMode) {
        target = await extensionBroker.resolveTarget(args.targetId);
      } else if (autoConnect) {
        chromeConnection ??= await connectChromeAuto();
        target = await resolveChromeTarget(chromeConnection, args.targetId, process.env.ACTIVETAB_AUTHORIZED_TARGET_ID);
      } else {
        target = await resolveAuthorizedTarget(endpoint, args.targetId, process.env.ACTIVETAB_AUTHORIZED_TARGET_ID);
      }
      const session = await new BrowserSession(target).attach();
      sessions.set(target.id, session);
      return { status: "attached", targetId: target.id, url: target.url };
    },

    detach_tab: async args => {
      const session = sessions.get(args.targetId);
      if (!session) throw new Error("No explicitly authorized tab is attached for that targetId.");
      sessions.delete(args.targetId);
      try { await session.close(); }
      finally { if (extensionMode) await extensionBroker.detach(args.targetId); }
      return { status: "detached", targetId: args.targetId };
    },

    observe_page: async args => {
      assertRedactedEvidenceOnly(args, ["includeScreenshot"]);
      const session = selectBrowserSession(sessions, args.targetId);
      if (args.profile === "visual") return await session.observe({ profile: "visual" });
      return await session.observe({ profile: args.profile ?? "interaction", includeScreenshot: false });
    },

    get_evidence: async args => {
      assertRedactedEvidenceOnly(args, ["includeSensitiveFormValues", "includeSensitivePageText", "includeSensitiveUrlData", "includeSensitiveRuntimeValues", "includeScreenshot"]);
      const session = selectBrowserSession(sessions, args.targetId);
      return session.observer.getEvidence(args.evidenceId, {
        facets: args.facets,
        backendNodeId: args.backendNodeId,
        frameTargetId: args.frameTargetId,
        includeScreenshot: false
      });
    },

    inspect_runtime_state: async args => {
      assertRedactedEvidenceOnly(args, ["includeSensitiveValues"]);
      const session = selectBrowserSession(sessions, args.targetId);
      return await session.observer.inspectRuntimeState(args.evidenceId, {
        path: args.path,
        frameTargetId: args.frameTargetId ?? null,
        includeSensitiveValues: false
      });
    },

    click_observed_element: async args => {
      const session = selectBrowserSession(sessions, args.targetId);
      return await withTargetExecutionLease(runStateStore, session, `mcp-observed-click-${randomUUID()}`, async lease =>
        await clickObservedElement(session, {
          goal: args.goal,
          evidenceId: args.evidenceId,
          backendNodeId: args.backendNodeId,
          frameTargetId: args.frameTargetId ?? null,
          decisionRuntime,
          assertExecutionLease: lease.assertCurrent
        }));
    },

    inspect_network_response: async args => {
      assertRedactedEvidenceOnly(args, ["includeSensitive", "includeSensitiveUrlData"]);
      const session = selectBrowserSession(sessions, args.targetId);
      return await session.observer.inspectNetworkResponse(args.evidenceId, {
        requestId: args.requestId,
        // Retrieval is local and selected by exact evidence and request IDs.
        // The observer returns a content-aware projection with credentials redacted.
        includeSensitive: true,
        includeCredentialValues: false,
        includeSensitiveUrlData: false,
        view: args.view ?? "markdown",
        offset: args.offset ?? 0,
        maxBytes: args.maxBytes ?? 32 * 1024,
        ...(args.sectionId !== undefined ? { sectionId: args.sectionId } : {}),
        ...(args.blockId !== undefined ? { blockId: args.blockId } : {})
      });
    }
  });
  return Object.freeze({
    handlers,
    close: async () => await chromeConnection?.close()
  });
}
