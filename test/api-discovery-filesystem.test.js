import test from "node:test";
import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApiServer } from "../src/api/local-server.js";

async function assertMissing(path) {
  await assert.rejects(lstat(path), error => error?.code === "ENOENT");
}

test("HTTP discovery ignores request-controlled absolute, relative, and traversal knowledge paths", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "activetab-api-discovery-paths-"));
  const token = basename(tempDir);
  const configuredKnowledgeDir = join(tempDir, "trusted-discovery-knowledge");
  const requestPaths = [
    join(tempDir, "request-absolute"),
    `./${token}-request-relative`,
    `../${token}-request-traversal`
  ];
  const resolvedRequestPaths = [
    requestPaths[0],
    resolve(process.cwd(), requestPaths[1]),
    resolve(process.cwd(), requestPaths[2])
  ];
  const session = {
    attached: true,
    target: { id: "discovery-filesystem-test-target", endpoint: "local-cdp" },
    async observe() {
      return {
        page: { url: "https://discovery-filesystem.test/", title: "Fixture" },
        candidates: [],
        headings: [],
        frames: []
      };
    }
  };
  const runStateStore = {
    async init() {},
    async acquireTargetLease() {
      return {
        fencingToken: 1,
        async assertCurrent() {},
        async release() {}
      };
    }
  };
  const server = createApiServer({
    port: 0,
    taskStoreDir: join(tempDir, "tasks"),
    discoveryKnowledgeDir: configuredKnowledgeDir,
    apiToken: "discovery-test-token",
    runStateStore,
    testSessionResolver: async () => session
  });

  for (const path of resolvedRequestPaths) await assertMissing(path);
  try {
    const { url } = await server.start();
    for (const knowledgeDir of requestPaths) {
      const response = await fetch(`${url}/v1/discover`, {
        method: "POST",
        headers: {
          Authorization: "Bearer discovery-test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ knowledgeDir, maxSteps: 1 })
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.savedKnowledge?.origin, "https://discovery-filesystem.test");
    }

    const trustedFiles = await readdir(configuredKnowledgeDir);
    assert.equal(trustedFiles.filter(file => /^[a-f0-9]{32}\.json$/u.test(file)).length, 1);
    for (const path of resolvedRequestPaths) await assertMissing(path);
  } finally {
    await server.stop();
    for (const path of resolvedRequestPaths) await rm(path, { recursive: true, force: true }).catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
});
