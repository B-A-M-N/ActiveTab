import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionBroker, EXTENSION_ID } from "../src/extension/broker.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/protocol.js";

function readMessage(socket) {
  const decoder = new NativeMessageDecoder();
  return new Promise((resolve, reject) => {
    const onError = error => { socket.off("data", onData); reject(error); };
    const onData = chunk => {
      try {
        const [message] = decoder.push(chunk);
        if (message) { socket.off("error", onError); socket.off("data", onData); resolve(message); }
      } catch (error) { socket.off("error", onError); socket.off("data", onData); reject(error); }
    };
    socket.on("error", onError);
    socket.on("data", onData);
  });
}

async function connectExtension(socketPath) {
  const socket = connect(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(encodeNativeMessage({ kind: "hello", protocol: "activetab/native/1", extensionId: EXTENSION_ID }));
  assert.equal((await readMessage(socket)).kind, "ready");
  return socket;
}

test("extension broker accepts only explicitly authorized target and relays CDP commands and session events", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-extension-"));
  const socketPath = join(dir, "broker.sock");
  const broker = await new ExtensionBroker({ socketPath, requestTimeoutMs: 1_000 }).start();
  const extension = await connectExtension(socketPath);
  t.after(async () => { extension.destroy(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const dirMode = (await stat(dir)).mode & 0o777;
  const socketMode = (await stat(socketPath)).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(socketMode, 0o600);

  const attached = new Promise(resolve => broker.once("attached", resolve));
  const acknowledgment = readMessage(extension);
  extension.write(encodeNativeMessage({ kind: "attached", id: "attach-1", extensionId: EXTENSION_ID, target: {
    id: "page-authorized", tabId: 17, title: "Account", url: "https://example.test/account?token=private#section", userAuthorized: true
  } }));
  await attached;
  assert.deepEqual(await acknowledgment, { kind: "attached-ack", id: "attach-1" });
  const [target] = await broker.listTabs();
  assert.deepEqual(target, { id: "page-authorized", tabId: 17, title: "Account", url: "https://example.test/account", type: "page" });
  await assert.rejects(broker.resolveTarget("other-page"), /exact tab/);
  const resolved = await broker.resolveTarget("page-authorized");
  assert.equal(resolved.rootAlreadyAttached, true);
  assert.equal(resolved.ownsBrowserClient, true);

  const commandPromise = resolved.browserClient.send("Runtime.evaluate", { expression: "document.title" }, "frame-session-1");
  const command = await readMessage(extension);
  assert.equal(command.kind, "request");
  assert.equal(command.method, "cdp.send");
  assert.equal(command.targetId, "page-authorized");
  assert.equal(command.cdpMethod, "Runtime.evaluate");
  assert.equal(command.sessionId, "frame-session-1");
  extension.write(encodeNativeMessage({ kind: "response", id: command.id, result: { result: { value: "Account" } } }));
  assert.deepEqual(await commandPromise, { result: { value: "Account" } });

  const eventPromise = new Promise(resolve => resolved.browserClient.on("Page.lifecycleEvent", (params, sessionId) => resolve({ params, sessionId })));
  extension.write(encodeNativeMessage({ kind: "event", targetId: "page-authorized", method: "Page.lifecycleEvent", params: { name: "load" }, sessionId: "frame-session-1" }));
  assert.deepEqual(await eventPromise, { params: { name: "load" }, sessionId: "frame-session-1" });

  const targetDetached = new Promise(resolve => resolved.browserClient.on("Inspector.detached", (params, sessionId) => resolve({ params, sessionId })));
  broker.emit("detached", { targetId: "page-authorized", reason: "target_closed" });
  assert.deepEqual(await targetDetached, { params: { reason: "target_closed" }, sessionId: null });
  const transportClosed = new Promise(resolve => resolved.browserClient.on("CDP.connectionClosed", (params, sessionId) => resolve({ params, sessionId })));
  broker.emit("disconnected", { targetId: "page-authorized", reason: "native host stopped" });
  assert.deepEqual(await transportClosed, { params: { reason: "native host stopped" }, sessionId: null });

  const leaseDetached = new Promise(resolve => broker.once("detached", resolve));
  extension.write(encodeNativeMessage({ kind: "detached", targetId: "page-authorized", reason: "target_closed" }));
  assert.equal((await leaseDetached).targetId, "page-authorized");
  const reattached = new Promise(resolve => broker.once("attached", resolve));
  const reattachAcknowledgment = readMessage(extension);
  extension.write(encodeNativeMessage({ kind: "attached", id: "attach-again", extensionId: EXTENSION_ID, target: {
    id: "page-authorized", tabId: 17, title: "Account", url: "https://example.test/account", userAuthorized: true
  } }));
  assert.equal((await reattached).id, "page-authorized");
  assert.deepEqual(await reattachAcknowledgment, { kind: "attached-ack", id: "attach-again" });
  await resolved.browserClient.close();
  assert.deepEqual((await broker.listTabs()).map(target => target.id), ["page-authorized"], "closing the stale transport cannot detach a newly authorized lease");
  const finalDetach = new Promise(resolve => broker.once("detached", resolve));
  extension.write(encodeNativeMessage({ kind: "detached", targetId: "page-authorized", reason: "test-cleanup" }));
  await finalDetach;
  assert.deepEqual(await broker.listTabs(), []);
});

test("extension broker rejects missing consent, insecure pages, and unexpected extension identities", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-extension-reject-"));
  const broker = await new ExtensionBroker({ socketPath: join(dir, "broker.sock"), requestTimeoutMs: 200 }).start();
  const extension = await connectExtension(broker.socketPath);
  t.after(async () => { extension.destroy(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
  extension.write(encodeNativeMessage({ kind: "attached", id: "reject-1", extensionId: EXTENSION_ID, target: { id: "no-consent", tabId: 1, url: "https://example.test", userAuthorized: false } }));
  assert.deepEqual(await readMessage(extension), { kind: "attached-ack", id: "reject-1", error: { message: "Extension did not provide an explicitly authorized page target." } });
  extension.write(encodeNativeMessage({ kind: "attached", id: "reject-2", extensionId: EXTENSION_ID, target: { id: "file-page", tabId: 1, url: "file:///tmp/page.html", userAuthorized: true } }));
  assert.deepEqual(await readMessage(extension), { kind: "attached-ack", id: "reject-2", error: { message: "Only HTTP(S) page targets can be controlled." } });
  extension.write(encodeNativeMessage({ kind: "attached", id: "reject-3", extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", target: { id: "fake-extension", tabId: 1, url: "https://example.test", userAuthorized: true } }));
  assert.deepEqual(await readMessage(extension), { kind: "attached-ack", id: "reject-3", error: { message: "Unexpected extension identity." } });
  assert.deepEqual(await broker.listTabs(), []);
});

test("extension broker routes two authorized tabs independently and detaches only the selected lease", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-extension-multi-"));
  const broker = await new ExtensionBroker({ socketPath: join(dir, "broker.sock"), requestTimeoutMs: 1_000 }).start();
  const extension = await connectExtension(broker.socketPath);
  t.after(async () => { extension.destroy(); await broker.close(); await rm(dir, { recursive: true, force: true }); });

  for (const [id, tabId] of [["page-one", 21], ["page-two", 22]]) {
    const attached = new Promise(resolve => broker.once("attached", resolve));
    const acknowledgment = readMessage(extension);
    extension.write(encodeNativeMessage({ kind: "attached", id: `attach-${id}`, extensionId: EXTENSION_ID, target: {
      id, tabId, title: id, url: `https://${id}.test/`, userAuthorized: true
    } }));
    assert.equal((await attached).id, id);
    assert.deepEqual(await acknowledgment, { kind: "attached-ack", id: `attach-${id}` });
  }

  assert.deepEqual((await broker.listTabs()).map(target => target.id), ["page-one", "page-two"]);
  const first = await broker.resolveTarget("page-one");
  const second = await broker.resolveTarget("page-two");
  let firstEvents = 0;
  let secondEvents = 0;
  first.browserClient.on("Page.lifecycleEvent", () => firstEvents++);
  const secondEvent = new Promise(resolve => second.browserClient.on("Page.lifecycleEvent", () => { secondEvents++; resolve(); }));
  extension.write(encodeNativeMessage({ kind: "event", targetId: "page-two", method: "Page.lifecycleEvent", params: { name: "load" } }));
  await Promise.race([secondEvent, new Promise((_, reject) => setTimeout(() => reject(new Error("The selected tab did not receive its CDP event.")), 500))]);
  assert.equal(firstEvents, 0);
  assert.equal(secondEvents, 1);

  const commandPromise = second.browserClient.send("Runtime.evaluate", { expression: "document.title" });
  const command = await readMessage(extension);
  assert.equal(command.targetId, "page-two");
  extension.write(encodeNativeMessage({ kind: "response", id: command.id, result: { result: { value: "page-two" } } }));
  assert.deepEqual(await commandPromise, { result: { value: "page-two" } });

  const closePromise = second.browserClient.close();
  const detach = await readMessage(extension);
  assert.equal(detach.targetId, "page-two");
  extension.write(encodeNativeMessage({ kind: "response", id: detach.id, result: { detached: true } }));
  await closePromise;
  assert.deepEqual((await broker.listTabs()).map(target => target.id), ["page-one"]);

  const remainingCommand = first.browserClient.send("Runtime.evaluate", { expression: "document.title" });
  const remaining = await readMessage(extension);
  assert.equal(remaining.targetId, "page-one");
  extension.write(encodeNativeMessage({ kind: "response", id: remaining.id, result: { result: { value: "page-one" } } }));
  assert.deepEqual(await remainingCommand, { result: { value: "page-one" } });
  const lastClose = first.browserClient.close();
  const lastDetach = await readMessage(extension);
  extension.write(encodeNativeMessage({ kind: "response", id: lastDetach.id, result: { detached: true } }));
  await lastClose;
  assert.deepEqual(await broker.listTabs(), []);
});
