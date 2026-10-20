/** Build intervention-family handlers from server-owned tools and authenticators. */
export function createInterventionRoutes({
  authorizeMutation,
  authenticateOperator,
  interventionTools,
  readBody,
  sendJson,
  sendError
} = {}) {
  return async function handleInterventionRoute(req, res, { method, path, query = {} } = {}) {
    if (path !== "/v1/interventions" && !path.startsWith("/v1/interventions/")) return false;

    const resolveMatch = path.match(/^\/v1\/interventions\/([^/]+)\/resolve$/);
    if (method === "POST" && resolveMatch) {
      const authenticatedOperator = await authenticateOperator(req);
      if (!authenticatedOperator) { sendError(res, 403, 99403, "Independent operator authentication required."); return true; }
      const body = await readBody(req) ?? {};
      if (typeof body !== "object" || Array.isArray(body)) { sendError(res, 400, 99001, "Approval resolution must be a JSON object."); return true; }
      if (Object.hasOwn(body, "authenticatedOperator")) { sendError(res, 400, 99001, "Operator identity is derived from the authenticated operator session."); return true; }
      if (body.decision !== undefined && !["approve", "reject"].includes(body.decision)) { sendError(res, 400, 99001, "decision must be approve or reject."); return true; }
      if (!Number.isInteger(body.expectedRevision)) { sendError(res, 400, 99001, "expectedRevision is required."); return true; }
      try {
        sendJson(res, 200, await interventionTools.resolve_operation_approval({
          interventionId: decodeURIComponent(resolveMatch[1]),
          authenticatedOperator,
          decision: body.decision ?? "approve",
          expectedRevision: body.expectedRevision
        }));
      } catch (error) {
        sendError(res, 409, 99409, String(error?.message ?? error).slice(0, 300));
      }
      return true;
    }

    if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
    try {
      if (method === "GET" && path === "/v1/interventions") {
        sendJson(res, 200, await interventionTools.list_pending_interventions());
        return true;
      }
      const interventionMatch = path.match(/^\/v1\/interventions\/([^/]+)(?:\/(acknowledge|approve|reject|resume|cancel))?$/);
      if (interventionMatch) {
        const interventionId = interventionMatch[1];
        const action = interventionMatch[2] ?? "get";
        if (method === "GET" && action === "get") { sendJson(res, 200, await interventionTools.get_pending_intervention({ interventionId })); return true; }
        if (method === "POST" && action === "acknowledge") { const body = await readBody(req); sendJson(res, 200, await interventionTools.acknowledge_human_action({ interventionId, ...(body ?? {}) })); return true; }
        if (method === "POST" && action === "approve") { const body = await readBody(req); sendJson(res, 200, await interventionTools.request_operation_approval({ interventionId, ...(body ?? {}) })); return true; }
        if (method === "POST" && action === "reject") { const body = await readBody(req); sendJson(res, 200, await interventionTools.reject_operation({ interventionId, ...(body ?? {}) })); return true; }
        if (method === "POST" && action === "resume") { sendJson(res, 200, await interventionTools.resume_run({ interventionId })); return true; }
        if (method === "POST" && action === "cancel") { sendJson(res, 200, await interventionTools.cancel_run({ interventionId })); return true; }
      }
      if (method === "GET" && path === "/v1/interventions/run-state") {
        sendJson(res, 200, await interventionTools.get_run_state({ runId: query.runId ?? "" }));
        return true;
      }
      sendError(res, 404, 99404, "No such intervention resource.");
    } catch (error) {
      sendError(res, 400, 99400, String(error?.message ?? error).slice(0, 300));
    }
    return true;
  };
}
