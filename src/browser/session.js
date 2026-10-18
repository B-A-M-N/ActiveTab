import { createHash } from "node:crypto";
import { CdpClient } from "../cdp/client.js";
import { BrowserActivityRecorder } from "./activity.js";
import { BrowserObserver } from "../observe/observer.js";
import { isOperatorProhibitedControl, operatorProhibitedControlReason } from "../runtime/controlRestrictions.js";

function createSessionClient(transport, sessionId) {
  return {
    send: (method, params = {}) => transport.send(method, params, sessionId()),
    on: (method, listener) => transport.on(method, (params, eventSessionId) => {
      if ((eventSessionId ?? null) === (sessionId() ?? null)) listener(params);
    })
  };
}

function assertControlAllowed(candidate, actionType) {
  if (isOperatorProhibitedControl(candidate, actionType)) throw new Error(operatorProhibitedControlReason());
}

async function replaceFocusedText(client, value) {
  const modifier = process.platform === "darwin"
    ? { key: "Meta", code: "MetaLeft", keyCode: 91, flag: 4 }
    : { key: "Control", code: "ControlLeft", keyCode: 17, flag: 2 };
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: modifier.key, code: modifier.code,
    windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode
  });
  try {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", modifiers: modifier.flag,
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", modifiers: modifier.flag,
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
    });
  } finally {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: modifier.key, code: modifier.code,
      windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode
    }).catch(() => {});
  }
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  });
  if (value) await client.send("Input.insertText", { text: value });
}

const IFRAME_TARGET_FILTER = [{ type: "iframe", exclude: false }];
const MAX_OUT_OF_PROCESS_SESSIONS = 16;
const ROOT_NETWORK_TOTAL_BUFFER_BYTES = 8 * 1024 * 1024;
const ROOT_NETWORK_RESOURCE_BUFFER_BYTES = 512 * 1024;
const FRAME_NETWORK_TOTAL_BUFFER_BYTES = 512 * 1024;
const FRAME_NETWORK_RESOURCE_BUFFER_BYTES = 128 * 1024;

export class BrowserSession {
  constructor(target, { evidenceLimit = 12 } = {}) {
    this.target = target;
    this.transport = target.browserClient ?? new CdpClient(target.webSocketDebuggerUrl);
    this.ownsTransport = !target.browserClient;
    this.ownsBrowserClient = target.ownsBrowserClient === true;
    this.rootAlreadyAttached = target.rootAlreadyAttached === true;
    this.sessionId = null;
    this.client = createSessionClient(this.transport, () => this.sessionId);
    this.documentGeneration = 0;
    this.attached = false;
    this.targetLifecycle = "created";
    this.targetDetachReason = null;
    this.frameSessions = new Map();
    this.frameAttachmentAvailable = false;
    this.frameAttachmentError = null;
    this.frameAttachmentOmitted = 0;
    this.activity = new BrowserActivityRecorder();
    this.networkObservationAvailable = false;
    this.domObservationAvailable = false;
    this.domEnabled = false;
    this.domSubscriptionScheduled = false;
    this.observer = new BrowserObserver(this, { evidenceLimit });
    this.pendingDialog = null;
    this.disposers = [];
  }

  async attach() {
    if (this.ownsTransport) await this.transport.connect();
    this.attached = true;
    this.targetLifecycle = "attaching";
    try {
      if (!this.ownsTransport) {
        if (!this.rootAlreadyAttached) {
          const attached = await this.transport.send("Target.attachToTarget", { targetId: this.target.id, flatten: true });
          if (typeof attached.sessionId !== "string") throw new Error("Chrome did not create a flattened CDP target session.");
          this.sessionId = attached.sessionId;
        }
      }
      this.disposers.push(this.transport.on("Target.attachedToTarget", (params, parentSessionId) => this.#onTargetAttached(params, parentSessionId)));
      this.disposers.push(this.transport.on("Target.detachedFromTarget", (params, parentSessionId) => this.#onTargetDetached(params, parentSessionId)));
      this.disposers.push(this.transport.on("CDP.connectionClosed", event => this.#markTargetDetached(event?.reason ?? "CDP connection closed.")));
      this.disposers.push(this.client.on("Inspector.detached", event => this.#markTargetDetached(event?.reason ?? "Inspector session detached.")));
      this.disposers.push(this.client.on("Page.lifecycleEvent", event => this.activity.recordLifecycleEvent("Page.lifecycleEvent", event)));
      this.disposers.push(this.client.on("Page.frameNavigated", event => {
        this.activity.recordLifecycleEvent("Page.frameNavigated", event);
        // Any frame navigation invalidates identities from the previous observed frame tree.
        this.documentGeneration++;
      }));
      this.disposers.push(this.client.on("Page.navigatedWithinDocument", event => {
        this.documentGeneration++;
        this.activity.recordLifecycleEvent("Page.navigatedWithinDocument", event);
      }));
      this.disposers.push(this.client.on("Page.frameStartedLoading", event => this.activity.recordLifecycleEvent("Page.frameStartedLoading", event)));
      this.disposers.push(this.client.on("Page.frameStoppedLoading", event => this.activity.recordLifecycleEvent("Page.frameStoppedLoading", event)));
      this.disposers.push(this.client.on("Page.javascriptDialogOpening", event => {
        this.#onDialogOpening(event);
      }));
      this.disposers.push(this.client.on("Page.domContentEventFired", event => this.activity.recordLifecycleEvent("Page.domContentEventFired", event)));
      this.disposers.push(this.client.on("Page.loadEventFired", event => this.activity.recordLifecycleEvent("Page.loadEventFired", event)));
      this.disposers.push(this.client.on("DOM.documentUpdated", event => {
        this.documentGeneration++;
        this.domObservationAvailable = false;
        this.activity.recordLifecycleEvent("DOM.documentUpdated", event);
        this.#scheduleDomSubscription();
      }));
      for (const method of ["DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.attributeModified", "DOM.attributeRemoved", "DOM.characterDataModified", "DOM.childNodeCountUpdated", "DOM.shadowRootPushed", "DOM.shadowRootPopped", "DOM.pseudoElementAdded", "DOM.pseudoElementRemoved", "DOM.inlineStyleInvalidated", "DOM.distributedNodesUpdated"]) {
        this.disposers.push(this.client.on(method, event => this.activity.recordDomMutation(method, event)));
      }
      for (const method of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]) {
        this.disposers.push(this.client.on(method, event => this.activity.recordNetworkEvent(method, event)));
      }
      await this.client.send("Page.enable");
      await this.client.send("DOM.enable");
      this.domEnabled = true;
      await this.client.send("Runtime.enable");
      await this.#subscribeDomTree();
      try {
        await this.client.send("Page.setLifecycleEventsEnabled", { enabled: true });
      } catch { /* Some CDP-compatible targets omit optional lifecycle events. */ }
      try {
        await this.client.send("Network.enable", { maxTotalBufferSize: ROOT_NETWORK_TOTAL_BUFFER_BYTES, maxResourceBufferSize: ROOT_NETWORK_RESOURCE_BUFFER_BYTES });
        this.networkObservationAvailable = true;
      } catch { this.networkObservationAvailable = false; }
      try {
        await this.client.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: IFRAME_TARGET_FILTER
        });
        this.frameAttachmentAvailable = true;
        await this.#awaitExistingFrameTargets();
      } catch (error) {
        this.frameAttachmentAvailable = false;
        this.frameAttachmentError = error.message;
      }
      if (this.targetLifecycle === "detached") throw new Error("The authorized browser target detached during session setup.");
      this.targetLifecycle = "attached";
      return this;
    } catch (error) {
      for (const dispose of this.disposers.splice(0)) dispose();
      await this.#detachFrameSessions();
      this.attached = false;
      this.targetLifecycle = "detached";
      this.targetDetachReason ??= String(error?.message ?? error).slice(0, 200);
      this.domEnabled = false;
      if (this.sessionId) await this.transport.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
      this.sessionId = null;
      if (this.ownsTransport || this.ownsBrowserClient) await this.transport.close().catch(() => {});
      throw error;
    }
  }

  #isManagedParentSession(parentSessionId) {
    const parent = parentSessionId ?? null;
    if (parent === (this.sessionId ?? null)) return true;
    return [...this.frameSessions.values()].some(frame => frame.sessionId === parent && frame.status !== "detached");
  }

  #onTargetAttached(params, parentSessionId) {
    const targetInfo = params?.targetInfo;
    const childSessionId = params?.sessionId;
    if (!this.attached || targetInfo?.type !== "iframe" || typeof targetInfo.targetId !== "string" || typeof childSessionId !== "string" || !this.#isManagedParentSession(parentSessionId)) return;
    if (this.frameSessions.has(targetInfo.targetId)) return;
    if (this.frameSessions.size >= MAX_OUT_OF_PROCESS_SESSIONS) {
      this.frameAttachmentOmitted++;
      this.transport.send("Target.detachFromTarget", { sessionId: childSessionId }, parentSessionId ?? null).catch(() => {});
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
      error: null,
      ready: null,
      domEnabled: false,
      domObservationAvailable: false,
      networkObservationAvailable: false,
      domSubscriptionScheduled: false,
      disposers: []
    };
    frame.client = createSessionClient(this.transport, () => frame.sessionId);
    this.frameSessions.set(frame.targetId, frame);
    this.documentGeneration++;
    this.#bindFrameEvents(frame);
    frame.ready = this.#initializeFrameTarget(frame).then(() => {
      frame.status = "ready";
    }).catch(error => {
      frame.status = "failed";
      frame.error = String(error?.message ?? error).slice(0, 300);
      this.frameAttachmentError ??= frame.error;
    });
  }

  #onTargetDetached(params, parentSessionId) {
    if (this.sessionId && params?.sessionId === this.sessionId && (parentSessionId ?? null) === null) {
      this.#markTargetDetached("Target.detachedFromTarget");
      return;
    }
    const frame = [...this.frameSessions.values()].find(item => item.sessionId === params?.sessionId);
    if (!frame || (parentSessionId ?? null) !== frame.parentSessionId) return;
    frame.status = "detached";
    for (const dispose of frame.disposers.splice(0)) dispose();
    this.frameSessions.delete(frame.targetId);
    this.documentGeneration++;
  }

  #markTargetDetached(reason) {
    if (this.targetLifecycle === "detached" || this.targetLifecycle === "closed") return;
    this.targetLifecycle = "detached";
    this.targetDetachReason = String(reason ?? "target detached").slice(0, 200);
    this.attached = false;
    this.domEnabled = false;
    this.domObservationAvailable = false;
    this.networkObservationAvailable = false;
    this.documentGeneration++;
    for (const frame of this.frameSessions.values()) {
      frame.status = "detached";
      for (const dispose of frame.disposers.splice(0)) dispose();
    }
    this.frameSessions.clear();
    this.activity.recordLifecycleEvent("Target.detachedFromTarget", { targetId: this.target.id, reason: this.targetDetachReason });
  }

  #assertTargetAttached() {
    if (this.targetLifecycle === "detached") throw new Error("The authorized browser target is detached; create a fresh authorized session before continuing.");
    if (!this.attached || this.targetLifecycle !== "attached") throw new Error("Browser target session is not attached.");
  }

  #bindFrameEvents(frame) {
    const client = frame.client;
    const recordLifecycle = (method, event) => this.activity.recordLifecycleEvent(method, { ...event, frameTargetId: frame.targetId });
    frame.disposers.push(client.on("Page.lifecycleEvent", event => recordLifecycle("Page.lifecycleEvent", event)));
    frame.disposers.push(client.on("Page.frameNavigated", event => {
      frame.frameId = event.frame?.id ?? frame.frameId;
      recordLifecycle("Page.frameNavigated", event);
      this.documentGeneration++;
    }));
    frame.disposers.push(client.on("Page.navigatedWithinDocument", event => {
      recordLifecycle("Page.navigatedWithinDocument", event);
      this.documentGeneration++;
    }));
    for (const method of ["Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.domContentEventFired", "Page.loadEventFired"]) {
      frame.disposers.push(client.on(method, event => recordLifecycle(method, event)));
    }
    frame.disposers.push(client.on("DOM.documentUpdated", event => {
      this.documentGeneration++;
      frame.domObservationAvailable = false;
      recordLifecycle("DOM.documentUpdated", event);
      this.#scheduleDomSubscription(client, frame);
    }));
    for (const method of ["DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.attributeModified", "DOM.attributeRemoved", "DOM.characterDataModified", "DOM.childNodeCountUpdated", "DOM.shadowRootPushed", "DOM.shadowRootPopped", "DOM.pseudoElementAdded", "DOM.pseudoElementRemoved", "DOM.inlineStyleInvalidated", "DOM.distributedNodesUpdated"]) {
      frame.disposers.push(client.on(method, event => this.activity.recordDomMutation(method, { ...event, frameTargetId: frame.targetId })));
    }
    for (const method of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]) {
      frame.disposers.push(client.on(method, event => this.activity.recordNetworkEvent(method, event, { frameTargetId: frame.targetId })));
    }
  }

  async #initializeFrameTarget(frame) {
    const client = frame.client;
    await client.send("Page.enable");
    await client.send("DOM.enable");
    frame.domEnabled = true;
    await client.send("Runtime.enable");
    frame.domObservationAvailable = await this.#subscribeDomTree(client);
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
    if (this.ownsTransport) return;
    const { targetInfos = [] } = await this.transport.send("Target.getTargets");
    const expected = targetInfos.filter(item => item?.type === "iframe" && item.parentId === this.target.id).map(item => item.targetId);
    if (!expected.length) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (expected.every(targetId => this.frameSessions.has(targetId))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async getOutOfProcessFrames() {
    this.#assertTargetAttached();
    let expected = new Set(this.frameSessions.keys());
    if (!this.ownsTransport && this.frameAttachmentAvailable) {
      try {
        const { targetInfos = [] } = await this.transport.send("Target.getTargets");
        const iframeTargets = targetInfos.filter(item => item?.type === "iframe" && typeof item.targetId === "string");
        const parents = new Set([this.target.id]);
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

  async #detachFrameSessions() {
    for (const frame of [...this.frameSessions.values()].reverse()) {
      try { await this.transport.send("Target.detachFromTarget", { sessionId: frame.sessionId }, frame.parentSessionId); }
      catch { /* Detaching the selected parent target below also tears down owned descendants. */ }
      for (const dispose of frame.disposers.splice(0)) dispose();
    }
    this.frameSessions.clear();
  }

  networkClientForTarget(frameTargetId = null) {
    if (!frameTargetId) return this.networkObservationAvailable ? this.client : null;
    const frame = this.frameSessions.get(frameTargetId);
    return frame?.status === "ready" && frame.networkObservationAvailable ? frame.client : null;
  }

  async observe(options) {
    this.#assertTargetAttached();
    const observation = await this.observer.capture(options);
    // Observations are retained evidence. Record the session-owned evidence id
    // so diagnostic collectors can request the exact observation, rather than
    // relying on an empty or mutable external global.
    if (typeof observation?.evidenceId === "string" && observation.evidenceId) {
      this.latestEvidenceId = observation.evidenceId;
    }
    return observation;
  }

  #onDialogOpening(event) {
    this.pendingDialog = {
      type: event?.type ?? "alert",
      message: String(event?.message ?? "").slice(0, 500),
      defaultPrompt: event?.defaultPrompt ?? null,
      url: event?.url ?? null,
      capturedAt: new Date().toISOString()
    };
    this.activity.recordLifecycleEvent("Page.javascriptDialogOpening", event);
  }

  async handleDialog({ accept = true, promptText = null } = {}) {
    this.#assertTargetAttached();
    if (!this.pendingDialog) throw new Error("No JavaScript dialog is currently open.");
    const dialog = this.pendingDialog;
    const params = { accept };
    if (dialog.type === "prompt" && promptText !== null && typeof promptText === "string") {
      params.promptText = promptText.slice(0, 500);
    }
    await this.client.send("Page.handleJavaScriptDialog", params);
    this.pendingDialog = null;
    return { dismissed: !accept, accepted: accept, type: dialog.type, message: dialog.message };
  }

  get hasPendingDialog() { return this.pendingDialog !== null && this.pendingDialog !== undefined; }

  async #subscribeDomTree(client = this.client) {
    try {
      const { root } = await client.send("DOM.getDocument", { depth: 0, pierce: true });
      if (!Number.isInteger(root?.nodeId) || root.nodeId < 0) throw new Error("CDP did not return a document root node id.");
      await client.send("DOM.requestChildNodes", { nodeId: root.nodeId, depth: -1, pierce: true });
      return true;
    } catch {
      return false;
    }
  }

  #scheduleDomSubscription(client = this.client, owner = this) {
    if (!owner.domEnabled || owner.domSubscriptionScheduled) return;
    owner.domSubscriptionScheduled = true;
    queueMicrotask(async () => {
      try { if (owner.domEnabled) owner.domObservationAvailable = await this.#subscribeDomTree(client); }
      finally { owner.domSubscriptionScheduled = false; }
    });
  }

  async click(candidate) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "click");
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    const frame = candidate.frameTargetId ? this.frameSessions.get(candidate.frameTargetId) : null;
    if (candidate.frameTargetId && frame?.status !== "ready") throw new Error("The selected out-of-process frame session is no longer available.");
    const client = frame?.client ?? this.client;
    const { node } = await client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected page element no longer exists.");
    await client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
    const resolved = await client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected page element could not be revalidated.");
    const validation = await client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect();const s=getComputedStyle(this);const x=r.left+r.width/2,y=r.top+r.height/2;let top=document.elementFromPoint(x,y);for(let depth=0;top&&top.shadowRoot&&depth<8;depth++){const inner=top.shadowRoot.elementFromPoint(x,y);if(!inner||inner===top)break;top=inner}const label=(this.getAttribute('aria-label')||this.title||this.alt||this.innerText||this.textContent||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',label,occluded:!!top&&top!==this&&!this.contains(top),labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
      arguments: [{ value: candidate.name ?? "" }],
      returnByValue: true,
      awaitPromise: false
    });
    const current = validation.result?.value;
    if (!current?.connected) throw new Error("The selected page element became stale before action.");
    if (!current.visible) throw new Error("The selected page element is no longer visible or interactable.");
    if (!current.labelMatches) throw new Error("The selected element's accessible label changed; observe and plan again.");
    if (current.occluded) throw new Error("The selected page element is occluded; observe and choose another target.");
    const { model } = await client.send("DOM.getBoxModel", { backendNodeId: candidate.backendNodeId });
    const quad = model?.content;
    if (!quad || quad.length < 8) throw new Error("The selected page element has no usable layout box.");
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return { dispatched: true, at: { x, y }, backendNodeId: candidate.backendNodeId, frameTargetId: frame?.targetId ?? null };
  }

  async scroll(target) {
    this.#assertTargetAttached();
    const location = await this.client.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true,
      awaitPromise: false,
      userGesture: false
    }).catch(() => null);
    assertControlAllowed({ ...target, documentUrl: target.documentUrl ?? location?.result?.value }, "scroll");
    if (target.targetId !== this.target.id) throw new Error("Scroll target belongs to a different browser target.");
    if (target.documentGeneration !== this.documentGeneration) throw new Error("Scroll target belongs to a stale document generation; observe again before acting.");
    if (target.visible !== true || target.canScrollDown !== true) throw new Error("The selected region is not currently visible and scrollable downward.");
    const frame = target.frameTargetId ? this.frameSessions.get(target.frameTargetId) : null;
    if (target.frameTargetId && frame?.status !== "ready") throw new Error("The selected out-of-process frame session is no longer available.");
    const client = frame?.client ?? this.client;
    let objectId;
    try {
      let x;
      let y;
      let deltaY;
      let beforeScrollTop;
      if (target.kind === "viewport") {
        const { result } = await client.send("Runtime.evaluate", {
          expression: "JSON.stringify({scrollTop:document.scrollingElement?.scrollTop??0,maxScrollTop:Math.max(0,(document.scrollingElement?.scrollHeight??0)-(document.scrollingElement?.clientHeight??innerHeight)),height:innerHeight,width:innerWidth})",
          returnByValue: true,
          awaitPromise: false
        });
        const current = JSON.parse(result?.value ?? "{}");
        beforeScrollTop = Number(current.scrollTop ?? 0);
        if (Math.abs(beforeScrollTop - target.scrollTop) > 3 || !(current.maxScrollTop > beforeScrollTop + 2)) throw new Error("The page scroll position changed since observation; observe and plan again.");
        x = Math.max(1, Math.floor(Number(current.width ?? 2) / 2));
        y = Math.max(1, Math.floor(Number(current.height ?? 2) / 2));
        deltaY = Math.min(800, Math.max(1, Math.ceil(Number(current.height ?? 1) * 0.8)), Math.ceil(current.maxScrollTop - beforeScrollTop));
      } else if (target.kind === "container" && Number.isInteger(target.backendNodeId)) {
        const { node } = await client.send("DOM.describeNode", { backendNodeId: target.backendNodeId, depth: 0, pierce: true });
        if (!node?.backendNodeId) throw new Error("The selected scroll region no longer exists.");
        const resolved = await client.send("DOM.resolveNode", { backendNodeId: target.backendNodeId });
        objectId = resolved.object?.objectId;
        if (!objectId) throw new Error("The selected scroll region could not be revalidated.");
        const { result } = await client.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(expected){const r=this.getBoundingClientRect(),s=getComputedStyle(this),maxScrollTop=Math.max(0,this.scrollHeight-this.clientHeight),label=(this.getAttribute('aria-label')||this.title||this.getAttribute('role')||this.tagName.toLowerCase()).replace(/\\s+/g,' ').trim();const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);return {connected:this.isConnected,tag:this.tagName.toLowerCase(),label,labelMatches:!expected.name||label.toLocaleLowerCase()===expected.name.toLocaleLowerCase(),scrollTop:this.scrollTop,maxScrollTop,clientHeight:this.clientHeight,x:(left+right)/2,y:(top+bottom)/2,width:right-left,height:bottom-top,visible:right-left>=20&&bottom-top>=20&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0,scrollable:/(auto|scroll|overlay)/.test(s.overflowY),scrollTopMatches:Math.abs(this.scrollTop-expected.scrollTop)<=3}}",
          arguments: [{ value: { name: target.name ?? "", scrollTop: target.scrollTop } }],
          returnByValue: true,
          awaitPromise: false
        });
        const current = result?.value;
        if (!current?.connected || current.tag !== target.tag || !current.labelMatches || !current.visible || !current.scrollable || !current.scrollTopMatches || !(current.maxScrollTop > current.scrollTop + 2)) {
          throw new Error("The selected scroll region changed since observation; observe and plan again.");
        }
        beforeScrollTop = current.scrollTop;
        x = Math.max(1, Math.floor(current.x));
        y = Math.max(1, Math.floor(current.y));
        deltaY = Math.min(800, Math.max(1, Math.ceil(current.clientHeight * 0.8)), Math.ceil(current.maxScrollTop - beforeScrollTop));
      } else {
        throw new Error("The selected scroll region has an unsupported identity.");
      }
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
      return { dispatched: true, targetIdentity: target.identity, beforeScrollTop, requestedDeltaY: deltaY, frameTargetId: frame?.targetId ?? null };
    } finally {
      if (objectId) await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async typeSearchPhrase(candidate, phrase) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "type");
    if (typeof phrase !== "string" || !phrase.trim() || phrase.length > 500) throw new Error("Search text is empty or exceeds the 500-character input limit.");
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Search text entry is limited to the main frame.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (candidate.tag !== "input" || String(candidate.type ?? "").toLowerCase() !== "search") throw new Error("Text entry is limited to a native search input.");
    const { node } = await this.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected search input no longer exists.");
    await this.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected search input could not be revalidated.");
    const validation = await this.client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect();const s=getComputedStyle(this);const x=r.left+r.width/2,y=r.top+r.height/2;let top=document.elementFromPoint(x,y);for(let depth=0;top&&top.shadowRoot&&depth<8;depth++){const inner=top.shadowRoot.elementFromPoint(x,y);if(!inner||inner===top)break;top=inner}const label=(this.getAttribute('aria-label')||this.title||Array.from(this.labels??[]).map(label=>label.innerText||label.textContent||'').join(' ')||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',type:String(this.type||'').toLowerCase(),disabled:this.disabled===true,readOnly:this.readOnly===true,label,occluded:!!top&&top!==this&&!this.contains(top),labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
      arguments: [{ value: candidate.name ?? "" }],
      returnByValue: true,
      awaitPromise: false
    });
    const current = validation.result?.value;
    if (!current?.connected || current.type !== "search" || current.disabled || current.readOnly) throw new Error("The selected search input is no longer editable.");
    if (!current.visible) throw new Error("The selected search input is no longer visible.");
    if (!current.labelMatches) throw new Error("The selected search input label changed; observe and plan again.");
    if (current.occluded) throw new Error("The selected search input is occluded.");
    await this.client.send("DOM.focus", { backendNodeId: candidate.backendNodeId });
    const selectionModifier = process.platform === "darwin"
      ? { key: "Meta", code: "MetaLeft", virtualKeyCode: 91, flag: 4 }
      : { key: "Control", code: "ControlLeft", virtualKeyCode: 17, flag: 2 };
    await this.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: selectionModifier.key, code: selectionModifier.code, windowsVirtualKeyCode: selectionModifier.virtualKeyCode, nativeVirtualKeyCode: selectionModifier.virtualKeyCode });
    try {
      await this.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: selectionModifier.flag, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
      await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: selectionModifier.flag, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    } finally {
      await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: selectionModifier.key, code: selectionModifier.code, windowsVirtualKeyCode: selectionModifier.virtualKeyCode, nativeVirtualKeyCode: selectionModifier.virtualKeyCode }).catch(() => {});
    }
    await this.client.send("Input.insertText", { text: phrase });
    return { dispatched: true, backendNodeId: candidate.backendNodeId };
  }

  async fillField(candidate, value) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "fill");
    if (typeof value !== "string" || value.length > 2000) throw new Error("Field value exceeds the 2000-character input limit.");
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Field text entry is limited to the main frame.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    const tag = String(candidate.tag ?? "").toLowerCase();
    const contentEditable = candidate.contentEditable === true;
    const ariaTextbox = ["textbox", "searchbox"].includes(String(candidate.role ?? "").toLowerCase());
    if (!["input", "textarea"].includes(tag) && !(contentEditable && ariaTextbox)) {
      throw new Error("fillField requires an observed native text field or contenteditable ARIA textbox.");
    }
    const { node } = await this.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected form field no longer exists.");
    await this.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected form field could not be revalidated.");
    const validation = await this.client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect(),s=getComputedStyle(this);let top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);const label=(this.getAttribute('aria-label')||this.title||Array.from(this.labels??[]).map(l=>l.innerText||l.textContent||'').join(' ')||this.getAttribute('name')||'').replace(/\s+/g,' ').trim();return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',tag:this.tagName.toLowerCase(),type:String(this.type||'').toLowerCase(),editable:this.isContentEditable===true,role:this.getAttribute('role')||'',disabled:this.disabled===true,readOnly:this.readOnly===true,label,occluded:!!top&&top!==this&&!this.contains(top),labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
      arguments: [{ value: candidate.name ?? "" }],
      returnByValue: true,
      awaitPromise: false
    });
    const current = validation.result?.value;
    if (!current?.connected || current.disabled || current.readOnly
      || (!["input", "textarea"].includes(current.tag) && !(current.editable && ["textbox", "searchbox"].includes(current.role)))) {
      throw new Error("The selected form field is no longer editable.");
    }
    if (!current.visible) throw new Error("The selected form field is no longer visible.");
    if (!current.labelMatches && !current.editable) throw new Error("The selected form field label changed; observe and plan again.");
    if (current.editable && current.role !== String(candidate.role ?? "")) throw new Error("The selected contenteditable role changed; observe and plan again.");
    if (current.occluded) throw new Error("The selected form field is occluded.");
    const sensitiveTypes = new Set(["password", "file", "hidden", "submit", "button", "image", "reset"]);
    if (sensitiveTypes.has(current.type)) throw new Error(`fillField does not support input type '${current.type}'.`);
    await this.client.send("DOM.focus", { backendNodeId: candidate.backendNodeId });
    await replaceFocusedText(this.client, value);
    return { dispatched: true, backendNodeId: candidate.backendNodeId, valueLength: value.length };
  }

  async selectOption(candidate, value) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "select");
    if (typeof value !== "string" || value.length > 500) throw new Error("Select value exceeds the 500-character limit.");
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Select is limited to the main frame.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (String(candidate.tag ?? "").toLowerCase() !== "select") {
      if (String(candidate.role ?? "").toLowerCase() !== "combobox") {
        throw new Error("selectOption requires a native select or an observed ARIA combobox.");
      }
      await this.click(candidate);
      const opened = await this.observe();
      if (opened.targetId !== this.target.id) throw new Error("The opened combobox menu belongs to a different browser target.");
      const options = (opened.candidates ?? []).filter(option => option.targetId === this.target.id
        && option.documentGeneration === this.documentGeneration
        && option.frameTargetId == null && option.visible === true && option.disabled !== true
        && String(option.role ?? "").toLowerCase() === "option" && option.name === value);
      if (options.length !== 1) {
        return { dispatched: true, selected: false, selectionStatus: "unresolved", reason: "The open combobox did not expose exactly one visible option with the caller's exact value." };
      }
      const selected = await this.click(options[0]);
      return { ...selected, selected: true, selectionStatus: "selected", selectedLabelMatches: true };
    }
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected dropdown could not be resolved.");
    try {
      const validation = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expectedLabel){const label=this.getAttribute('aria-label')||this.getAttribute('name')||'';const match=Array.from(this.options).find(o=>o.value===arguments[1]||o.text.trim()===arguments[1]);return {connected:this.isConnected,disabled:this.disabled===true,matchFound:!!match,matchValue:match?.value??null,matchIndex:match?Array.from(this.options).indexOf(match):-1,labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
        arguments: [{ value: candidate.name ?? "" }, { value }],
        returnByValue: true,
        awaitPromise: false
      });
      const current = validation.result?.value;
      if (!current?.connected || current.disabled) throw new Error("The selected dropdown is no longer available.");
      if (!current.matchFound) throw new Error(`Option '${value}' not found in dropdown.`);
      if (!current.labelMatches) throw new Error("The selected dropdown label changed; observe and plan again.");
      await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(index){this.selectedIndex=index;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.selectedIndex}",
        arguments: [{ value: current.matchIndex }],
        returnByValue: true,
        awaitPromise: false
      });
      return { dispatched: true, backendNodeId: candidate.backendNodeId, selectedValue: current.matchValue };
    } finally { await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  /**
   * Verify an exact caller-supplied value in a freshly revalidated native or
   * supported ARIA control. The value never leaves the browser process.
   */
  async verifyControlValue(candidate, expectedValue) {
    this.#assertTargetAttached();
    if (typeof expectedValue !== "string") throw new Error("Control value verification requires an exact string value.");
    if (candidate?.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate?.frameTargetId) throw new Error("Control value verification is limited to the main frame.");
    if (candidate?.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before verifying.");
    const tag = String(candidate?.tag ?? "").toLowerCase();
    const role = String(candidate?.role ?? "").toLowerCase();
    const editable = candidate?.contentEditable === true;
    const customValueControl = (editable && ["textbox", "searchbox"].includes(role)) || role === "combobox";
    if (!["input", "textarea", "select"].includes(tag) && !customValueControl) {
      throw new Error("Value verification requires an observed native control or supported ARIA value control.");
    }
    const { node } = await this.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected control no longer exists.");
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected control could not be resolved for verification.");
    try {
      const result = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expected){if(!this.isConnected||this.disabled===true)return {valid:false,matches:false};if(this.tagName.toLowerCase()==='select'){const option=this.options[this.selectedIndex];return {valid:true,matches:!!option&&(this.value===arguments[0]||option.text.trim()===arguments[0])}}if(this.isContentEditable)return {valid:true,matches:this.innerText===arguments[0]||this.textContent===arguments[0]};if(this.getAttribute('role')==='combobox'){const current=this.getAttribute('aria-valuetext')||this.getAttribute('aria-valuenow')||this.innerText||this.textContent||'';return {valid:true,matches:current.trim()===arguments[0]}}return {valid:true,matches:this.value===arguments[0]}}",
        arguments: [{ value: expectedValue }],
        returnByValue: true,
        awaitPromise: false
      });
      const value = result.result?.value;
      if (!value?.valid) return { verified: false, matches: false, reason: "The selected control is no longer available." };
      return { verified: true, matches: value.matches === true };
    } finally {
      await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async uploadFile(candidate, filePaths) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "upload");
    if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 10) {
      throw new Error("uploadFile requires a non-empty array of 1-10 file paths.");
    }
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (String(candidate.tag ?? "").toLowerCase() !== "input" || String(candidate.type ?? "").toLowerCase() !== "file") {
      throw new Error("uploadFile is limited to input[type=file] elements.");
    }
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected file input could not be resolved.");
    try {
      const validation = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expectedLabel){const label=this.getAttribute('aria-label')||this.getAttribute('name')||'';return {connected:this.isConnected,disabled:this.disabled===true,labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase(),multiple:this.multiple===true,accept:this.accept??null}}",
        arguments: [{ value: candidate.name ?? "" }],
        returnByValue: true,
        awaitPromise: false
      });
      const current = validation.result?.value;
      if (!current?.connected || current.disabled) throw new Error("The selected file input is no longer available.");
      if (!current.labelMatches) throw new Error("The selected file input label changed; observe and plan again.");
      if (!current.multiple && filePaths.length > 1) throw new Error("The selected file input does not accept multiple files.");
      await this.client.send("DOM.setFileInputFiles", {
        files: filePaths.map(path => String(path).slice(0, 4096)),
        backendNodeId: candidate.backendNodeId
      });
      return { dispatched: true, backendNodeId: candidate.backendNodeId, fileCount: filePaths.length };
    } finally { await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async detectSpaNavigation(beforeUrl) {
    this.#assertTargetAttached();
    if (typeof beforeUrl !== "string" || !beforeUrl) throw new Error("detectSpaNavigation requires a beforeUrl.");
    const observation = await this.observe();
    const currentUrl = observation?.page?.url;
    if (typeof currentUrl !== "string" || !currentUrl) return { isSpaNavigation: false, reason: "No current page URL." };
    try {
      const before = new URL(beforeUrl);
      const after = new URL(currentUrl);
      const sameOrigin = before.origin === after.origin;
      const pathChanged = before.pathname !== after.pathname;
      const queryChanged = before.search !== after.search;
      // Same-origin, different path or query = SPA navigation (no full reload).
      const isSpaNavigation = sameOrigin && (pathChanged || queryChanged);
      return {
        isSpaNavigation,
        reason: isSpaNavigation
          ? `SPA navigation detected: ${before.pathname}${before.search} → ${after.pathname}${after.search} (same origin, no full page reload).`
          : pathChanged || queryChanged
            ? `Different-origin navigation: ${before.origin} → ${after.origin}.`
            : "URL unchanged; no navigation detected.",
        evidenceId: observation.evidenceId
      };
    } catch {
      return { isSpaNavigation: false, reason: "URL comparison failed." };
    }
  }

  async verifySearchOutcome(phrase) {
    this.#assertTargetAttached();
    if (typeof phrase !== "string" || !phrase.trim()) return false;
    const documentResult = await this.client.send("Runtime.evaluate", { expression: "document", returnByValue: false });
    const objectId = documentResult.result?.objectId;
    if (!objectId) return false;
    try {
      const result = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(query){const norm=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();const labels=[document.title,...Array.from(document.querySelectorAll('h1,h2,[role=heading]'),element=>element.textContent)];const resultState=labels.some(label=>/\\b(?:search results?|results? for|no results)\\b/i.test(norm(label)));const field=Array.from(document.querySelectorAll('input[type=search]')).find(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'});const fieldMatches=field&&norm(field.value)===norm(query);const content=norm(document.body?.innerText);return Boolean(resultState&&(fieldMatches||content.includes(norm(query))))}",
        arguments: [{ value: phrase }],
        returnByValue: true,
        awaitPromise: false
      });
      return result.result?.value === true;
    } finally { await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async #pageChangeFingerprint() {
    const { result } = await this.client.send("Runtime.evaluate", {
      expression: "JSON.stringify([location.href,document.title,document.body?.innerText?.slice(0,4000)??''])",
      returnByValue: true,
      awaitPromise: true
    });
    return createHash("sha256").update(String(result?.value ?? "")).digest("hex");
  }

  async #readScrollPosition(target) {
    const frame = target.frameTargetId ? this.frameSessions.get(target.frameTargetId) : null;
    if (target.frameTargetId && frame?.status !== "ready") return null;
    const client = frame?.client ?? this.client;
    if (target.kind === "viewport") {
      const { result } = await client.send("Runtime.evaluate", { expression: "document.scrollingElement?.scrollTop??0", returnByValue: true, awaitPromise: false });
      return Number(result?.value);
    }
    if (!Number.isInteger(target.backendNodeId)) return null;
    const resolved = await client.send("DOM.resolveNode", { backendNodeId: target.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return null;
    try {
      const { result } = await client.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return this.isConnected?this.scrollTop:null}", returnByValue: true, awaitPromise: false });
      return Number.isFinite(result?.value) ? result.value : null;
    } finally { await client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async waitForChange(timeoutMs = 2_000, baseline) {
    if (this.targetLifecycle !== "attached" || !this.attached) return;
    const deadline = Date.now() + timeoutMs;
    const pageFingerprint = typeof baseline === "string" ? baseline : baseline?.pageChangeFingerprint;
    const requiresChange = typeof pageFingerprint === "string" && pageFingerprint.length > 0;
    const baselineKey = requiresChange
      ? JSON.stringify([pageFingerprint, Number(baseline.domMutationCount ?? 0), Number(baseline.lifecycleEventCount ?? 0), Number(baseline.scrollTarget?.scrollTop ?? 0)])
      : "";
    let last = baselineKey;
    let observedChange = false;
    let pageContentChanged = false;
    let stableSince = Date.now();
    while (Date.now() < deadline && this.targetLifecycle === "attached" && this.attached) {
      try {
        const currentPageFingerprint = await this.#pageChangeFingerprint();
        const currentScrollTop = baseline?.scrollTarget ? await this.#readScrollPosition(baseline.scrollTarget).catch(() => null) : null;
        const currentKey = JSON.stringify([
          currentPageFingerprint,
          this.activity.totalDomMutations,
          this.activity.totalLifecycleEvents,
          Number.isFinite(currentScrollTop) ? currentScrollTop : Number(baseline?.scrollTarget?.scrollTop ?? 0)
        ]);
        if (currentKey !== last) {
          last = currentKey;
          stableSince = Date.now();
          observedChange = true;
          pageContentChanged ||= currentPageFingerprint !== pageFingerprint;
        } else {
          const scrollMoved = Number.isFinite(currentScrollTop) && Math.abs(currentScrollTop - Number(baseline.scrollTarget.scrollTop ?? 0)) > 2;
          const quietWindow = pageContentChanged || scrollMoved ? 200 : 500;
          if (last && Date.now() - stableSince >= quietWindow && (!requiresChange || observedChange)) return;
        }
      } catch { /* navigation may replace the execution context */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async close() {
    await this.#detachFrameSessions();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.attached = false;
    this.targetLifecycle = "closed";
    this.domEnabled = false;
    this.domObservationAvailable = false;
    if (this.sessionId) await this.transport.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => {});
    this.sessionId = null;
    if (this.ownsTransport || this.ownsBrowserClient) await this.transport.close();
  }
}
