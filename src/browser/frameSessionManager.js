function createFrameClient(transport, sessionId) {
  return {
    send: (method, params = {}, options = {}) => transport.send(
      method,
      params,
      sessionId(),
      options && typeof options === "object" && !Array.isArray(options) ? options : {}
    ),
    on: (method, listener) => transport.on(method, (params, eventSessionId) => {
      if ((eventSessionId ?? null) === (sessionId() ?? null)) listener(params);
    })
  };
}

const IFRAME_TARGET_FILTER = [{ type: "iframe", exclude: false }];
const MAX_OUT_OF_PROCESS_SESSIONS = 16;
const FRAME_NETWORK_TOTAL_BUFFER_BYTES = 512 * 1024;
const FRAME_NETWORK_RESOURCE_BUFFER_BYTES = 128 * 1024;
const DOM_MUTATION_EVENTS = [
  "DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.attributeModified", "DOM.attributeRemoved",
  "DOM.characterDataModified", "DOM.childNodeCountUpdated", "DOM.shadowRootPushed", "DOM.shadowRootPopped",
  "DOM.pseudoElementAdded", "DOM.pseudoElementRemoved", "DOM.inlineStyleInvalidated", "DOM.distributedNodesUpdated"
];
const NETWORK_EVENTS = [
  "Network.requestWillBeSent", "Network.responseReceived", "Network.dataReceived", "Network.loadingFinished", "Network.loadingFailed"
];

/** Owns OOPIF attachment and event lifecycles for one already-authorized root target. */
export class FrameSessionManager {
  frameSessions = new Map();
  attachmentAvailable = false;
  attachmentError = null;
  attachmentOmitted = 0;

  constructor(session, { onTargetDetached, onGenerationChange, subscribeDomTree, scheduleDomSubscription } = {}) {
    this.session = session;
    this.onTargetDetached = onTargetDetached;
    this.onGenerationChange = onGenerationChange;
    this.subscribeDomTree = subscribeDomTree;
    this.scheduleDomSubscription = scheduleDomSubscription;
  }

  subscribe() {
    const { transport } = this.session;
    return [
      transport.on("Target.attachedToTarget", (params, parentSessionId) => this.#onTargetAttached(params, parentSessionId)),
      transport.on("Target.detachedFromTarget", (params, parentSessionId) => this.#onTargetDetached(params, parentSessionId))
    ];
  }

  async enable() {
    await this.session.client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: IFRAME_TARGET_FILTER
    });
    this.attachmentAvailable = true;
    await this.#awaitExistingFrameTargets();
  }

  markAttachmentFailure(error) {
    this.attachmentAvailable = false;
    this.attachmentError = error?.message ?? String(error);
  }

  get(targetId) { return this.frameSessions.get(targetId); }
  has(targetId) { return this.frameSessions.has(targetId); }
  values() { return this.frameSessions.values(); }

  async refreshDomSubscriptions() {
    const pending = [...this.frameSessions.values()].filter(frame =>
      frame.status === "ready" && frame.domEnabled && !frame.domObservationAvailable
    );
    let refreshed = 0;
    await Promise.all(pending.map(async frame => {
      const available = await this.subscribeDomTree?.(frame.client);
      if (this.frameSessions.get(frame.targetId) === frame && frame.status === "ready") {
        frame.domObservationAvailable = available === true;
        if (available === true) refreshed++;
      }
    }));
    return refreshed;
  }

  #isManagedParentSession(parentSessionId) {
    const parent = parentSessionId ?? null;
    if (parent === (this.session.sessionId ?? null)) return true;
    return [...this.frameSessions.values()].some(frame => frame.sessionId === parent && frame.status !== "detached");
  }

  #onTargetAttached(params, parentSessionId) {
    const targetInfo = params?.targetInfo;
    const childSessionId = params?.sessionId;
    const session = this.session;
    if (!session.attached || targetInfo?.type !== "iframe" || typeof targetInfo.targetId !== "string"
      || typeof childSessionId !== "string" || !this.#isManagedParentSession(parentSessionId)) return;
    if (this.frameSessions.has(targetInfo.targetId)) return;
    if (this.frameSessions.size >= MAX_OUT_OF_PROCESS_SESSIONS) {
      this.attachmentOmitted++;
      session.transport.send("Target.detachFromTarget", { sessionId: childSessionId }, parentSessionId ?? null).catch(() => {});
      return;
    }
    const frame = {
      targetId: targetInfo.targetId,
      frameId: targetInfo.targetId,
      parentFrameId: typeof targetInfo.parentFrameId === "string" ? targetInfo.parentFrameId : null,
      targetInfo: structuredClone(targetInfo),
      parentSessionId: parentSessionId ?? null,
      sessionId: childSessionId,
      client: null,
      status: "attaching",
      generation: 1,
      error: null,
      ready: null,
      domEnabled: false,
      domObservationAvailable: false,
      networkObservationAvailable: false,
      domSubscriptionScheduled: false,
      disposers: []
    };
    frame.client = createFrameClient(session.transport, () => frame.sessionId);
    this.frameSessions.set(frame.targetId, frame);
    this.onGenerationChange?.();
    this.#bindFrameEvents(frame);
    frame.ready = this.#initializeFrameTarget(frame).then(() => {
      frame.status = "ready";
    }).catch(error => {
      frame.status = "failed";
      frame.error = String(error?.message ?? error).slice(0, 300);
      this.attachmentError ??= frame.error;
    });
  }

  #onTargetDetached(params, parentSessionId) {
    const session = this.session;
    if (session.sessionId && params?.sessionId === session.sessionId && (parentSessionId ?? null) === null) {
      this.onTargetDetached?.("Target.detachedFromTarget");
      return;
    }
    const frame = [...this.frameSessions.values()].find(item => item.sessionId === params?.sessionId);
    if (!frame || (parentSessionId ?? null) !== frame.parentSessionId) return;
    frame.status = "detached";
    for (const dispose of frame.disposers.splice(0)) dispose();
    this.frameSessions.delete(frame.targetId);
    this.onGenerationChange?.();
  }

  markParentDetached() {
    for (const frame of this.frameSessions.values()) {
      frame.status = "detached";
      for (const dispose of frame.disposers.splice(0)) dispose();
    }
    this.frameSessions.clear();
  }

  #bindFrameEvents(frame) {
    const client = frame.client;
    const session = this.session;
    const recordLifecycle = (method, event) => session.activity.recordLifecycleEvent(method, { ...event, frameTargetId: frame.targetId });
    frame.disposers.push(client.on("Page.lifecycleEvent", event => recordLifecycle("Page.lifecycleEvent", event)));
    frame.disposers.push(client.on("Page.frameNavigated", event => {
      frame.frameId = event.frame?.id ?? frame.frameId;
      frame.generation++;
      recordLifecycle("Page.frameNavigated", event);
      this.onGenerationChange?.();
    }));
    frame.disposers.push(client.on("Page.navigatedWithinDocument", event => {
      frame.generation++;
      recordLifecycle("Page.navigatedWithinDocument", event);
      this.onGenerationChange?.();
    }));
    for (const method of ["Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.domContentEventFired", "Page.loadEventFired"]) {
      frame.disposers.push(client.on(method, event => recordLifecycle(method, event)));
    }
    frame.disposers.push(client.on("DOM.documentUpdated", event => {
      frame.generation++;
      this.onGenerationChange?.();
      frame.domObservationAvailable = false;
      recordLifecycle("DOM.documentUpdated", event);
      this.scheduleDomSubscription?.(client, frame);
    }));
    for (const method of DOM_MUTATION_EVENTS) {
      frame.disposers.push(client.on(method, event => session.activity.recordDomMutation(method, { ...event, frameTargetId: frame.targetId })));
    }
    for (const method of NETWORK_EVENTS) {
      frame.disposers.push(client.on(method, event => session.activity.recordNetworkEvent(method, event, { frameTargetId: frame.targetId })));
    }
  }

  async #initializeFrameTarget(frame) {
    const client = frame.client;
    await client.send("Page.enable");
    await client.send("DOM.enable");
    frame.domEnabled = true;
    await client.send("Runtime.enable");
    frame.domObservationAvailable = await this.subscribeDomTree?.(client);
    try { await client.send("Page.setLifecycleEventsEnabled", { enabled: true }); }
    catch { /* Some CDP-compatible targets omit optional lifecycle events. */ }
    try {
      await client.send("Network.enable", { maxTotalBufferSize: FRAME_NETWORK_TOTAL_BUFFER_BYTES, maxResourceBufferSize: FRAME_NETWORK_RESOURCE_BUFFER_BYTES });
      frame.networkObservationAvailable = true;
    } catch { frame.networkObservationAvailable = false; }
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: IFRAME_TARGET_FILTER
    });
  }

  async #awaitExistingFrameTargets(timeoutMs = 500) {
    const session = this.session;
    if (session.ownsTransport) return;
    const { targetInfos = [] } = await session.transport.send("Target.getTargets");
    const expected = targetInfos.filter(item => item?.type === "iframe" && item.parentId === session.target.id).map(item => item.targetId);
    if (!expected.length) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (expected.every(targetId => this.frameSessions.has(targetId))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async getOutOfProcessFrames({ onCdpRoundTrip } = {}) {
    const session = this.session;
    let expected = new Set(this.frameSessions.keys());
    if (!session.ownsTransport && this.attachmentAvailable) {
      try {
        const startedAt = performance.now();
        let targetInfos = [];
        try { ({ targetInfos = [] } = await session.transport.send("Target.getTargets")); }
        finally { onCdpRoundTrip?.("Target.getTargets", performance.now() - startedAt); }
        const iframeTargets = targetInfos.filter(item => item?.type === "iframe" && typeof item.targetId === "string");
        const parents = new Set([session.target.id]);
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const info of iframeTargets) {
            if (!parents.has(info.parentId) || parents.has(info.targetId)) continue;
            parents.add(info.targetId);
            expanded = true;
          }
        }
        expected = new Set(iframeTargets.filter(info => parents.has(info.targetId)).map(info => info.targetId));
      } catch { /* The browser target list is unavailable on some CDP endpoints. */ }
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && [...expected].some(targetId => this.frameSessions.get(targetId)?.status !== "ready")) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return [...expected].map(targetId => this.frameSessions.get(targetId)).filter(frame => frame?.status === "ready");
  }

  async detachAll() {
    for (const frame of [...this.frameSessions.values()].reverse()) {
      try { await this.session.transport.send("Target.detachFromTarget", { sessionId: frame.sessionId }, frame.parentSessionId); }
      catch { /* Detaching the selected parent target below also tears down owned descendants. */ }
      for (const dispose of frame.disposers.splice(0)) dispose();
    }
    this.frameSessions.clear();
  }

  networkClientForTarget(frameTargetId = null) {
    if (!frameTargetId) return this.session.networkObservationAvailable ? this.session.client : null;
    const frame = this.frameSessions.get(frameTargetId);
    return frame?.status === "ready" && frame.networkObservationAvailable ? frame.client : null;
  }
}

