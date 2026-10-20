import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOutputFileHandler } from "../src/api/outputFileHandler.js";

const TASK_ID = "01234567-89ab-cdef-0123-456789abcdef";

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "activetab-output-handler-"));
  const outputDirectory = join(root, "output", TASK_ID);
  await mkdir(outputDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const errors = [];
  const response = {
    headers: null,
    status: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  const handler = createOutputFileHandler({
    sendError: (_res, status, code, message) => errors.push({ status, code, message })
  });
  const store = { baseDir: join(root, "tasks") };
  return { root, outputDirectory, errors, response, handler, store };
}

test("output handler returns allowed files with the compatibility MIME and length", async t => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.outputDirectory, "result.json"), "{\"ok\":true}");

  await fixture.handler(fixture.response, { store: fixture.store, path: `/output/${TASK_ID}/result.json` });

  assert.equal(fixture.response.status, 200);
  assert.deepEqual(fixture.response.headers, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength("{\"ok\":true}")
  });
  assert.equal(fixture.response.body, "{\"ok\":true}");
  assert.deepEqual(fixture.errors, []);
});

test("output handler rejects traversal-shaped names and unsupported extensions", async t => {
  const fixture = await createFixture(t);

  await fixture.handler(fixture.response, { store: fixture.store, path: `/output/${TASK_ID}/../secret.json` });
  await fixture.handler(fixture.response, { store: fixture.store, path: `/output/${TASK_ID}/secret.exe` });

  assert.deepEqual(fixture.errors, [
    { status: 403, code: 99403, message: "Forbidden" },
    { status: 403, code: 99403, message: "Forbidden" }
  ]);
});

test("output handler preserves the existing post-open size limit", async t => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.outputDirectory, "large.json"), Buffer.alloc(5 * 1024 * 1024 + 1));

  await fixture.handler(fixture.response, { store: fixture.store, path: `/output/${TASK_ID}/large.json` });

  assert.deepEqual(fixture.errors, [{ status: 404, code: 99404, message: "Output file not found." }]);
  assert.equal(fixture.response.status, null);
});
