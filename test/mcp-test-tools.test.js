import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_SERVER_PATH = fileURLToPath(new URL("../src/mcp/server.js", import.meta.url));

async function runMcpShell(requests) {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-mcp-"));
  const inputPath = join(tempDir, "requests.jsonl");
  const outputPath = join(tempDir, "responses.jsonl");
  const payload = requests.map(message => `${JSON.stringify(message)}\n`).join("");
  await writeFile(inputPath, payload);
  try {
    await new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", `node "${MCP_SERVER_PATH}" < "${inputPath}" > "${outputPath}" 2>&1`], {
        timeout: 15_000, maxBuffer: 4 * 1024 * 1024
      }, (error) => {
        if (error && ![">", "1"].includes(error.code)) return reject(new Error(`MCP shell failed: ${error.message}`));
        resolve();
      });
    });
    const stdout = await readFile(outputPath, "utf8");
    return stdout.split("\n").filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

test("MCP server exposes test-run tools", async () => {
  const responses = await runMcpShell([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  const toolsRes = responses.find(response => response.id === 2);
  assert.ok(toolsRes?.result?.tools, "tools/list should return tools.");
  const names = toolsRes.result.tools.map(tool => tool.name);
  for (const name of ["start_test_run", "get_test_run", "cancel_test_run", "collect_diagnostics", "get_test_report"]) {
    assert.ok(names.includes(name), `Expected tool '${name}' in tools/list`);
  }
});

test("MCP collect_diagnostics rejects unknown runId", async () => {
  const responses = await runMcpShell([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "collect_diagnostics", arguments: { runId: "no-such-run" } } }
  ]);
  const callRes = responses.find(response => response.id === 2);
  const text = callRes?.error?.message ?? callRes?.result?.content?.[0]?.text ?? "";
  assert.ok(String(text).includes("No test run found"), `Expected 'No test run found', got: ${text}`);
});

test("MCP get_test_report rejects unknown runId", async () => {
  const responses = await runMcpShell([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_test_report", arguments: { runId: "no-such-run" } } }
  ]);
  const callRes = responses.find(response => response.id === 2);
  const text = callRes?.error?.message ?? callRes?.result?.content?.[0]?.text ?? "";
  assert.ok(String(text).includes("No test run found"), `Expected 'No test run found', got: ${text}`);
});

test("MCP cancel_test_run rejects unknown runId", async () => {
  const responses = await runMcpShell([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cancel_test_run", arguments: { runId: "no-such-run" } } }
  ]);
  const callRes = responses.find(response => response.id === 2);
  const text = callRes?.error?.message ?? callRes?.result?.content?.[0]?.text ?? "";
  assert.ok(String(text).includes("No test run found"), `Expected 'No test run found', got: ${text}`);
});

test("MCP start_test_run rejects without an attached session", async () => {
  const responses = await runMcpShell([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_test_run", arguments: { targetId: "no-tab", workflow: { id: "wf", name: "wf", steps: [{ id: "s1", type: "cleanup" }] } } } }
  ]);
  const callRes = responses.find(response => response.id === 2);
  const text = callRes?.error?.message ?? callRes?.result?.content?.[0]?.text ?? "";
  assert.ok(String(text).includes("No explicitly authorized tab is attached") || String(text).includes("No attached browser session"),
    `Expected session error, got: ${text}`);
});
