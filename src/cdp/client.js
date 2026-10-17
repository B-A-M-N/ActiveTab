export class CdpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(webSocketUrl, { commandTimeoutMs = 15_000, maxMessageBytes = 32 * 1024 * 1024 } = {}) {
    this.webSocketUrl = webSocketUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
  }

  async connect() {
    if (typeof WebSocket !== "function") throw new Error("Node.js with the built-in WebSocket API is required (Node 22+).");
    const url = new URL(this.webSocketUrl);
    if (url.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
      throw new Error("CDP WebSocket must use a loopback ws:// endpoint.");
    }
    const socket = new WebSocket(url);
    this.#socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the local CDP target.")), this.commandTimeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the local CDP target.")); }, { once: true });
    });
    socket.addEventListener("message", event => this.#onMessage(event.data));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", () => this.#onClose());
    return this;
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  async send(method, params = {}, sessionId = null) {
    if (!this.#socket || this.#closed) throw new Error("CDP connection is closed.");
    const id = this.#nextId++;
    const body = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw new Error("CDP request exceeds the configured message limit.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`, { method }));
      }, this.commandTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#socket.send(body);
    });
  }

  async close() {
    if (!this.#socket || this.#closed) return;
    this.#socket.close();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 500);
      this.#socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    this.#onClose();
  }

  #onMessage(raw) {
    const data = typeof raw === "string" ? raw : String(raw);
    if (Buffer.byteLength(data) > this.maxMessageBytes) {
      this.#onClose(new Error("CDP response exceeds the configured message limit."));
      return;
    }
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CdpError(message.error.message ?? "CDP command failed", { ...message.error, method: pending.method }));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}, message.sessionId ?? null); } catch { /* event consumers are isolated */ }
    }
  }

  #onClose(error = new Error("CDP connection closed.")) {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners.get("CDP.connectionClosed") ?? []) {
      try { listener({ reason: String(error?.message ?? error) }, null); } catch { /* Transport lifecycle observers are isolated. */ }
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
