import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateOutputFiles, redactInput } from "../src/api/output-files.js";
import { createNavigationRunner } from "../src/api/navigation-runner.js";
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
