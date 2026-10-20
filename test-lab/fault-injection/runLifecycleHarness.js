import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(import.meta.url);

/** Start an isolated OS process that exercises the production run-state stores. */
export function spawnLifecycleWorker(mode, baseDir, input = {}) {
  const child = spawn(process.execPath, [harnessPath, "--worker", mode, baseDir, JSON.stringify(input)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  let stderr = "";
  let ended = null;

  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); }
    catch { message = { event: "invalid-output", line }; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => {
    ended = { code, signal };
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Lifecycle worker exited before replying (${signal ?? code}): ${stderr}`));
    resolve(ended);
  }));

  return {
    child,
    get stderr() { return stderr; },
    async nextMessage(timeoutMs = 10_000) {
      if (messages.length) return messages.shift();
      if (ended) throw new Error(`Lifecycle worker already exited (${ended.signal ?? ended.code}): ${stderr}`);
      return await new Promise((resolve, reject) => {
        const waiter = {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); }
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for lifecycle worker '${mode}': ${stderr}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    send(message) {
      if (child.stdin.destroyed) throw new Error("Lifecycle worker input is closed.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async waitForExit() { return await exit; },
    async kill(signal = "SIGKILL") {
      if (ended) return ended;
      child.kill(signal);
      return await exit;
    }
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let controlLines;
const controlQueue = [];
const controlWaiters = [];

function installControlReader() {
  controlLines = createInterface({ input: process.stdin });
  controlLines.on("line", line => {
    let command;
    try { command = JSON.parse(line); }
    catch {
      for (const waiter of controlWaiters.splice(0)) waiter.reject(new Error("Lifecycle worker received malformed control input."));
      return;
    }
    const waiter = controlWaiters.shift();
    if (waiter) waiter.resolve(command);
    else controlQueue.push(command);
  });
  controlLines.on("close", () => {
    for (const waiter of controlWaiters.splice(0)) waiter.reject(new Error("Lifecycle worker control input closed."));
  });
}

function nextCommand() {
  if (controlQueue.length) return Promise.resolve(controlQueue.shift());
  return new Promise((resolve, reject) => controlWaiters.push({ resolve, reject }));
}

async function runWorker(mode, baseDir, input) {
  installControlReader();
  const { RunStateStore } = await import("../../src/testing/runState.js");
  const store = new RunStateStore(baseDir);
  await store.init();
  try {
    if (mode === "hold-target-lease") {
      const lease = await store.acquireTargetLease(input.targetId, input.runId, { ttlMs: input.ttlMs ?? 5_000 });
      send({ event: "acquired", fencingToken: lease.fencingToken });
      const command = await nextCommand();
      if (command.action === "release") {
        await lease.release();
        send({ event: "released" });
      }
      return;
    }

    if (mode === "compare-and-swap") {
      send({ event: "ready" });
      await nextCommand();
      try {
        await store.update(input.runId, { status: input.status }, { expectedRevision: input.expectedRevision });
        send({ event: "update-result", outcome: "committed" });
      } catch (error) {
        send({ event: "update-result", outcome: "rejected", code: error.code ?? null, message: error.message });
      }
      return;
    }

    if (mode === "reserve-operation") {
      send({ event: "ready" });
      await nextCommand();
      try {
        await store.reserveOperation(input.runId, input.operation);
        if (input.dispatchStatus) {
          await store.recordOperationDispatch(input.runId, {
            operationId: input.operation.operationId,
            status: input.dispatchStatus,
            receiptId: input.receiptId ?? null
          });
        }
        send({ event: "operation-result", outcome: "committed" });
        if (input.crashAfterCommit) await nextCommand();
      } catch (error) {
        send({ event: "operation-result", outcome: "rejected", code: error.code ?? null, message: error.message });
      }
      return;
    }

    if (mode === "register-resource") {
      await store.registerTestOwnedResource(input.runId, input.resource);
      send({ event: "resource-result", outcome: "committed" });
      if (input.crashAfterCommit) await nextCommand();
      return;
    }

    throw new Error(`Unknown lifecycle worker mode '${mode}'.`);
  } finally {
    controlLines.close();
    store.close();
  }
}

if (process.argv[2] === "--worker") {
  try {
    await runWorker(process.argv[3], process.argv[4], JSON.parse(process.argv[5] ?? "{}"));
  } catch (error) {
    send({ event: "error", message: error.message, code: error.code ?? null });
    process.exitCode = 1;
  }
}
