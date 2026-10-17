import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeNativeMessage, NativeMessageDecoder, MAX_EXTENSION_TO_HOST_MESSAGE_BYTES } from "../../native-host/protocol.js";
import { sanitizeUrl } from "../browser/urlPrivacy.js";

export const EXTENSION_ID = "begilomabckehkhinipbibjignhdhnmc";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const PROTOCOL_VERSION = "activetab/native/1";
const MAX_AUTHORIZED_TABS = 8;

function safeTarget(input) {
  if (!input || typeof input.id !== "string" || !Number.isInteger(input.tabId) || input.userAuthorized !== true) {
    throw new Error("Extension did not provide an explicitly authorized page target.");
  }
  const url = sanitizeUrl(input.url);
  if (!url || !new Set(["http:", "https:"]).has(new URL(url).protocol)) throw new Error("Only HTTP(S) page targets can be controlled.");
  return { id: input.id, tabId: input.tabId, title: String(input.title ?? ""), url, type: "page" };
}

export class ExtensionBroker extends EventEmitter {
  constructor({ socketPath, requestTimeoutMs = 30_000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = null;
    this.socket = null;
    this.decoder = null;
    this.nextId = 1;
    this.pending = new Map();
    this.attachedTargets = new Map();
  }

  async start() {
    const path = this.socketPath;
    if (!path) throw new Error("An explicit local broker socket path is required.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dirname(path));
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (typeof process.getuid === "function" && dirStat.uid !== process.getuid())) {
      throw new Error("ActiveTab broker directory must be a real directory owned by the current user.");
    }
    await chmod(dirname(path), 0o700);
    const old = await lstat(path).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (old) {
      if (!old.isSocket() || (typeof process.getuid === "function" && old.uid !== process.getuid())) throw new Error("Refusing to replace a non-owned ActiveTab broker path.");
      await unlink(path);
    }
    this.server = createServer(socket => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const onError = error => { this.server.off("listening", onListen); reject(error); };
      const onListen = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListen);
      this.server.listen(path);
    });
    await chmod(path, 0o600);
    return this;
  }

  #accept(socket) {
    if (this.socket) { socket.destroy(); return; }
    this.socket = socket;
    this.decoder = new NativeMessageDecoder({ maxMessageBytes: MAX_EXTENSION_TO_HOST_MESSAGE_BYTES });
    socket.on("data", chunk => {
      try { for (const message of this.decoder.push(chunk)) this.#onMessage(message); }
      catch (error) { this.#drop(error); }
    });
    socket.on("error", error => this.#drop(error));
    socket.on("close", () => this.#drop(new Error("Native Messaging host disconnected.")));
  }

  #onMessage(message) {
    if (!this.socket) return;
    if (message?.kind === "hello") {
      if (message.extensionId !== EXTENSION_ID || message.protocol !== PROTOCOL_VERSION) {
        this.#drop(new Error("The connected extension identity or protocol is not authorized."));
        return;
      }
      this.#write({ kind: "ready", protocol: PROTOCOL_VERSION });
      this.emit("ready");
      return;
    }
    if (message?.kind === "attached") {
      try {
        if (message.extensionId !== EXTENSION_ID) throw new Error("Unexpected extension identity.");
        const target = safeTarget(message.target);
        if (!this.attachedTargets.has(target.id) && this.attachedTargets.size >= MAX_AUTHORIZED_TABS) throw new Error(`ActiveTab supports at most ${MAX_AUTHORIZED_TABS} explicitly attached tabs at once.`);
        this.attachedTargets.set(target.id, target);
        this.emit("attached", structuredClone(target));
        if (typeof message.id === "string") this.#write({ kind: "attached-ack", id: message.id });
      } catch (error) {
        if (typeof message.id === "string") this.#write({ kind: "attached-ack", id: message.id, error: { message: error.message } });
        else this.#write({ kind: "error", message: error.message });
        this.emit("protocolError", { kind: message.kind, message: error.message });
      }
      return;
    }
    if (message?.kind === "detached") {
      const targetId = message.targetId;
      const previous = this.attachedTargets.get(targetId);
      if (!previous) return;
      this.attachedTargets.delete(targetId);
      this.emit("detached", { targetId: previous.id, reason: String(message.reason ?? "detached") });
      return;
    }
    if (message?.kind === "event") {
      if (!this.attachedTargets.has(message.targetId) || typeof message.method !== "string") return;
      this.emit("cdpEvent", { targetId: message.targetId, method: message.method, params: message.params ?? {}, sessionId: message.sessionId ?? null });
      return;
    }
    if (message?.kind === "response" && Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error.message ?? "Chrome debugger command failed")));
      else pending.resolve(message.result ?? {});
    }
  }

  #write(message) {
    if (!this.socket || this.socket.destroyed) throw new Error("The ActiveTab extension is disconnected.");
    this.socket.write(encodeNativeMessage(message));
  }

  #drop(error) {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    this.decoder = null;
    socket.destroy();
    const previous = [...this.attachedTargets.values()];
    this.attachedTargets.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (previous.length === 0) this.emit("disconnected", { targetId: null, reason: error.message });
    else for (const target of previous) this.emit("disconnected", { targetId: target.id, reason: error.message });
  }

  async listTabs() {
    if (!this.socket) return [];
    return [...this.attachedTargets.values()].map(target => structuredClone(target));
  }

  async resolveTarget(targetId) {
    const attachedTarget = this.attachedTargets.get(targetId);
    if (!this.socket || !attachedTarget) throw new Error("Attach this exact tab from the ActiveTab extension before requesting MCP control.");
    return {
      ...structuredClone(attachedTarget),
      endpoint: "chrome-extension-native-messaging",
      browserClient: new ExtensionCdpTransport(this, targetId),
      rootAlreadyAttached: true,
      ownsBrowserClient: true
    };
  }

  async sendCommand(targetId, method, params = {}, sessionId = null) {
    if (!this.socket || !this.attachedTargets.has(targetId)) throw new Error("The authorized Chrome tab is no longer attached.");
    return this.#request({ kind: "request", method: "cdp.send", targetId, cdpMethod: method, params, sessionId });
  }

  async detach(targetId) {
    if (!this.attachedTargets.has(targetId)) return;
    try { await this.#request({ kind: "request", method: "debugger.detach", targetId }, 5_000); }
    finally { this.attachedTargets.delete(targetId); }
  }

  #request(message, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("The ActiveTab extension is disconnected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome debugger command timed out: ${message.cdpMethod ?? message.method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#write({ ...message, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async close() {
    // Closing/restarting the local broker is a transport lifecycle event, not
    // operator revocation. Leave extension-owned debugger leases intact so
    // the service worker can reconnect and restore the same authorized tabs.
    if (this.socket) this.#drop(new Error("ActiveTab broker is closing."));
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
    await unlink(this.socketPath).catch(() => {});
  }
}

class ExtensionCdpTransport {
  constructor(broker, targetId) {
    this.broker = broker;
    this.targetId = targetId;
    this.listeners = new Map();
    this.closed = false;
    this.disconnected = false;
    this.detached = false;
    this.forwardEvent = payload => {
      if (payload.targetId !== this.targetId) return;
      for (const listener of this.listeners.get(payload.method) ?? []) {
        try { listener(payload.params, payload.sessionId); } catch { /* event consumers are isolated */ }
      }
    };
    this.forwardDetached = payload => {
      if (payload.targetId !== this.targetId) return;
      this.detached = true;
      for (const listener of this.listeners.get("Inspector.detached") ?? []) {
        try { listener({ reason: String(payload.reason ?? "detached") }, null); } catch { /* Target lifecycle observers are isolated. */ }
      }
    };
    this.forwardDisconnected = payload => {
      if (payload.targetId !== null && payload.targetId !== this.targetId) return;
      this.disconnected = true;
      for (const listener of this.listeners.get("CDP.connectionClosed") ?? []) {
        try { listener({ reason: String(payload.reason ?? "Native Messaging host disconnected.") }, null); } catch { /* Transport lifecycle observers are isolated. */ }
      }
    };
    broker.on("cdpEvent", this.forwardEvent);
    broker.on("detached", this.forwardDetached);
    broker.on("disconnected", this.forwardDisconnected);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed) return Promise.reject(new Error("Chrome extension transport is closed."));
    if (this.disconnected) return Promise.reject(new Error("The Chrome extension connection was interrupted; attach a fresh browser session."));
    if (this.detached) return Promise.reject(new Error("The Chrome tab lease was detached; attach a fresh browser session."));
    return this.broker.sendCommand(this.targetId, method, params, sessionId);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.broker.off("cdpEvent", this.forwardEvent);
    this.broker.off("detached", this.forwardDetached);
    this.broker.off("disconnected", this.forwardDisconnected);
    this.listeners.clear();
  }
}
