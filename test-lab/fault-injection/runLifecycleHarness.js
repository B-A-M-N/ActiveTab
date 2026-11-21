import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
  if (mode === "atomic-replace") {
    const { RunDocumentStore } = await import("../../src/testing/lifecycle/runDocumentStore.js");
    const documents = new RunDocumentStore(baseDir);
    await documents.init();
    await documents.writeAtomic(input.nextRun, {
      beforeRename: async () => {
        send({ event: "replacement-ready" });
        await nextCommand();
      }
    });
    return;
  }
  if (mode === "cdp-verification-pending") {
    const { BrowserSession } = await import("../../src/browser/session.js");
    const { resolveAuthorizedTarget } = await import("../../src/browser/targets.js");
    const { TestRunner } = await import("../../src/testing/runner.js");
    const { RunStateStore } = await import("../../src/testing/runState.js");
    const target = await resolveAuthorizedTarget(input.endpoint, input.targetId, input.targetId);
    const session = await new BrowserSession(target).attach();
    const store = new RunStateStore(baseDir);
    await store.init();
    try {
      let actionDispatched = false;
      let verificationPaused = false;
      const click = session.click.bind(session);
      session.click = async (...args) => {
        const result = await click(...args);
        actionDispatched = true;
        return result;
      };
      const observe = session.observe.bind(session);
      session.observe = async (...args) => {
        const result = await observe(...args);
        if (actionDispatched && !verificationPaused) {
          verificationPaused = true;
          send({ event: "postcondition-verification-paused", evidenceId: result.evidenceId });
          await nextCommand();
        }
        return result;
      };
      const operationAuthorizer = {
        authorize({ action, candidate, observation }) {
          const allowed = action === "click"
            && candidate?.name === input.buttonName
            && observation?.page?.url === input.pageUrl;
          return { allowed, category: "test_cdp_postcondition_crash", reason: "The fixture contract permits one exact loopback control." };
        }
      };
      await new TestRunner({
        session,
        environment: input.environment,
        runStateStore: store,
        operationAuthorizer
      }).run({
        id: "cdp-postcondition-crash-workflow",
        name: "Pause after dispatch during postcondition verification",
        steps: [{
          id: "count-effect",
          type: "interact",
          goal: "Count the durable verification fixture effect",
          action: {
            type: "click",
            operationId: "test.cdp_postcondition_crash",
            target: { name: input.buttonName },
            postcondition: { type: "page_title_contains", value: input.pageTitle }
          }
        }]
      }, { runId: input.runId });
      send({ event: "workflow-completed" });
    } finally {
      await session.close().catch(() => {});
      store.close();
    }
    return;
  }
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

    if (mode === "verification-pending") {
      await store.reserveOperation(input.runId, input.operation);
      await store.recordOperationDispatch(input.runId, {
        operationId: input.operation.operationId,
        status: "DISPATCHED",
        receiptId: input.receiptId ?? null
      });
      // Model one independently visible fixture effect, then hold inside the
      // postcondition verifier until the parent terminates this process.
      await writeFile(input.effectOraclePath, "1\n", { mode: 0o600 });
      send({ event: "postcondition-verification-started" });
      await nextCommand();
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
