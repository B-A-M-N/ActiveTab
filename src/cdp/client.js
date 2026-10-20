export class CdpError extends Error {
  constructor(message, { code, data, method, timeoutMs = null, callerDeadlineExceeded = false, commandMayStillComplete = false } = {}) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.data = data;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.callerDeadlineExceeded = callerDeadlineExceeded;
    this.commandMayStillComplete = commandMayStillComplete;
  }
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(webSocketUrl, { commandTimeoutMs = 15_000, maxMessageBytes = 32 * 1024 * 1024, socketFactory = url => new WebSocket(url) } = {}) {
    this.webSocketUrl = webSocketUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.socketFactory = socketFactory;
  }

  async connect() {
    if (typeof WebSocket !== "function") throw new Error("Node.js with the built-in WebSocket API is required (Node 22+).");
    const url = new URL(this.webSocketUrl);
    if (url.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
      throw new Error("CDP WebSocket must use a loopback ws:// endpoint.");
    }
    const socket = this.socketFactory(url);
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

  async send(method, params = {}, sessionId = null, options = {}) {
    if (!this.#socket || this.#closed) throw new Error("CDP connection is closed.");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("CDP command options must be an object.");
    }
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("CDP command timeoutMs must be a positive integer.");
    }
    const signal = options.signal ?? null;
    if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      throw new TypeError("CDP command signal must be an AbortSignal.");
    }
    const id = this.#nextId++;
    const body = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    if (Buffer.byteLength(body) > this.maxMessageBytes) throw new Error("CDP request exceeds the configured message limit.");
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, method, signal, abortListener: null };
      const rejectPending = error => {
        if (!this.#takePending(id, pending)) return;
        reject(error);
      };
      this.#pending.set(id, pending);

      if (signal) {
        pending.abortListener = () => rejectPending(new CdpError(`CDP command consumer aborted: ${method}`, {
          code: "CDP_ABORTED",
          method,
          callerDeadlineExceeded: false,
          commandMayStillComplete: true
        }));
        if (signal.aborted) {
          pending.abortListener();
          return;
        }
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }

      pending.timer = setTimeout(() => rejectPending(new CdpError(`CDP command timed out: ${method}`, {
        code: "CDP_TIMEOUT",
        method,
        timeoutMs,
        callerDeadlineExceeded: Object.hasOwn(options, "timeoutMs"),
        commandMayStillComplete: true
      })), timeoutMs);

      try { this.#socket.send(body); }
      catch (error) { rejectPending(error); }
    });
  }

  #takePending(id, pending) {
    if (this.#pending.get(id) !== pending) return false;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return true;
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
      this.#takePending(message.id, pending);
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
    for (const [id, pending] of this.#pending) {
      this.#takePending(id, pending);
      pending.reject(error);
    }
  }
}
