import { randomUUID } from "node:crypto";
import { DiagnosticCorrelator } from "../../diagnostics/correlator.js";
import { ApplicationDiscoveryEngine } from "../../discovery/engine.js";
import { InvestigationEngine } from "../../investigation/engine.js";
import { withTargetExecutionLease } from "../../testing/runState.js";

/** Build discovery-family handlers from server-owned dependencies. */
export function createDiscoveryRoutes({
  authorizeMutation,
  readBody,
  sendJson,
  sendError,
  testSessionResolver,
  ensureRunStateStore,
  runStateStore,
  decisionRuntime,
  discoveryEnvironment,
  discoveryPrincipalId,
  configuredKnowledgeDir,
  acquireTargetLease = withTargetExecutionLease
}) {
  return async function handleDiscoveryRoute(req, res, { method, path }) {
    if (method === "POST" && path === "/v1/discover") {
      if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
      const body = await readBody(req);
      let session = null;
      if (typeof testSessionResolver === "function") {
        try { session = await testSessionResolver({ input: body ?? {} }); } catch { session = null; }
      }
      if (!session) { sendError(res, 400, 99002, "A browser session is required for discovery."); return true; }
      await ensureRunStateStore();
      const result = await acquireTargetLease(runStateStore, session, `api-discovery-${randomUUID()}`, async lease => {
        const engine = new ApplicationDiscoveryEngine({
          session,
          maxSteps: body?.maxSteps ?? 8,
          maxLinksPerStep: body?.maxLinksPerStep ?? 4,
          decisionRuntime,
          environment: discoveryEnvironment,
          principalId: discoveryPrincipalId,
          assertExecutionLease: lease.assertCurrent,
          knowledgeDir: configuredKnowledgeDir
        });
        return await engine.discover();
      });
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && path === "/v1/investigate") {
      if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
      const body = await readBody(req);
      if (!body?.subject || !body?.reason) { sendError(res, 400, 99001, "subject and reason are required."); return true; }
      await ensureRunStateStore();
      const engine = new InvestigationEngine({ collector: null, correlator: new DiagnosticCorrelator(), runStateStore });
      const result = await engine.investigate({
        subject: body.subject,
        reason: body.reason,
        runId: body.runId ?? null,
        stepId: body.stepId ?? null,
        operationId: body.operationId ?? null
      });
      sendJson(res, 200, result);
      return true;
    }

    return false;
  };
}
