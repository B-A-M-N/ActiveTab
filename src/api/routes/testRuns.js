/** Build test-run endpoint dispatch from server-owned lifecycle handlers. */
export function createTestRunRoutes({
  authorizeMutation,
  handleStartTestRun,
  handleGetTestRun,
  handleResumeTestRun,
  handleCancelTestRun,
  handleCollectTestRunDiagnostics,
  handleGetTestReport,
  sendError
} = {}) {
  return async function handleTestRunRoute(req, res, { method, path } = {}) {
    if (method === "POST" && path === "/v1/test/runs") {
      if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
      await handleStartTestRun(req, res);
      return true;
    }
    const testRunMatch = path.match(/^\/v1\/test\/runs\/([^/]+)(?:\/(status|cancel|diagnostics|report|resume))?$/);
    if (!testRunMatch) return false;
    if (!authorizeMutation(req)) { sendError(res, 401, 99401, "Authentication required."); return true; }
    const runId = testRunMatch[1];
    const action = testRunMatch[2] ?? "status";
    if (method === "GET" && action === "status") { await handleGetTestRun(req, res, runId); return true; }
    if (method === "POST" && action === "resume") { await handleResumeTestRun(req, res, runId); return true; }
    if (method === "POST" && action === "cancel") { await handleCancelTestRun(req, res, runId); return true; }
    if (method === "POST" && action === "diagnostics") { await handleCollectTestRunDiagnostics(req, res, runId); return true; }
    if (method === "GET" && action === "report") { await handleGetTestReport(req, res, runId); return true; }
    sendError(res, 405, 99405, "Method not allowed for this test-run resource.");
    return true;
  };
}
