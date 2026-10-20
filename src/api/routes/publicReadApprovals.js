/** Build public-read approval handlers from server-owned broker and authenticators. */
export function createPublicReadApprovalRoutes({
  publicReadApprovalBroker,
  authorizeMutation,
  authenticateOperator,
  readBody,
  sendJson,
  sendError
} = {}) {
  return async function handlePublicReadApprovalRoute(req, res, { method, path } = {}) {
    if (path !== "/v1/public-reads/requests" && !path.startsWith("/v1/public-reads/requests/")) return false;
    if (!publicReadApprovalBroker) { sendError(res, 503, 99503, "public_read_approval_unavailable"); return true; }

    if (method === "POST" && path === "/v1/public-reads/requests") {
      if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
      const body = await readBody(req);
      try {
        const request = publicReadApprovalBroker.create(body);
        sendJson(res, 202, { requestId: request.requestId, revision: request.revision, status: request.status, expiresAt: request.expiresAt });
      } catch (error) { sendError(res, 400, 99001, String(error?.message ?? error).slice(0, 300)); }
      return true;
    }
    if (method === "GET" && path === "/v1/public-reads/requests") {
      const authenticatedOperator = await authenticateOperator(req);
      if (!authenticatedOperator) { sendError(res, 403, 99403, "Independent operator authentication required."); return true; }
      sendJson(res, 200, { requests: publicReadApprovalBroker.listPending() });
      return true;
    }
    const statusMatch = path.match(/^\/v1\/public-reads\/requests\/([^/]+)\/status$/u);
    if (method === "GET" && statusMatch) {
      if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
      const request = publicReadApprovalBroker.get(decodeURIComponent(statusMatch[1]));
      if (!request) { sendError(res, 404, 99404, "Public-read approval request was not found."); return true; }
      sendJson(res, 200, { requestId: request.requestId, revision: request.revision, status: request.status, expiresAt: request.expiresAt });
      return true;
    }
    const decisionMatch = path.match(/^\/v1\/public-reads\/requests\/([^/]+)\/(approve|reject)$/u);
    if (method === "POST" && decisionMatch) {
      const authenticatedOperator = await authenticateOperator(req);
      if (!authenticatedOperator) { sendError(res, 403, 99403, "Independent operator authentication required."); return true; }
      const body = await readBody(req) ?? {};
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !["expectedRevision", "approvalPhrase"].includes(key))
        || !Number.isInteger(body.expectedRevision)
        || (decisionMatch[2] === "approve" && typeof body.approvalPhrase !== "string")
        || (decisionMatch[2] === "reject" && Object.hasOwn(body, "approvalPhrase"))) {
        sendError(res, 400, 99001, "Approval requires the current revision and the exact phrase; rejection accepts only the revision.");
        return true;
      }
      try {
        const request = publicReadApprovalBroker.resolve(decodeURIComponent(decisionMatch[1]), {
          decision: decisionMatch[2], operatorId: authenticatedOperator,
          expectedRevision: body.expectedRevision,
          ...(body.approvalPhrase ? { approvalPhrase: body.approvalPhrase } : {})
        });
        sendJson(res, 200, request);
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 300);
        sendError(res, /not found/u.test(message) ? 404 : 409, /not found/u.test(message) ? 99404 : 99409, message);
      }
      return true;
    }
    sendError(res, 404, 99404, "No such public-read approval resource.");
    return true;
  };
}
