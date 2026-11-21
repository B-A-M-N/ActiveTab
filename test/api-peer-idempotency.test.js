import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../src/api/local-server.js";
import { TaskStore } from "../src/api/task-store.js";

const crashWorkerPath = fileURLToPath(new URL("../test-support/apiPeerWorker.js", import.meta.url));

async function createPeerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-peer-idempotency-"));
  const tokenFile = join(directory, "peer-token");
  await writeFile(tokenFile, "idempotency-peer-token-123456789\n", { mode: 0o600 });
  const previousTokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
  const previousToken = process.env.ACTIVETAB_REMOTE_TOKEN;
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  delete process.env.ACTIVETAB_REMOTE_TOKEN;
  t.after(async () => {
    if (previousTokenFile === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN_FILE;
    else process.env.ACTIVETAB_REMOTE_TOKEN_FILE = previousTokenFile;
    if (previousToken === undefined) delete process.env.ACTIVETAB_REMOTE_TOKEN;
    else process.env.ACTIVETAB_REMOTE_TOKEN = previousToken;
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, tokenFile };
}

function peerRequest(url, key, body, options = {}) {
  return fetch(`${url}/v3/bots/remote/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer idempotency-peer-token-123456789",
      "idempotency-key": key
    },
    body: JSON.stringify(body),
    ...options
  });
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("equivalent concurrent peer requests join one worker and key reuse with changed input conflicts", async t => {
  const { directory } = await createPeerFixture(t);
  const taskStoreDir = join(directory, "tasks");
  let dispatchCount = 0;
  let signalStarted;
  let releaseWorker;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const workerGate = new Promise(resolve => { releaseWorker = resolve; });
  const api = createApiServer({
    port: 0,
    taskStoreDir,
    navigationRunner: {
      async run(goal, options) {
        dispatchCount++;
        signalStarted({ goal, options });
        await workerGate;
        return { status: "succeeded", output: { status: "succeeded", goal }, usage: { actions: 1 } };
      }
    }
  });
  t.after(() => api.stop());
  const { url } = await api.start();
  const key = "caller-task-uuid-111";
  const goal = "Open the archive page";
  const first = peerRequest(url, key, { goal, input: { a: 1, b: 2 } });
  await started;
  const second = peerRequest(url, key, { goal, input: { b: 2, a: 1 } });
  const conflict = await peerRequest(url, key, { goal: "Delete an account", input: { a: 1, b: 2 } });
  assert.equal(conflict.status, 409);
  assert.equal(dispatchCount, 1, "a changed request with the same key cannot start a second worker");

  releaseWorker();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  const [firstResult, secondResult] = await Promise.all([firstResponse.json(), secondResponse.json()]);
  assert.equal(firstResult.status, "succeeded");
  assert.equal(secondResult.status, "succeeded");
  assert.equal(firstResult.task_id, secondResult.task_id);
  assert.equal(dispatchCount, 1);
  assert.equal(api.store.tasks.size, 1);

  const repeated = await peerRequest(url, key, { goal, input: { b: 2, a: 1 } }).then(response => response.json());
  assert.equal(repeated.task_id, firstResult.task_id);
  assert.equal(repeated.status, "succeeded");
  assert.equal(dispatchCount, 1);

  const reservationDirectory = join(taskStoreDir, "peer-idempotency");
  const [reservationFile] = await readdir(reservationDirectory);
  const reservation = await readFile(join(reservationDirectory, reservationFile), "utf8");
  assert.equal(reservation.includes(key), false, "the raw caller key is not persisted");
  assert.equal(reservation.includes(goal), false, "the raw goal is not persisted");
});

test("lost response retries return the original terminal receipt after API restart", async t => {
  const { directory } = await createPeerFixture(t);
  const taskStoreDir = join(directory, "tasks");
  let releaseWorker;
  let signalStarted;
  let dispatchCount = 0;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const gate = new Promise(resolve => { releaseWorker = resolve; });
  const firstApi = createApiServer({
    port: 0,
    taskStoreDir,
    navigationRunner: {
      async run(goal) {
        dispatchCount++;
        signalStarted();
        await gate;
        return { status: "succeeded", output: { status: "succeeded", goal }, usage: { actions: 1 } };
      }
    }
  });
  t.after(() => firstApi.stop());
  const { url } = await firstApi.start();
  const key = "caller-task-uuid-lost-response";
  const body = { goal: "Open the archive page", input: { route: "/archive" } };
  const controller = new AbortController();
  const firstRequest = peerRequest(url, key, body, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(firstRequest, error => error?.name === "AbortError");
  releaseWorker();
  const finished = await waitUntil(() => [...firstApi.store.tasks.values()].find(task => task.status === "finished"), "the original worker did not finish");
  await new Promise(resolve => setTimeout(resolve, 20));
  await firstApi.stop();

  let restartedDispatchCount = 0;
  const restartedApi = createApiServer({
    port: 0,
    taskStoreDir,
    navigationRunner: { async run() { restartedDispatchCount++; return { status: "succeeded" }; } }
  });
  t.after(() => restartedApi.stop());
  const restarted = await restartedApi.start();
  const retry = await peerRequest(restarted.url, key, { goal: body.goal, input: { route: "/archive" } }).then(response => response.json());
  assert.equal(retry.status, "succeeded");
  assert.equal(retry.task_id, finished.task_id);
  assert.equal(restartedDispatchCount, 0);
  assert.equal(dispatchCount, 1);

  const conflict = await peerRequest(restarted.url, key, { goal: "Submit a payment", input: { route: "/archive" } });
  assert.equal(conflict.status, 409);
  assert.equal(restartedDispatchCount, 0);
});

function spawnApiPeerWorker(mode, taskStoreDir, tokenFile, effectFile) {
  const child = spawn(process.execPath, [crashWorkerPath, mode, taskStoreDir, tokenFile, effectFile], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_000); });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    get stderr() { return stderr; },
    nextMessage(timeoutMs = 10_000) {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for API peer worker: ${stderr}`));
        }, timeoutMs);
        const waiter = {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); }
        };
        waiters.push(waiter);
      });
    },
    async kill(signal) { child.kill(signal); return await exit; },
    async waitForExit() { return await exit; },
    send(line) { child.stdin.write(`${line}\n`); }
  };
}

test("a peer retry after crash in an indeterminate run returns unresolved without redispatch", async t => {
  const { directory, tokenFile } = await createPeerFixture(t);
  const taskStoreDir = join(directory, "tasks");
  const effectFile = join(directory, "effects.jsonl");
  const key = "caller-task-uuid-indeterminate";
  const body = { goal: "Submit the order", input: { order: "fixture-1" } };
  const first = spawnApiPeerWorker("crash-after-dispatch", taskStoreDir, tokenFile, effectFile);
  t.after(async () => {
    if (first.child.exitCode === null && first.child.signalCode === null) await first.kill("SIGKILL");
  });
  const ready = await first.nextMessage();
  assert.equal(ready.event, "listening");
  const controller = new AbortController();
  const lostResponse = peerRequest(ready.url, key, body, { signal: controller.signal });
  const dispatched = await first.nextMessage();
  assert.equal(dispatched.event, "dispatched");
  controller.abort();
  await assert.rejects(lostResponse, error => error?.name === "AbortError");
  assert.equal((await first.kill("SIGKILL")).signal, "SIGKILL");

  const resumed = spawnApiPeerWorker("serve", taskStoreDir, tokenFile, effectFile);
  t.after(async () => {
    if (resumed.child.exitCode === null && resumed.child.signalCode === null) {
      resumed.send("stop");
      await resumed.waitForExit();
    }
  });
  const resumedReady = await resumed.nextMessage();
  assert.equal(resumedReady.event, "listening");
  const retry = await peerRequest(resumedReady.url, key, body).then(response => response.json());
  assert.equal(retry.status, "unresolved");
  assert.equal(retry.task_id, dispatched.taskId);
  assert.match(retry.error, /reconcile/);
  const effectsAfterRetry = (await readFile(effectFile, "utf8")).trim().split("\n");
  assert.equal(effectsAfterRetry.length, 1, "the original external effect is not dispatched a second time");
  assert.equal(JSON.parse(effectsAfterRetry[0]).taskId, dispatched.taskId);
  resumed.send("stop");
  assert.equal((await resumed.nextMessage()).event, "stopped");
  assert.equal((await resumed.waitForExit()).code, 0, resumed.stderr);
});

test("a persisted reservation with a missing task record restores the same identity as unresolved", async t => {
  const { directory } = await createPeerFixture(t);
  const taskStoreDir = join(directory, "tasks");
  const firstStore = new TaskStore(taskStoreDir);
  await firstStore.init();
  const originalPersist = firstStore.persist.bind(firstStore);
  firstStore.persist = async () => { throw new Error("injected task-record write failure after reservation commit"); };
  const reservation = firstStore.reservePeerTask({
    principalId: "shared-peer-token",
    idempotencyKey: "orphaned-reservation-key",
    fingerprint: "a".repeat(64),
    input: {}
  });
  await assert.rejects(reservation.persisted, /injected task-record write failure/);
  firstStore.persist = originalPersist;
  firstStore.close();

  const restartedStore = new TaskStore(taskStoreDir);
  await restartedStore.init();
  try {
    const retry = restartedStore.reservePeerTask({
      principalId: "shared-peer-token",
      idempotencyKey: "orphaned-reservation-key",
      fingerprint: "a".repeat(64),
      input: {}
    });
    await retry.persisted;
    assert.equal(retry.created, false);
    assert.equal(retry.taskId, reservation.taskId);
    assert.equal(retry.task.status, "reconciling");
    assert.equal(restartedStore.tasks.size, 1);
  } finally {
    restartedStore.close();
  }
});

test("a corrupt peer reservation fails closed without blocking API recovery", async t => {
  const { directory } = await createPeerFixture(t);
  const taskStoreDir = join(directory, "tasks");
  const key = "corrupt-reservation-key";
  const principalDigest = createHash("sha256").update("shared-peer-token").digest("hex");
  const namespaceDigest = createHash("sha256").update(`${principalDigest}\0${key}`).digest("hex");
  const reservationDirectory = join(taskStoreDir, "peer-idempotency");
  await mkdir(reservationDirectory, { recursive: true });
  await writeFile(join(reservationDirectory, `${namespaceDigest}.json`), "{corrupt", { mode: 0o600 });

  const store = new TaskStore(taskStoreDir);
  await store.init();
  try {
    assert.throws(() => store.reservePeerTask({
      principalId: "shared-peer-token",
      idempotencyKey: key,
      fingerprint: "b".repeat(64),
      input: {}
    }), error => error?.code === "TASK_STORE_IDEMPOTENCY_UNRESOLVED");
    assert.equal(store.tasks.size, 0);
  } finally {
    store.close();
  }
});
