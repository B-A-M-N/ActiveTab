import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/api/local-server.js";
import { createNavigationRunner } from "../src/api/navigation-runner.js";
import { createRunStateFixture } from "./runStateFixture.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP peer run defaults to guarded auto-mode extraction and preserves input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-http-auto-mode-"));
  const fixture = await createRunStateFixture("activetab-http-auto-mode-state-");
  const previousTokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
  const token = "http-peer-test-token-1234567890";
  const tokenFile = join(directory, "peer-token");
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

  const targetId = "http-auto-read-target";
  const pageUrl = "https://catalog.example.test/products";
  const input = { section: "featured" };
  let resolvedInput;
  const output = {
    schema: { type: "array", items: { name: { type: "string", required: true, dataClass: "public", sourceHeader: "Name" } } },
    records: [{ name: "Widget" }],
    fieldProvenance: [{ recordIndex: 0, fields: { name: {
      observationId: "http-auto-read-evidence", validation: "valid", method: "visible_html_table_cell",
      sourceHeader: "Name", pageUrl
    } } }],
    scope: { origin: "https://catalog.example.test", pagePath: "/products" },
    completeness: "observed_partial",
    verification: {
      recordCount: 1, expectedRecords: null, completionPolicy: "observed_only", pageCount: 1,
      invalidRows: 0, duplicateKeys: 0, invalidUniqueKeys: 0, overflow: false, failures: [], uniqueBy: ["name"],
      completenessStatus: "observed_partial", completionReasonCode: "collection_completeness_not_established", completenessClaimed: false
    }
  };
  const capability = {
    id: "observed_read_http_auto_12345678", action: "extract", executionOrigin: "ephemeral_observed_read",
    effectClass: "read", intentBinding: "caller_required", targetRole: "observed_records",
    purposeCodes: ["extract_records"], preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"], verificationCodes: ["observed_records_verified"],
    outputCompleteness: "observed_partial", outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output, completeness: "observed_partial" }; }
  };
  const session = {
    attached: true, persistent: true,
    target: { id: targetId, endpoint: "fixture", url: pageUrl },
    async observe() { return {
      evidenceId: "http-auto-read-evidence", targetId, documentGeneration: 1,
      page: { url: pageUrl, title: "Products" }, headings: [], candidates: [], scrollTargets: []
    }; }
  };
  const runner = createNavigationRunner({
    outputDir: join(directory, "output"),
    journalDir: join(directory, "journals"),
    resolveSession: async context => { resolvedInput = context.input; return session; },
    capabilityService: {
      async createObservedReadWorkflowCapabilities({ goal }) {
        assert.equal(goal, "List the visible product names");
        return [capability];
      }
    }
  });
  const api = createApiServer({
    port: 0,
    taskStoreDir: join(directory, "tasks"),
    navigationRunner: runner,
    apiToken: "local-api-test-token",
    runStateStore: fixture.store
  });

  try {
    const { url } = await api.start();
    const response = await fetch(`${url}/v3/bots/remote/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "http-auto-mode-fixture-1"
      },
      body: JSON.stringify({ goal: "List the visible product names", input })
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output.records, [{ name: "Widget" }]);
    assert.equal(result.output.workflow_outputs[capability.id].completeness, "observed_partial");
    assert.equal(result.output.workflow_outputs[capability.id].verification.completenessClaimed, false);
    assert.deepEqual(resolvedInput, input, "the HTTP input reaches the authorized session resolver unchanged");
  } finally {
    await api.stop();
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
    if (previousTokenFile === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
    else process.env.ACTIVETAB_REMOTE_TOKEN_FILE = previousTokenFile;
  }
});
