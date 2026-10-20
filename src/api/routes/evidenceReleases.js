/** Build evidence-release handlers from server-owned store and operator auth. */
export function createEvidenceReleaseRoutes({
  authenticateOperator,
  getEvidenceReleaseStore,
  readBody,
  sendJson,
  sendError
} = {}) {
  return async function handleEvidenceReleaseRoute(req, res, { method, path, query = {} } = {}) {
    if (path !== "/v1/evidence/releases/requests" && path !== "/v1/evidence/releases/audit"
      && !path.startsWith("/v1/evidence/releases/requests/") && !path.startsWith("/v1/evidence/releases/grants/")) return false;

    const authenticatedOperator = await authenticateOperator(req);
    if (!authenticatedOperator) { sendError(res, 403, 99403, "Independent operator authentication required."); return true; }
    const releaseStore = getEvidenceReleaseStore();
    try {
      if (method === "GET" && path === "/v1/evidence/releases/requests") {
        sendJson(res, 200, { requests: releaseStore.listRequests({ states: ["pending", "approved", "rejected", "expired"] }) });
        return true;
      }
      if (method === "GET" && path === "/v1/evidence/releases/audit") {
        sendJson(res, 200, { events: releaseStore.audit({ limit: Math.min(Number.parseInt(query.limit ?? "200", 10) || 200, 1_000) }) });
        return true;
      }
      const requestMatch = path.match(/^\/v1\/evidence\/releases\/requests\/([^/]+)\/(approve|reject)$/u);
      if (method === "POST" && requestMatch) {
        const body = await readBody(req) ?? {};
        if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "expectedRevision")
          || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
          sendError(res, 400, 99001, "expectedRevision is required; request scope is fixed and cannot be changed during review.");
          return true;
        }
        const requestId = decodeURIComponent(requestMatch[1]);
        if (requestMatch[2] === "approve") {
          sendJson(res, 200, releaseStore.approveRequest(requestId, { operatorId: authenticatedOperator, expectedRevision: body.expectedRevision }));
        } else {
          sendJson(res, 200, releaseStore.rejectRequest(requestId, { operatorId: authenticatedOperator, expectedRevision: body.expectedRevision }));
        }
        return true;
      }
      const grantMatch = path.match(/^\/v1\/evidence\/releases\/grants\/([^/]+)\/revoke$/u);
      if (method === "POST" && grantMatch) {
        const body = await readBody(req) ?? {};
        if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
          sendError(res, 400, 99001, "Grant revocation takes no caller-supplied scope.");
          return true;
        }
        sendJson(res, 200, releaseStore.revokeGrant(decodeURIComponent(grantMatch[1]), { operatorId: authenticatedOperator }));
        return true;
      }
      sendError(res, 404, 99404, "No such evidence-release resource.");
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 300);
      sendError(res, /not found/u.test(message) ? 404 : /revision changed|already|expired/u.test(message) ? 409 : 400,
        /not found/u.test(message) ? 99404 : /revision changed|already|expired/u.test(message) ? 99409 : 99400, message);
    }
    return true;
  };
}
