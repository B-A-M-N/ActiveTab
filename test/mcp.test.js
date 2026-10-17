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
      const statePrefix = stateDir ? `ACTIVETAB_STATE_DIR="${stateDir}" ` : "";
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
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ]);
  try {
    assert.equal(responses[0].result.serverInfo.name, "activetab");
    const names = responses[1].result.tools.map(tool => tool.name);
    assert.deepEqual(names, ["list_tabs", "attach_tab", "detach_tab", "observe_page", "get_evidence", "inspect_runtime_state", "click_observed_element", "inspect_network_response", "discover_application", "investigate_failure", "start_test_run", "get_test_run", "cancel_test_run", "collect_diagnostics", "get_test_report", "run_goal"]);
    assert.deepEqual(responses[1].result.tools.find(tool => tool.name === "attach_tab").inputSchema.required, ["targetId"]);
    assert.deepEqual(responses[1].result.tools.find(tool => tool.name === "detach_tab").inputSchema.required, ["targetId"]);
    assert.match(responses[1].result.tools.find(tool => tool.name === "observe_page").description, /targetId/);
    assert.equal(responses[1].result.tools.find(tool => tool.name === "observe_page").inputSchema.properties.targetId.type, "string");
    const evidenceSchema = responses[1].result.tools.find(tool => tool.name === "get_evidence").inputSchema;
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("networkActivity"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("lifecycleEvents"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("domMutations"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("outOfProcessFrames"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("scrollTargets"));
    assert.ok(evidenceSchema.properties.facets.items.enum.includes("runtimeState"));
    assert.equal(evidenceSchema.properties.frameTargetId.type, "string");
    assert.equal(evidenceSchema.properties.includeSensitiveUrlData.type, "boolean");
    assert.equal(evidenceSchema.properties.includeSensitiveRuntimeValues.type, "boolean");
    assert.equal(evidenceSchema.properties.includeSensitivePageText.type, "boolean");
    assert.equal(evidenceSchema.properties.includeScreenshot.type, "boolean", "MCP callers can explicitly retrieve retained visual evidence");
    assert.match(responses[1].result.tools.find(tool => tool.name === "get_evidence").description, /selected response bodies require `inspect_network_response`/);
    const runtimeSchema = responses[1].result.tools.find(tool => tool.name === "inspect_runtime_state").inputSchema;
    assert.deepEqual(runtimeSchema.required, ["evidenceId"]);
    assert.deepEqual(runtimeSchema.properties.path, { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } });
    assert.match(responses[1].result.tools.find(tool => tool.name === "inspect_runtime_state").description, /reports accessors without reading them/);
    const visualActionSchema = responses[1].result.tools.find(tool => tool.name === "click_observed_element").inputSchema;
    assert.deepEqual(visualActionSchema.required, ["goal", "evidenceId", "backendNodeId"]);
    assert.equal(visualActionSchema.properties.frameTargetId.type, "string");
    const networkResponseSchema = responses[1].result.tools.find(tool => tool.name === "inspect_network_response").inputSchema;
    assert.deepEqual(networkResponseSchema.required, ["evidenceId", "requestId"]);
    assert.equal(networkResponseSchema.properties.includeSensitive.type, "boolean");
    assert.deepEqual(networkResponseSchema.properties.maxBytes, { type: "integer", minimum: 1, maximum: 262144 });
    const runGoalSchema = responses[1].result.tools.find(tool => tool.name === "run_goal").inputSchema;
    assert.deepEqual(runGoalSchema.properties.maxScrolls, { type: "integer", minimum: 0, maximum: 8 });
    assert.equal(runGoalSchema.properties.newTask.type, "boolean");
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /repeating the same goal on the same target resumes an incomplete task/i);
    assert.match(responses[1].result.tools.find(tool => tool.name === "run_goal").description, /Tied targets stop unresolved and return evidence-linked backend\/frame handles/);
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
    assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ["list_tabs", "attach_tab", "detach_tab", "observe_page", "get_evidence", "inspect_runtime_state", "click_observed_element", "inspect_network_response", "discover_application", "investigate_failure", "start_test_run", "get_test_run", "cancel_test_run", "collect_diagnostics", "get_test_report", "run_goal"]);
    assert.deepEqual(responses[2].result.structuredContent, []);
    assert.match(responses[3].error.message, /Attach this exact tab from the ActiveTab extension/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
