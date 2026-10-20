import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/mcp/server.js", import.meta.url));
const extensionServerPath = fileURLToPath(new URL("../src/extension/start-mcp.js", import.meta.url));

function runMcpShell(serverJsPath, requests, { stateDir = null } = {}) {
  return mkdtemp(join(tmpdir(), "activetab-mcp-")).then(tempDir => {
    const inputPath = join(tempDir, "requests.jsonl");
    const outputPath = join(tempDir, "responses.jsonl");
    const payload = requests.map(message => `${JSON.stringify(message)}\n`).join("");
    return writeFile(inputPath, payload).then(() => new Promise((resolve, reject) => {
      const statePrefix = `ACTIVETAB_STATE_DIR="${stateDir ?? tempDir}" `;
      const cmd = `${statePrefix}node "${serverJsPath}" < "${inputPath}" > "${outputPath}" 2>&1`;
      execFile("/bin/sh", ["-c", cmd], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, error => {
        if (error && ![">", "1"].includes(String(error.code))) return reject(new Error(`MCP shell failed: ${error.message}`));
        readFile(outputPath, "utf8").then(stdout => {
          const responses = stdout.split("\n").filter(line => line.trim()).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          resolve({ responses, tempDir });
        }, reject);
      });
    }));
  });
}

test("MCP stdio server initializes and advertises bounded browser tools", async () => {
  const { responses, tempDir } = await runMcpShell(serverPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_runtime_capabilities", arguments: {} } }
  ]);
  try {
    assert.equal(responses[0].result.serverInfo.name, "activetab");
    const names = responses[1].result.tools.map(tool => tool.name);
    assert.deepEqual(names, ["get_runtime_capabilities", "list_tabs", "attach_tab", "detach_tab", "observe_page", "read_page_records", "get_evidence", "inspect_runtime_state", "click_observed_element", "inspect_network_response", "request_evidence_release", "release_evidence", "discover_application", "investigate_failure", "start_test_run", "resume_test_run", "enter_cloud_agent", "start_cloud_agent_task", "get_test_run", "cancel_test_run", "collect_diagnostics", "collect_cloud_agent_run_evidence", "get_test_report", "list_pending_interventions", "get_pending_intervention", "acknowledge_human_action", "request_operation_approval", "reject_operation", "resume_run", "get_run_state", "cancel_run", "run_goal"]);
    const runtimeStatus = responses[2].result.structuredContent;
    assert.equal(runtimeStatus.navigation.reasonCode, "navigation_scope_required");
    assert.equal(runtimeStatus.planning.preflightKind, "authenticated_catalog_only");
    assert.equal(runtimeStatus.planning.inferenceReachability, "not_configured");
    assert.equal(runtimeStatus.visual.secondary.screenshotConsent, process.env.ACTIVETAB_MODEL_ALLOW_SCREENSHOTS === "1");
    assert.equal(runtimeStatus.forms.reasonCode, "operation_not_admitted");
    assert.equal(runtimeStatus.workflowReuse.status, "disabled");
    assert.equal(JSON.stringify(runtimeStatus).includes("API_KEY"), false);
    assert.match(responses[1].result.tools.find(tool => tool.name === "enter_cloud_agent").description, /does not create or submit a Cloud Agent task/);
    assert.deepEqual(responses[1].result.tools.find(tool => tool.name === "attach_tab").inputSchema.required, ["targetId"]);
    assert.deepEqual(responses[1].result.tools.find(tool => tool.name === "detach_tab").inputSchema.required, ["targetId"]);
    assert.match(responses[1].result.tools.find(tool => tool.name === "observe_page").description, /targetId/);
    assert.equal(responses[1].result.tools.find(tool => tool.name === "observe_page").inputSchema.properties.targetId.type, "string");
    const pageReadSchema = responses[1].result.tools.find(tool => tool.name === "read_page_records").inputSchema;
    assert.deepEqual(pageReadSchema.required, ["fields"]);
    assert.equal(pageReadSchema.properties.profileId.type, "string");
    assert.match(responses[1].result.tools.find(tool => tool.name === "read_page_records").description, /always reports observed_partial/u);
    assert.match(responses[1].result.tools.find(tool => tool.name === "read_page_records").description, /exact-origin publicReadEntries allowlist/u);
    const evidenceSchema = responses[1].result.tools.find(tool => tool.name === "get_evidence").inputSchema;
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("networkActivity"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("lifecycleEvents"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("domMutations"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("outOfProcessFrames"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("scrollTargets"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("runtimeState"));
    assert.equal(evidenceSchema.properties.frameTargetId.type, "string");
    assert.equal(evidenceSchema.properties.includeSensitiveUrlData, undefined);
    assert.equal(evidenceSchema.properties.includeSensitiveRuntimeValues, undefined);
    assert.equal(evidenceSchema.properties.includeSensitivePageText, undefined);
    assert.equal(evidenceSchema.properties.includeScreenshot, undefined);
    assert.match(responses[1].result.tools.find(tool => tool.name === "get_evidence").description, /independently operator-approved/);
    const runtimeSchema = responses[1].result.tools.find(tool => tool.name === "inspect_runtime_state").inputSchema;
    assert.deepEqual(runtimeSchema.required, ["evidenceId"]);
    assert.deepEqual(runtimeSchema.properties.path, { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } });
    assert.match(responses[1].result.tools.find(tool => tool.name === "inspect_runtime_state").description, /reports accessors without reading them/);
    const visualActionSchema = responses[1].result.tools.find(tool => tool.name === "click_observed_element").inputSchema;
    assert.deepEqual(visualActionSchema.required, ["goal", "evidenceId", "backendNodeId"]);
    assert.equal(visualActionSchema.properties.frameTargetId.type, "string");
    const networkResponseSchema = responses[1].result.tools.find(tool => tool.name === "inspect_network_response").inputSchema;
    assert.deepEqual(networkResponseSchema.required, ["evidenceId", "requestId"]);
    assert.equal(networkResponseSchema.properties.includeSensitive, undefined);
    assert.equal(networkResponseSchema.properties.includeSensitiveUrlData, undefined);
    assert.equal(networkResponseSchema.properties.includeCredentialValues, undefined);
    assert.equal(networkResponseSchema.properties.maxBytes.maximum, 262144);
    assert.equal(networkResponseSchema.properties.view.enum.includes("markdown"), true);
    assert.match(responses[1].result.tools.find(tool => tool.name === "inspect_network_response").description, /format-aware diagnostics/);
    const requestReleaseSchema = responses[1].result.tools.find(tool => tool.name === "request_evidence_release").inputSchema;
    assert.deepEqual(requestReleaseSchema.required, ["profileId", "evidenceId", "facet", "byteBudget"]);
    const releaseSchema = responses[1].result.tools.find(tool => tool.name === "release_evidence").inputSchema;
    assert.deepEqual(releaseSchema.required, ["profileId", "evidenceId", "facet", "grantToken"]);
    const runGoalSchema = responses[1].result.tools.find(tool => tool.name === "run_goal").inputSchema;
    assert.deepEqual(runGoalSchema.properties.maxScrolls, { type: "integer", minimum: 0, maximum: 8 });
    assert.deepEqual(runGoalSchema.properties.workflowIntent.properties.requiredCapabilityIds, {
      type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 96 }
    });
    assert.equal(runGoalSchema.properties.newTask.type, "boolean");
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /requires plannerMode=workflow.*cannot omit or conditionally skip it/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /ACTIVETAB_MODEL_ALLOW_GOAL_TEXT=1.*bounded model interpretation/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /Mutations, submissions, and unrelated read capabilities are never inferred/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /Task continuation uses a goal fingerprint and bounded state/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /Set newTask=true to start a completed task again/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /configured.*verified read-only workflow reuse is enabled automatically/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /`targetId` selects the browser session/i);
    assert.deepEqual(responses[1].result.tools.find(tool => tool.name === "collect_cloud_agent_run_evidence").inputSchema.required, ["runId", "cloudAgentRunId", "browserEvidenceId"]);
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("MCP rejects the local API-only operation approval resolver", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "activetab-hidden-intervention-mcp-"));
  const { responses, tempDir } = await runMcpShell(serverPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "resolve_operation_approval",
        arguments: { interventionId: "unknown", authenticatedOperator: "caller-supplied" }
      }
    }
  ], { stateDir });
  try {
    const response = responses.find(item => item.id === 2);
    assert.match(response?.error?.message ?? "", /Unknown tool: resolve_operation_approval/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("extension MCP exposes no tabs and refuses attach until the popup authorizes one", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "activetab-extension-mcp-"));
  const { responses, tempDir } = await runMcpShell(extensionServerPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tabs", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "attach_tab", arguments: { targetId: "not-authorized" } } }
  ], { stateDir });
  try {
    assert.equal(responses[0].result.serverInfo.name, "activetab");
    assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ["get_runtime_capabilities", "list_tabs", "attach_tab", "detach_tab", "observe_page", "read_page_records", "get_evidence", "inspect_runtime_state", "click_observed_element", "inspect_network_response", "request_evidence_release", "release_evidence", "discover_application", "investigate_failure", "start_test_run", "resume_test_run", "enter_cloud_agent", "start_cloud_agent_task", "get_test_run", "cancel_test_run", "collect_diagnostics", "collect_cloud_agent_run_evidence", "get_test_report", "list_pending_interventions", "get_pending_intervention", "acknowledge_human_action", "request_operation_approval", "reject_operation", "resume_run", "get_run_state", "cancel_run", "run_goal"]);
    assert.deepEqual(responses[2].result.structuredContent, []);
    assert.match(responses[3].error.message, /Attach this exact tab from the ActiveTab extension/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
