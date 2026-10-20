import test from "node:test";
import assert from "node:assert/strict";
import { CdpClient } from "../src/cdp/client.js";

class MockWebSocket {
  listeners = new Map();
  sent = [];

  constructor() {
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      entry.listener(event);
      if (entry.once) this.listeners.get(type)?.delete(entry);
    }
  }

  send(body) {
    this.sent.push(JSON.parse(body));
  }

  reply(id, result) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }

  close() {
    this.emit("close");
  }
}

async function connectedClient() {
  const socket = new MockWebSocket();
  const client = await new CdpClient("ws://127.0.0.1/devtools/page/mock", {
    commandTimeoutMs: 1_000,
    socketFactory: () => socket
  }).connect();
  return { client, socket };
}

test("per-command timeout drops the pending reply association and ignores late replies", async () => {
  const { client, socket } = await connectedClient();
  try {
    const timedOut = client.send("DOM.getNodeForLocation", {}, null, { timeoutMs: 40 });
    const timedOutId = socket.sent[0].id;
    await assert.rejects(timedOut, error => error.code === "CDP_TIMEOUT"
      && error.callerDeadlineExceeded === true
      && error.commandMayStillComplete === true);

    const current = client.send("DOM.getNodeForLocation", {}, null, { timeoutMs: 500 });
    const currentId = socket.sent[1].id;
    let currentSettled = false;
    current.then(() => { currentSettled = true; });
    socket.reply(timedOutId, { backendNodeId: 11 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentSettled, false, "a late reply cannot settle a newer request");

    socket.reply(currentId, { backendNodeId: 22 });
    assert.deepEqual(await current, { backendNodeId: 22 });
  } finally {
    await client.close();
  }
});

test("aborting a targeted query releases its consumer without claiming browser cancellation", async () => {
  const { client, socket } = await connectedClient();
  try {
    const controller = new AbortController();
    const request = client.send("DOM.getNodeForLocation", {}, null, { timeoutMs: 500, signal: controller.signal });
    const requestId = socket.sent[0].id;
    controller.abort();
    await assert.rejects(request, error => error.code === "CDP_ABORTED"
      && error.commandMayStillComplete === true
      && error.callerDeadlineExceeded === false);

    socket.reply(requestId, { backendNodeId: 99 });
    const next = client.send("Runtime.evaluate", {}, null, { timeoutMs: 500 });
    const nextId = socket.sent[1].id;
    socket.reply(nextId, { result: { value: "current" } });
    assert.deepEqual(await next, { result: { value: "current" } });
  } finally {
    await client.close();
  }
});
