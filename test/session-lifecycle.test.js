import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../src/browser/session.js";

class MockTransport {
  listeners = new Map();
  commands = [];

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method, params = {}, sessionId = null) {
    for (const listener of this.listeners.get(method) ?? []) listener(params, sessionId);
  }

  async send(method, params = {}, sessionId = null) {
    this.commands.push({ method, params, sessionId });
    if (method === "Target.attachToTarget") return { sessionId: "root-session" };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "Target.getTargets") return { targetInfos: [] };
    return {};
  }
}

test("a detached authorized tab stops observations and native actions immediately", async () => {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "selected-tab-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();

  assert.equal(session.targetLifecycle, "attached");
  transport.emit("Target.detachedFromTarget", { sessionId: "root-session", targetId: "selected-tab-target" });
  assert.equal(session.targetLifecycle, "detached");
  assert.equal(session.attached, false);

  const commandCount = transport.commands.length;
  await assert.rejects(() => session.observe(), /authorized browser target is detached/);
  await assert.rejects(() => session.click({ targetId: "selected-tab-target" }), /authorized browser target is detached/);
  await session.waitForChange(5_000);
  assert.equal(transport.commands.length, commandCount, "a detached session does not issue more CDP commands or wait for the timeout");
  await session.close();
});

test("a lost CDP or Native Messaging transport invalidates the current target session", async () => {
  const transport = new MockTransport();
  const session = await new BrowserSession({
    id: "transport-loss-target",
    endpoint: "local-cdp",
    browserClient: transport
  }).attach();

  transport.emit("CDP.connectionClosed", { reason: "The local browser connection closed." });

  assert.equal(session.targetLifecycle, "detached");
  await assert.rejects(() => session.observe(), /authorized browser target is detached/);
  await session.close();
});
