import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteExecutor } from "../src/runtime/remote-executor.js";
import { createApiServer } from "../src/api/local-server.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Pure forwarding behavior (mocked transport) ──────────────────────────

test("executor forwards only whitelisted keys to the peer", async () => {
  let seen;
  const executor = createRemoteExecutor({
    peerUrl: "http://192.168.1.50:9377",
    peerToken: "shared-secret",
    fetchImpl: async (url, options) => {
      seen = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "succeeded", output: { status: "succeeded" }, usage: { actions: 1 }, task_id: "task-1" }), json: async () => ({ status: "succeeded", output: { status: "succeeded" }, usage: { actions: 1 }, task_id: "task-1" }) };
    }
  });
  const result = await executor.run("Open the settings page", {
    input: { url: "https://example.com" },
    templateId: "tpl",
    taskId: "task-1",
    // sneaky fields that must NOT be forwarded:
    authorization: "Bearer local-api-token",
    evidence: { snapshot: "private" },
    cookies: "session=secret"
  });
  assert.equal(result.status, "succeeded");
  assert.equal(String(seen.url), "http://192.168.1.50:9377/v3/bots/remote/runs");
  assert.equal(seen.headers.authorization, "Bearer shared-secret");
  assert.equal(seen.headers["idempotency-key"], "task-1");
  assert.deepEqual(Object.keys(seen.body).sort(), ["goal", "input", "taskId", "templateId"]);
  assert.equal(seen.body.authorization, undefined);
  assert.equal(seen.body.evidence, undefined);
});

test("executor refuses peer dispatch without a stable caller-owned key", async () => {
  let fetchCalls = 0;
  const executor = createRemoteExecutor({
    peerUrl: "http://192.168.1.50:9377",
    peerToken: "shared-secret",
    fetchImpl: async () => { fetchCalls++; throw new Error("must not dispatch"); }
  });
  const result = await executor.run("Open the settings page", {});
  assert.equal(result.status, "failed");
  assert.match(result.output.reason, /stable caller-owned idempotency key/);
  assert.equal(fetchCalls, 0);
});

test("unreachable peer is unresolved because the request may have been admitted", async () => {
  const executor = createRemoteExecutor({
    peerUrl: "http://10.0.0.99:9377",
    peerToken: "x",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  const result = await executor.run("Do something", { taskId: "unreachable-run" });
  assert.equal(result.status, "reconciling");
  assert.equal(result.uncertain, true);
  assert.match(result.output.reason, /interrupted/);
  assert.match(result.output.reason, /unreachable/);
});

test("peer rejection and uncertain server errors retain distinct outcomes", async () => {
  for (const status of [401, 403, 500, 503]) {
    const executor = createRemoteExecutor({
      peerUrl: "http://192.168.1.50:9377",
      peerToken: "x",
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) })
    });
    const result = await executor.run("g", { taskId: `http-${status}` });
    assert.equal(result.status, [401, 403].includes(status) ? "failed" : "reconciling", `HTTP ${status} must not become success`);
    assert.match(result.output.reason, /interrupted/);
  }
});

test("unrecognized peer terminal state is treated as unknown outcome", async () => {
  const executor = createRemoteExecutor({
    peerUrl: "http://192.168.1.50:9377",
    peerToken: "x",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "weird-state" }), json: async () => ({ status: "weird-state" }) })
  });
  const result = await executor.run("g", { taskId: "unknown-peer-state" });
  assert.equal(result.status, "reconciling");
  assert.equal(result.uncertain, true);
  assert.match(result.output.reason, /unrecognized/);
});

test("cancellation after peer dispatch remains unresolved until peer outcome is known", async () => {
  let announceFetch;
  const fetchStarted = new Promise(resolve => { announceFetch = resolve; });
  const executor = createRemoteExecutor({
    peerUrl: "http://192.168.1.50:9377",
    peerToken: "x",
    fetchImpl: async (_url, options) => {
      announceFetch();
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("canceled");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
  });
  const controller = new AbortController();
  const pending = executor.run("g", { signal: controller.signal, taskId: "canceled-peer-run" });
  await fetchStarted;
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "reconciling");
  assert.equal(result.uncertain, true);
  assert.match(result.output.reason, /outcome must be reconciled/i);
});

test("cancellation before peer dispatch is a definite no-op", async () => {
  let fetchCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const executor = createRemoteExecutor({
    peerUrl: "http://192.168.1.50:9377",
    peerToken: "shared-secret",
    fetchImpl: async () => { fetchCalls++; throw new Error("must not dispatch"); }
  });

  const result = await executor.run("g", { signal: controller.signal, taskId: "not-dispatched" });

  assert.equal(result.status, "canceled");
  assert.equal(result.uncertain, false);
  assert.equal(fetchCalls, 0);
});

test("peerUrl must be a private LAN address", () => {
  assert.throws(() => createRemoteExecutor({ peerUrl: "https://example.com" }), /plain http/);
  assert.throws(() => createRemoteExecutor({ peerUrl: "http://203.0.113.7:9377" }), /private/);
  assert.doesNotThrow(() => createRemoteExecutor({ peerUrl: "http://172.16.4.5:9377", peerToken: "x", fetchImpl: async () => ({ ok: true, json: async () => ({ status: "canceled" }) }) }));
});

// ── End-to-end: local node forwards to a peer node on loopback ───────────

test("two-node split: control node forwards, executor node runs, truthful terminal state", async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), "activetab-node-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "activetab-node-b-"));
  const tokenFile = join(dirB, "peer-token");
  await writeFile(tokenFile, "e2e-shared-token\n", { mode: 0o600 });

  const previousTokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
  const previousToken = process.env.ACTIVETAB_REMOTE_TOKEN;
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  delete process.env.ACTIVETAB_REMOTE_TOKEN;

  // Executor node: local mock runner, same code path as a real browser node.
  const executorApi = createApiServer({
    port: 0,
    apiToken: "executor-api-token",
    taskStoreDir: join(dirB, "tasks"),
    navigationRunner: {
      async run(goal) {
        await new Promise(r => setTimeout(r, 30));
        return { status: "succeeded", output: { status: "succeeded", echoed_goal_length: goal.length }, usage: { actions: 1, elapsed_ms: 30 }, output_files: {}, live_url_info: null };
      }
    }
  });
  const executorInfo = await executorApi.start();

  // Control node: forwards to the executor node.
  const remoteRunner = createRemoteExecutor({
    peerUrl: executorInfo.url,
    peerTokenFile: tokenFile,
    fetchImpl: fetch
  });
  const controlApi = createApiServer({
    port: 0,
    apiToken: "control-api-token",
    taskStoreDir: join(dirA, "tasks"),
    navigationRunner: remoteRunner
  });
  const controlInfo = await controlApi.start();

  try {
    const create = await fetch(`${controlInfo.url}/v3/bots/templates/local-web-reviews-scraper/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer control-api-token" },
      body: JSON.stringify({ input: { url: "https://example.com", review_count: 1 } })
    }).then(r => r.json());

    const deadline = Date.now() + 10_000;
    let detail = {};
    while (Date.now() < deadline) {
      detail = await fetch(`${controlInfo.url}/v3/bots/runs/${create.task_id}`, { headers: { "Authorization": "Bearer control-api-token" } }).then(r => r.json());
      if (["finished", "failed", "canceled", "needs_human"].includes(detail.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    if (!["finished", "failed", "canceled", "needs_human"].includes(detail.status)) {
      const peerTask = [...executorApi.store.tasks.values()].at(-1);
      const direct = await fetch(`${executorInfo.url}/v3/bots/remote/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer e2e-shared-token", "idempotency-key": "direct-probe-key" },
        body: JSON.stringify({ goal: "direct-probe" })
      });
      const directBody = await direct.text();
      throw new Error(`control task never reached a terminal state, last status: ${detail.status}; peer task: ${JSON.stringify(peerTask ?? null)?.slice(0, 400)}; direct probe: HTTP ${direct.status} ${directBody.slice(0, 300)}`);
    }
    assert.equal(detail.status, "finished", `the remote run completed and translated to finished (error: ${detail.error ?? "none"}; output: ${JSON.stringify(detail.output)?.slice(0, 300)})`);
    assert.equal(detail.output.status, "succeeded");
    assert.equal(typeof detail.usage.elapsed_ms, "number");

    // Wrong token is rejected by the executor node.
    const badRunner = createRemoteExecutor({ peerUrl: executorInfo.url, peerToken: "wrong", fetchImpl: fetch });
    const badResult = await badRunner.run("g", { taskId: "bad-token-run" });
    assert.equal(badResult.status, "failed");
    assert.match(badResult.output.reason, /token/);
  } finally {
    await controlApi.stop();
    await executorApi.stop();
    if (previousTokenFile === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
    else process.env.ACTIVETAB_REMOTE_TOKEN_FILE = previousTokenFile;
    if (previousToken === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN;
    else process.env.ACTIVETAB_REMOTE_TOKEN = previousToken;
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("token file is auto-created with a strong random token", async () => {
  const { loadOrCreatePeerToken } = await import("../src/runtime/tokens.js");
  const dir = await mkdtemp(join(tmpdir(), "activetab-token-"));
  try {
    const first = await loadOrCreatePeerToken(join(dir, "peer-token"));
    const second = await loadOrCreatePeerToken(join(dir, "peer-token"));
    assert.equal(first.token, second.token, "existing token is reused");
    assert.ok(first.token.length >= 32, "256-bit base64url token");
    const { tokenMatches } = await import("../src/runtime/tokens.js");
    assert.equal(tokenMatches(first.token, [first.token]), true);
    assert.equal(tokenMatches("attacker", [first.token]), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
