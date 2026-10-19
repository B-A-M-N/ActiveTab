import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateOutputFiles, redactInput } from "../src/api/output-files.js";
import { createNavigationRunner } from "../src/api/navigation-runner.js";
import { DeterministicPlanner } from "../src/navigation/planner.js";
import { WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";
import { createRunStateFixture } from "./runStateFixture.js";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "activetab-output-test-"));
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const schema = {
  type: "object",
  properties: {
    url: { type: "string" },
    review_count: { type: "integer" }
  }
};

// ── Redaction policy ─────────────────────────────────────────────────────

test("redactInput preserves schema shape while redacting string values", () => {
  const redacted = redactInput({ url: "https://example.com/reviews", review_count: 3 }, schema);
  assert.equal(redacted.url, "[redacted]");
  assert.equal(redacted.review_count, 3);
});

test("redactInput omits credential-like fields entirely", () => {
  const redacted = redactInput({ url: "https://example.com", api_key: "super-secret", password: "hunter2", note: "hello" }, schema);
  assert.equal(redacted.api_key, undefined);
  assert.equal(redacted.password, undefined);
  assert.equal(redacted.note, "[redacted]");
});

// ── Output file generation: redacted by default ─────────────────────────

test("generateOutputFiles writes redacted JSON and MD by default (goal and raw input never exported)", async () => {
  const taskId = "test-redacted-001";
  const result = {
    goal: "Go to example.com and extract 3 reviews",
    input: { url: "https://example.com/reviews", review_count: 3, password: "do-not-export" },
    output: {
      status: "succeeded",
      schema: { type: "array", items: {
        author: { type: "string", dataClass: "public" },
        rating: { type: "integer", dataClass: "public" }
      } },
      records: [{ author: "Alice", rating: 5 }]
    },
    status: "succeeded",
    evidenceId: "ev-123",
    inputSchema: schema
  };

  const files = await generateOutputFiles(taskId, result, tempDir);

  // Default formats: json + md + csv (records exist)
  assert.ok(files.json);
  assert.ok(files.md);
  assert.ok(files.csv);
  assert.equal(files.xml, undefined, "XML is not produced automatically");

  const jsonContent = await readFile(join(tempDir, taskId, "result.json"), "utf8");
  assert.equal(jsonContent.includes("example.com/reviews"), false, "raw input URL is redacted");
  assert.equal(jsonContent.includes("do-not-export"), false, "credential-like input is omitted");
  assert.equal(jsonContent.includes("Go to example.com"), false, "raw goal is never exported");
  assert.equal(jsonContent.includes("[redacted]"), true);
  assert.equal(JSON.parse(jsonContent).output.evidence_id, "ev-123", "evidence reference included without payloads");

  const mdContent = await readFile(join(tempDir, taskId, "result.md"), "utf8");
  assert.equal(mdContent.includes("Go to example.com"), false);
  assert.equal(mdContent.includes("example.com/reviews"), false);
});

test("generateOutputFiles produces every requested format with the same privacy policy", async () => {
  const taskId = "test-formats-001";
  const result = {
    goal: "Extract data",
    input: { url: "https://example.com", token: "abc" },
    output: {
      schema: { type: "array", items: {
        id: { type: "integer", dataClass: "public" },
        name: { type: "string", dataClass: "public" }
      } },
      records: [{ id: 1, name: "Widget" }]
    },
    status: "succeeded",
    inputSchema: { type: "object", properties: { url: { type: "string" } } }
  };

  const files = await generateOutputFiles(taskId, result, tempDir, { formats: ["json", "md", "csv", "xml"] });
  for (const format of ["json", "md", "csv", "xml"]) {
    assert.ok(files[format], `${format} produced`);
    const content = await readFile(join(tempDir, taskId, files[format].file_name), "utf8");
    assert.equal(content.includes("abc"), false, `${format} omits credential-like input`);
    if (format !== "csv") assert.equal(content.includes("Extract data"), false, `${format} redacts the raw goal`);
  }
});

test("generateOutputFiles escapes CSV special characters", async () => {
  const taskId = "test-csv-001";
  const result = {
    goal: "Extract data",
    input: {},
    output: {
      schema: { type: "array", items: {
        name: { type: "string", dataClass: "public" },
        city: { type: "string", dataClass: "public" }
      } },
      records: [{ name: 'John "JD" Doe', city: "New York, NY" }]
    },
    status: "succeeded"
  };

  await generateOutputFiles(taskId, result, tempDir);
  const csvContent = await readFile(join(tempDir, taskId, "result.csv"), "utf8");
  assert.ok(csvContent.includes('"John ""JD"" Doe"'));
  assert.ok(csvContent.includes('"New York, NY"'));
});

test("generateOutputFiles neutralizes spreadsheet formulas in untrusted string cells", async () => {
  const taskId = "test-csv-formula-001";
  const result = {
    goal: "Extract data",
    input: {},
    output: {
      schema: { type: "array", items: { value: { type: "string", dataClass: "public" } } },
      records: [
      { value: "=1+1" },
      { value: " +SUM(A1:A2)" },
      { value: "-CMD()" },
      { value: "@SUM(A1:A2)" },
      { value: -12 }
      ]
    },
    status: "succeeded"
  };
  await generateOutputFiles(taskId, result, tempDir, { formats: ["csv"] });
  const content = await readFile(join(tempDir, taskId, "result.csv"), "utf8");
  for (const value of ["'=1+1", "' +SUM(A1:A2)", "'-CMD()", "'@SUM(A1:A2)"]) assert.ok(content.includes(value));
  assert.ok(content.includes("-12"), "numeric negative values remain numeric literals");
});

test("structured exports apply field-level data classification", async () => {
  const taskId = "test-field-privacy-001";
  const result = {
    goal: "Extract data",
    input: {},
    output: {
      schema: { type: "array", items: {
        title: { type: "string", dataClass: "public" },
        email: { type: "string", dataClass: "personal" },
        token: { type: "string", dataClass: "credential" }
      } },
      records: [{ title: "Public title", email: "person@example.test", token: "never-export" }]
    },
    status: "succeeded"
  };
  const redacted = await generateOutputFiles(taskId, result, tempDir);
  const redactedContent = await readFile(join(tempDir, taskId, redacted.json.file_name), "utf8");
  assert.ok(redactedContent.includes("Public title"));
  assert.equal(redactedContent.includes("person@example.test"), false);
  assert.equal(redactedContent.includes("never-export"), false);

  const authorized = await generateOutputFiles(taskId, result, tempDir, { includeSensitive: true, authorized: true });
  const authorizedContent = await readFile(join(tempDir, taskId, authorized.json.file_name), "utf8");
  assert.ok(authorizedContent.includes("person@example.test"));
  assert.equal(authorizedContent.includes("never-export"), false, "credentials remain non-exportable");
});

test("artifacts identify privacy-filtered outputs as partial and omit ambiguous CSV", async () => {
  const taskId = "test-field-privacy-partial-001";
  const result = {
    goal: "Extract records",
    input: {},
    output: {
      schema: { type: "array", items: {
        title: { type: "string", dataClass: "public" },
        email: { type: "string", dataClass: "personal" },
        token: { type: "string", dataClass: "credential" }
      } },
      records: [{ title: "Public title", email: "person@example.test", token: "secret-value" }],
      completeness: "complete"
    },
    status: "succeeded"
  };

  const files = await generateOutputFiles(taskId, result, tempDir, { formats: ["json", "md", "csv", "xml"] });
  assert.equal(files.csv, undefined, "CSV cannot communicate that fields were withheld");
  const json = JSON.parse(await readFile(join(tempDir, taskId, files.json.file_name), "utf8"));
  assert.equal(json.status, "partial");
  assert.equal(json.output.completeness, "incomplete");
  assert.deepEqual(json.output.release.omittedFields, ["email", "token"]);
  assert.deepEqual(Object.keys(json.output.records[0]), ["title"]);
  const markdown = await readFile(join(tempDir, taskId, files.md.file_name), "utf8");
  assert.ok(markdown.includes("**Status:** partial"));
  const xml = await readFile(join(tempDir, taskId, files.xml.file_name), "utf8");
  assert.ok(xml.includes('status="partial"'));
});

test("unclassified records are withheld from artifacts", async () => {
  const taskId = "test-unclassified-records-001";
  const files = await generateOutputFiles(taskId, {
    goal: "Extract data",
    input: {},
    output: { records: [{ secret: "unclassified-value" }] },
    status: "succeeded"
  }, tempDir);
  assert.equal(files.csv, undefined);
  const json = JSON.parse(await readFile(join(tempDir, taskId, files.json.file_name), "utf8"));
  assert.equal(json.status, "partial");
  assert.deepEqual(json.output.records, []);
  assert.deepEqual(json.output.release.omittedFields, ["unclassified_records"]);
  assert.equal(JSON.stringify(json).includes("unclassified-value"), false);
});

test("sensitive full exports require both includeSensitive and owner authorization", async () => {
  const taskId = "test-sensitive-001";
  const result = {
    goal: "Go to https://example.com/private and extract data",
    input: { url: "https://example.com/private" },
    output: {},
    status: "succeeded",
    inputSchema: schema
  };

  // includeSensitive without authorization: still redacted
  const denied = await generateOutputFiles(taskId, result, tempDir, { includeSensitive: true, authorized: false });
  const deniedContent = await readFile(join(tempDir, taskId, denied.json.file_name), "utf8");
  assert.equal(deniedContent.includes("https://example.com/private"), false);

  // Authorized owner export: full data
  const allowed = await generateOutputFiles(taskId, result, tempDir, { includeSensitive: true, authorized: true });
  const allowedContent = await readFile(join(tempDir, taskId, allowed.json.file_name), "utf8");
  assert.equal(allowedContent.includes("https://example.com/private"), true);
});

// ── Navigation runner ────────────────────────────────────────────────────

test("createNavigationRunner requires an authorized session resolver", () => {
  assert.throws(() => createNavigationRunner({ outputDir: tempDir }), /authorized session resolver/);
});

test("navigation runner refuses a resolver result that is not an attached session", async () => {
  const runner = createNavigationRunner({
    outputDir: tempDir,
    resolveSession: async () => ({ attached: false })
  });
  await assert.rejects(
    runner.run("Test goal", { input: {}, templateId: "test" }),
    /did not return an attached authorized browser session/
  );
});

test("navigation runner respects a pre-aborted signal and never resolves a session", async () => {
  let resolved = false;
  const runner = createNavigationRunner({
    outputDir: tempDir,
    resolveSession: async () => { resolved = true; return { attached: true, target: { id: "t1" }, persistent: true, close: async () => {} }; }
  });
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run("Test goal", { signal: controller.signal, input: {}, templateId: "test" });
  assert.equal(result.status, "canceled");
  assert.equal(resolved, false, "no session is acquired for a canceled run");
});

test("navigation runner reports locally measured usage instead of synthetic credits", async () => {
  const runner = createNavigationRunner({
    outputDir: tempDir,
    resolveSession: async () => ({ attached: true, target: { id: "t1" }, persistent: true, close: async () => {} }),
    engineOptions: { maxActions: 1 }
  });
  // A minimal fake engine path: resolveSession result lacks observe(), so the
  // run must fail truthfully rather than fabricate success or credits.
  await assert.rejects(
    runner.run("Test goal", { input: { review_count: 42 }, templateId: "test" })
  );
});

test("API template inputs reach deterministic form planning without normalization", async () => {
  const fixture = await createRunStateFixture("activetab-api-input-bindings-");
  const exactValue = "Foo.Bar+QA@example.com  ";
  let evidenceNumber = 0;
  const session = {
    attached: true,
    persistent: true,
    target: { id: "api-input-target", endpoint: "fixture", url: "https://forms.example.test/" },
    documentGeneration: 1,
    async observe() {
      return {
        evidenceId: `api-input-evidence-${++evidenceNumber}`,
        targetId: this.target.id,
        documentGeneration: this.documentGeneration,
        page: { url: this.target.url, title: "Form", viewportWidth: 800, viewportHeight: 600 },
        headings: [], frames: [], scrollTargets: [],
        candidates: [{
          identity: "email-field", targetId: this.target.id, documentGeneration: this.documentGeneration,
          backendNodeId: 7, tag: "input", type: "email", role: "textbox", name: "Email",
          visible: true, disabled: false, bounds: { x: 10, y: 10, width: 300, height: 32 }
        }]
      };
    }
  };
  const runner = createNavigationRunner({
    outputDir: join(tempDir, "api-input-outputs"),
    journalDir: join(tempDir, "api-input-journals"),
    resolveSession: async () => session,
    engineOptions: {
      planner: {
        async plan(goal, observation, options) {
          const planned = await new DeterministicPlanner().plan(goal, observation, options);
          session.plannedValue = planned.action?.value;
          return planned;
        }
      },
      executionMode: "standalone"
    }
  });
  try {
    const result = await runner.run("Fill Email field with inputRef:email", {
      input: { email: exactValue },
      taskId: "api-exact-input-binding",
      templateId: "typed-form-input",
      runStateStore: fixture.store
    });
    assert.equal(result.status, "needs_human", "the unscoped form effect is refused before dispatch");
    assert.match(result.output.reason, /trusted typed operation contract/);
    assert.equal(session.plannedValue, exactValue, "the caller's exact input reaches the planner unchanged");
    const journal = JSON.parse(await readFile(join(tempDir, "api-input-journals", "api-exact-input-binding.json"), "utf8"));
    assert.equal(JSON.stringify(journal).includes(exactValue), false, "the exact caller value is absent from the task journal");
  } finally {
    await fixture.cleanup();
  }
});

test("API runner routes a default-mode current-page read through verified observed extraction", async () => {
  const fixture = await createRunStateFixture("activetab-api-auto-read-");
  const targetId = "api-auto-read-target";
  const pageUrl = "https://catalog.example.test/products";
  const output = {
    schema: { type: "array", items: { name: { type: "string", required: true, dataClass: "public", sourceHeader: "Name" } } },
    records: [{ name: "Widget" }],
    fieldProvenance: [{ recordIndex: 0, fields: { name: {
      observationId: "api-auto-read-evidence", validation: "valid", method: "visible_html_table_cell",
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
  const capabilityId = "observed_read_api_auto_12345678";
  const capability = {
    id: capabilityId, action: "extract", executionOrigin: "ephemeral_observed_read", effectClass: "read",
    intentBinding: "caller_required", targetRole: "observed_records", purposeCodes: ["extract_records"],
    preconditionCodes: ["fresh_observed_source"], postconditionCodes: ["observed_records_returned"],
    verificationCodes: ["observed_records_verified"], outputCompleteness: "observed_partial",
    outputSchema: [{ name: "name", type: "string", required: true }],
    async execute() { return { status: "verified", output, completeness: "observed_partial" }; }
  };
  const session = {
    attached: true, persistent: true,
    target: { id: targetId, endpoint: "fixture", url: pageUrl },
    async observe() { return {
      evidenceId: "api-auto-read-evidence", targetId, documentGeneration: 1,
      page: { url: pageUrl, title: "Products" }, headings: [], candidates: [], scrollTargets: []
    }; }
  };
  const runner = createNavigationRunner({
    outputDir: join(tempDir, "api-auto-read-output"),
    journalDir: join(tempDir, "api-auto-read-journal"),
    resolveSession: async () => session,
    capabilityService: {
      async createObservedReadWorkflowCapabilities({ goal }) {
        assert.equal(goal, "List the visible product names");
        return [capability];
      }
    }
  });

  try {
    const result = await runner.run("List the visible product names", {
      input: {}, taskId: "api-auto-read-task", templateId: "default-read", runStateStore: fixture.store
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.output.records, [{ name: "Widget" }]);
    assert.equal(result.output.workflow_outputs[capabilityId].completeness, "observed_partial");
    assert.equal(result.output.workflow_outputs[capabilityId].verification.completenessClaimed, false);
  } finally {
    await fixture.cleanup();
  }
});

test("API runner keeps default auto search-and-read on the guarded workflow route", async () => {
  const fixture = await createRunStateFixture("activetab-api-auto-search-read-");
  const targetId = "api-auto-search-read-target";
  const pageUrl = "https://search.example.test/";
  const query = "rare public phrase";
  const goal = `Search for ${query} and return the titles`;
  const candidates = [
    {
      identity: "query-field", backendNodeId: 11, targetId, documentGeneration: 1,
      tag: "input", type: "search", role: "searchbox", name: "Search", visible: true, disabled: false, readOnly: false,
      formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true
    },
    {
      identity: "submit-search", backendNodeId: 12, targetId, documentGeneration: 1,
      tag: "button", role: "button", name: "Search", visible: true, disabled: false, submitsForm: true,
      formIdentity: "search-form", formMethod: "get", formActionOrigin: "https://search.example.test", formTargetSameContext: true
    }
  ];
  const readCapability = {
    id: "observed_read_api_search_12345678", action: "extract", effectClass: "read", intentBinding: "caller_required",
    targetRole: "observed_records", purposeCodes: ["extract_records"], preconditionCodes: ["fresh_observed_source"],
    postconditionCodes: ["observed_records_returned"], verificationCodes: ["observed_records_verified"],
    outputCompleteness: "observed_partial", outputSchema: [{ name: "title", type: "string", required: true }],
    async execute() { throw new Error("search results must be verified before extraction"); }
  };
  const session = {
    attached: true, persistent: true, documentGeneration: 1,
    target: { id: targetId, endpoint: "fixture", url: pageUrl },
    async observe() { return {
      evidenceId: "api-auto-search-read-evidence", targetId, documentGeneration: 1,
      page: { url: pageUrl, title: "Search" }, headings: [], candidates, scrollTargets: []
    }; }
  };
  let providerInput;
  const runner = createNavigationRunner({
    outputDir: join(tempDir, "api-auto-search-read-output"),
    journalDir: join(tempDir, "api-auto-search-read-journal"),
    resolveSession: async () => session,
    capabilityService: {
      async createDeferredObservedReadWorkflowCapabilities({ goal: readGoal }) {
        assert.equal(readGoal, "the titles");
        return [readCapability];
      }
    },
    engineOptions: {
      workflowSynthesizer: new WorkflowSynthesizer({
        allowPageEvidence: true,
        provider: { async requestStructured(request) {
          providerInput = request.input;
          return { result: { version: 1, steps: [] } };
        } }
      })
    }
  });

  try {
    const result = await runner.run(goal, { input: {}, taskId: "api-auto-search-read-task", templateId: "search-read", runStateStore: fixture.store });
    assert.equal(result.status, "unresolved");
    assert.ok(providerInput, "the default API route selected workflow synthesis");
    assert.equal(providerInput.task.cardinality, "compound");
    assert.ok(providerInput.task.requiredCapabilityIds.includes(readCapability.id));
    assert.equal(JSON.stringify(providerInput).includes(query), false, "the caller query stays in its local input binding");
  } finally {
    await fixture.cleanup();
  }
});

test("createNavigationRunner rejects conflicting session configuration in resolveConfiguredSession", async () => {
  const { resolveConfiguredSession } = await import("../src/api/navigation-runner.js");
  await assert.rejects(
    resolveConfiguredSession({ ACTIVETAB_EXTENSION: "1", ACTIVETAB_DISPOSABLE_BROWSER: "1" }),
    /Conflicting browser session configuration/
  );
  await assert.rejects(
    resolveConfiguredSession({}),
    /No authorized browser session mode configured/
  );
});

test("output files have restrictive permissions", async () => {
  const taskId = "test-perms-001";
  await generateOutputFiles(taskId, { goal: "g", input: {}, output: { records: [{ id: 1 }] }, status: "succeeded" }, tempDir);
  const files = await readdir(join(tempDir, taskId));
  assert.ok(files.includes("result.json"));
});
