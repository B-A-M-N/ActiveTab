import { createHash } from "node:crypto";
import { CdpClient } from "../cdp/client.js";
import { BrowserActivityRecorder } from "./activity.js";
import { ACTION_VALUE_LIMITS } from "./actionLimits.js";
import { BrowserObserver } from "../observe/observer.js";
import { runVisualCandidateProbe } from "./visualCandidateProbe.js";
import { DialogState } from "./dialogState.js";
import { TextInputController } from "./textInput.js";
import { CandidateValidator } from "./candidateValidator.js";
import { FrameSessionManager } from "./frameSessionManager.js";
import { sanitizeUrl } from "./urlPrivacy.js";
import { isOperatorProhibitedControl, operatorProhibitedControlReason } from "../runtime/controlRestrictions.js";
import { isFileUploadDispatchToken } from "../runtime/fileUploadGrants.js";

function createSessionClient(transport, sessionId) {
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

function assertControlAllowed(candidate, actionType) {
  if (isOperatorProhibitedControl(candidate, actionType)) throw new Error(operatorProhibitedControlReason());
}

const ROOT_NETWORK_TOTAL_BUFFER_BYTES = 8 * 1024 * 1024;
const ROOT_NETWORK_RESOURCE_BUFFER_BYTES = 512 * 1024;

export class BrowserSession {
  #textInput;
  #candidateValidator;
  #frameSessionManager;

  constructor(target, { evidenceLimit = 12 } = {}) {
    this.target = target;
    this.transport = target.browserClient ?? new CdpClient(target.webSocketDebuggerUrl);
    this.ownsTransport = !target.browserClient;
    this.ownsBrowserClient = target.ownsBrowserClient === true;
    this.rootAlreadyAttached = target.rootAlreadyAttached === true;
    this.sessionId = null;
    this.client = createSessionClient(this.transport, () => this.sessionId);
    this.#textInput = new TextInputController(this, {
      assertTargetAttached: () => this.#assertTargetAttached(),
      assertControlAllowed
    });
    this.#candidateValidator = new CandidateValidator(this, {
      assertTargetAttached: () => this.#assertTargetAttached()
    });
    this.#frameSessionManager = new FrameSessionManager(this, {
      onTargetDetached: reason => this.#markTargetDetached(reason),
      onGenerationChange: () => { this.documentGeneration++; },
      subscribeDomTree: client => this.#subscribeDomTree(client),
      scheduleDomSubscription: (client, owner) => this.#scheduleDomSubscription(client, owner)
    });
    this.documentGeneration = 0;
    this.observationGeneration = 0;
    this.visualProbeSequence = 0;
    this.activeVisualProbe = null;
    this.attached = false;
    this.targetLifecycle = "created";
    this.targetDetachReason = null;
    this.activity = new BrowserActivityRecorder();
    this.networkObservationAvailable = false;
    this.domObservationAvailable = false;
    this.domEnabled = false;
    this.domSubscriptionScheduled = false;
    this.observer = new BrowserObserver(this, { evidenceLimit });
    this.dialogState = new DialogState();
    this.pendingDialog = null;
    this.disposers = [];
  }

  get frameSessions() { return this.#frameSessionManager.frameSessions; }
  get frameAttachmentAvailable() { return this.#frameSessionManager.attachmentAvailable; }
  get frameAttachmentError() { return this.#frameSessionManager.attachmentError; }
  get frameAttachmentOmitted() { return this.#frameSessionManager.attachmentOmitted; }

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
      this.disposers.push(...this.#frameSessionManager.subscribe());
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
      for (const method of ["Network.requestWillBeSent", "Network.responseReceived", "Network.dataReceived", "Network.loadingFinished", "Network.loadingFailed"]) {
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
      try { await this.#frameSessionManager.enable(); }
      catch (error) { this.#frameSessionManager.markAttachmentFailure(error); }
      if (this.targetLifecycle === "detached") throw new Error("The authorized browser target detached during session setup.");
      this.targetLifecycle = "attached";
      return this;
    } catch (error) {
      for (const dispose of this.disposers.splice(0)) dispose();
      await this.#frameSessionManager.detachAll();
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

  #markTargetDetached(reason) {
    if (this.targetLifecycle === "detached" || this.targetLifecycle === "closed") return;
    this.#invalidateVisualProbe("target_detached");
    this.targetLifecycle = "detached";
    this.targetDetachReason = String(reason ?? "target detached").slice(0, 200);
    this.attached = false;
    this.domEnabled = false;
    this.domObservationAvailable = false;
    this.networkObservationAvailable = false;
    this.documentGeneration++;
    this.#frameSessionManager.markParentDetached();
    this.activity.recordLifecycleEvent("Target.detachedFromTarget", { targetId: this.target.id, reason: this.targetDetachReason });
  }

  #assertTargetAttached() {
    if (this.targetLifecycle === "detached") throw new Error("The authorized browser target is detached; create a fresh authorized session before continuing.");
    if (!this.attached || this.targetLifecycle !== "attached") throw new Error("Browser target session is not attached.");
  }

  #invalidateVisualProbe(reason) {
    if (!this.activeVisualProbe) return;
    this.activeVisualProbe.invalidatedBy = reason;
    this.activeVisualProbe.controller.abort();
  }

  async getOutOfProcessFrames({ onCdpRoundTrip } = {}) {
    this.#assertTargetAttached();
    return this.#frameSessionManager.getOutOfProcessFrames({ onCdpRoundTrip });
  }

  networkClientForTarget(frameTargetId = null) {
    return this.#frameSessionManager.networkClientForTarget(frameTargetId);
  }

  async observe(options) {
    this.#assertTargetAttached();
    this.observationGeneration++;
    this.#invalidateVisualProbe("superseded_by_new_observation");
    const observation = await this.observer.capture(options);
    // Observations are retained evidence. Record the session-owned evidence id
    // so diagnostic collectors can request the exact observation, rather than
    // relying on an empty or mutable external global.
    if (typeof observation?.evidenceId === "string" && observation.evidenceId) {
      this.latestEvidenceId = observation.evidenceId;
    }
    return observation;
  }

  async queryAccessibility(evidenceId, query) {
    this.#assertTargetAttached();
    return this.observer.queryAccessibility(evidenceId, query);
  }

  async probeVisualCandidateAtPoint(evidenceId, { x, y, timeoutMs = 1_500 } = {}) {
    this.#assertTargetAttached();
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 2_000) {
      return { status: "invalid", reasonCode: "hit_test_input_invalid", evidenceId, actionAuthorized: false };
    }
    if (this.activeVisualProbe) {
      return { status: "unavailable", reasonCode: "hit_test_in_progress", evidenceId, actionAuthorized: false };
    }
    const active = {
      id: ++this.visualProbeSequence,
      evidenceId,
      observationGeneration: this.observationGeneration,
      controller: new AbortController(),
      invalidatedBy: null
    };
    this.activeVisualProbe = active;
    try {
      return await runVisualCandidateProbe(this, evidenceId, { x, y, timeoutMs, active });
    } finally {
      if (this.activeVisualProbe?.id === active.id) this.activeVisualProbe = null;
    }
  }


  #onDialogOpening(event) {
    this.dialogState.open(event);
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

  get pendingDialog() { return this.dialogState.pending; }
  set pendingDialog(dialog) { this.dialogState.pending = dialog; }
  get hasPendingDialog() { return this.dialogState.hasPending; }

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

  /** Revalidate one exact observed backend node without recapturing a DOMSnapshot. */
  async validateObservedCandidate(candidate, { action, expectedUrl } = {}) {
    return this.#candidateValidator.validateObservedCandidate(candidate, { action, expectedUrl });
  }

  async click(candidate, { beforeDispatch = null } = {}) {
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
    await beforeDispatch?.({ candidate, frameTargetId: frame?.targetId ?? null });
    this.#assertTargetAttached();
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate became stale immediately before click dispatch.");
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return { dispatched: true, at: { x, y }, backendNodeId: candidate.backendNodeId, frameTargetId: frame?.targetId ?? null };
  }

  /** Set one exact observed native checkbox to a caller-selected state. */
  async setCheckboxState(candidate, checked, { beforeDispatch = null } = {}) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "toggle");
    if (typeof checked !== "boolean") throw new Error("Checkbox state must be an explicit boolean.");
    if (candidate?.targetId !== this.target.id || candidate?.documentGeneration !== this.documentGeneration
      || String(candidate?.tag ?? "").toLowerCase() !== "input"
      || String(candidate?.type ?? "").toLowerCase() !== "checkbox" || candidate?.frameTargetId) {
      throw new Error("Setting filter state requires the exact fresh native checkbox on the authorized target.");
    }
    const { node } = await this.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId || node.backendNodeId !== candidate.backendNodeId
      || String(node.nodeName ?? "").toLowerCase() !== "input") throw new Error("The selected checkbox no longer exists.");
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected checkbox could not be revalidated.");
    try {
      const validation = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect(),s=getComputedStyle(this),label=(this.getAttribute('aria-label')||this.labels?.[0]?.innerText||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();return {connected:this.isConnected,checkbox:this.type==='checkbox',disabled:this.disabled===true||this.getAttribute('aria-disabled')==='true',visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase(),checked:this.checked===true}}",
        arguments: [{ value: candidate.name ?? "" }], returnByValue: true, awaitPromise: false
      });
      const current = validation.result?.value;
      if (!current?.connected || !current.checkbox || current.disabled || !current.visible || !current.labelMatches) {
        throw new Error("The selected checkbox is no longer the same visible, enabled control.");
      }
      await beforeDispatch?.({ candidate, currentChecked: current.checked, desiredChecked: checked });
      this.#assertTargetAttached();
      if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Checkbox became stale immediately before dispatch.");
      if (current.checked !== checked) {
        const changed = await this.client.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(desired){if(!this.isConnected||this.disabled||this.type!=='checkbox')return {changed:false,checked:null};this.checked=desired;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {changed:true,checked:this.checked===true}}",
          arguments: [{ value: checked }], returnByValue: true, awaitPromise: false
        });
        const state = changed.result?.value;
        if (state?.changed !== true || state.checked !== checked) throw new Error("The requested filter state could not be applied exactly.");
      }
      return { dispatched: true, changed: current.checked !== checked, checked };
    } finally { await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  /** Compare a checkbox state in-page and return only a boolean. */
  async verifyCheckboxState(candidate, expectedChecked) {
    this.#assertTargetAttached();
    if (typeof expectedChecked !== "boolean" || candidate?.targetId !== this.target.id
      || candidate?.documentGeneration !== this.documentGeneration || candidate?.frameTargetId
      || String(candidate?.tag ?? "").toLowerCase() !== "input"
      || String(candidate?.type ?? "").toLowerCase() !== "checkbox") {
      throw new Error("Checkbox verification requires an exact fresh native checkbox.");
    }
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return { verified: false, matches: false };
    try {
      const result = await this.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expected){const r=this.getBoundingClientRect(),s=getComputedStyle(this);return {valid:this.isConnected&&this.type==='checkbox'&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!this.disabled,matches:this.checked===expected}}",
        arguments: [{ value: expectedChecked }], returnByValue: true, awaitPromise: false
      });
      return { verified: result.result?.value?.valid === true, matches: result.result?.value?.matches === true };
    } finally { await this.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async navigateObservedLinkInSameTarget(candidate, { beforeDispatch = null } = {}) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "click");
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (candidate.frameTargetId) throw new Error("Same-target navigation is limited to links in the leased root frame.");
    if (String(candidate.tag ?? "").toLowerCase() !== "a" || typeof candidate.href !== "string" || !candidate.href) {
      throw new Error("Same-target navigation requires a fresh observed anchor link.");
    }
    const { node } = await this.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected page link no longer exists.");
    const resolved = await this.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected page link could not be revalidated.");
    const validation = await this.client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',tag:this.tagName.toLowerCase(),href:this.href}}",
      returnByValue: true,
      awaitPromise: false
    });
    const current = validation.result?.value;
    if (!current?.connected || !current.visible || current.tag !== "a") {
      throw new Error("The selected link changed or is no longer visible before same-target navigation.");
    }
    let observedHref;
    let currentHref;
    try {
      observedHref = new URL(candidate.href, this.target.url).href;
      currentHref = new URL(current.href).href;
    } catch { throw new Error("The selected page link has an invalid destination."); }
    if (sanitizeUrl(currentHref) !== observedHref) throw new Error("The selected page link destination changed after observation.");
    await beforeDispatch?.({ candidate, href: currentHref, sameTargetNavigation: true });
    this.#assertTargetAttached();
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate became stale immediately before same-target navigation.");
    await this.client.send("Page.navigate", { url: observedHref });
    return { dispatched: true, navigationMode: "same_target", backendNodeId: candidate.backendNodeId };
  }

  async scroll(target, { beforeDispatch = null } = {}) {
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
      await beforeDispatch?.({ target });
      this.#assertTargetAttached();
      if (target.documentGeneration !== this.documentGeneration) throw new Error("Scroll target became stale immediately before dispatch.");
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
      return { dispatched: true, targetIdentity: target.identity, beforeScrollTop, requestedDeltaY: deltaY, frameTargetId: frame?.targetId ?? null };
    } finally {
      if (objectId) await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async typeSearchPhrase(candidate, phrase, observation = null, options = {}) {
    return this.#textInput.typeSearchPhrase(candidate, phrase, observation, options);
  }

  async fillField(candidate, value, options = {}) {
    return this.#textInput.fillField(candidate, value, options);
  }

  async #isOptionControlledByCombobox(combobox, option, expectedValue) {
    const comboboxResolved = await this.client.send("DOM.resolveNode", { backendNodeId: combobox.backendNodeId });
    const optionResolved = await this.client.send("DOM.resolveNode", { backendNodeId: option.backendNodeId });
    const comboboxObjectId = comboboxResolved.object?.objectId;
    const optionObjectId = optionResolved.object?.objectId;
    if (!comboboxObjectId || !optionObjectId) {
      if (comboboxObjectId) await this.client.send("Runtime.releaseObject", { objectId: comboboxObjectId }).catch(() => {});
      if (optionObjectId) await this.client.send("Runtime.releaseObject", { objectId: optionObjectId }).catch(() => {});
      return false;
    }
    try {
      const result = await this.client.send("Runtime.callFunctionOn", {
        objectId: comboboxObjectId,
        functionDeclaration: "function(option,expected){const role=(option.getAttribute('role')||'').toLowerCase();const label=(option.getAttribute('aria-label')||option.innerText||option.textContent||'').replace(/\\s+/g,' ').trim();const ids=(String(this.getAttribute('aria-controls')||'')+' '+String(this.getAttribute('aria-owns')||'')).trim().split(/\\s+/).filter(Boolean);const controlled=ids.some(id=>{const menu=document.getElementById(id);return !!menu&&(menu===option||menu.contains(option))});const rect=option.getBoundingClientRect(),style=getComputedStyle(option);return {valid:this.isConnected&&option.isConnected&&this.getAttribute('aria-expanded')==='true'&&role==='option'&&label===expected&&(this.contains(option)||controlled)&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0&&option.getAttribute('aria-disabled')!=='true'&&!option.hasAttribute('disabled')}}",
        arguments: [{ objectId: optionObjectId }, { value: expectedValue }],
        returnByValue: true,
        awaitPromise: false
      });
      return result.result?.value?.valid === true;
    } finally {
      await this.client.send("Runtime.releaseObject", { objectId: optionObjectId }).catch(() => {});
      await this.client.send("Runtime.releaseObject", { objectId: comboboxObjectId }).catch(() => {});
    }
  }

  async selectOption(candidate, value, { actionEnvelope = null, authorizeSuboperation = null, beforeDispatch = null } = {}) {
    this.#assertTargetAttached();
    assertControlAllowed(candidate, "select");
    if (typeof value !== "string" || value.length > ACTION_VALUE_LIMITS.select) throw new Error(`Select value exceeds the ${ACTION_VALUE_LIMITS.select}-character limit.`);
    if (candidate.targetId !== this.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Select is limited to the main frame.");
    if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (String(candidate.tag ?? "").toLowerCase() !== "select") {
      if (String(candidate.role ?? "").toLowerCase() !== "combobox") {
        throw new Error("selectOption requires a native select or an observed ARIA combobox.");
      }
      const allowedSuboperations = ["open_observed_combobox", "select_exact_controlled_option"];
      if (actionEnvelope?.type !== "aria_combobox_select"
        || actionEnvelope.version !== 1
        || actionEnvelope.action !== "select"
        || actionEnvelope.targetId !== this.target.id
        || actionEnvelope.candidateIdentity !== candidate.identity
        || actionEnvelope.documentGeneration !== this.documentGeneration
        || actionEnvelope.value !== value
        || !Array.isArray(actionEnvelope.allowedSuboperations)
        || actionEnvelope.allowedSuboperations.length !== allowedSuboperations.length
        || !allowedSuboperations.every((suboperation, index) => actionEnvelope.allowedSuboperations[index] === suboperation)
        || typeof authorizeSuboperation !== "function") {
        throw new Error("ARIA combobox selection requires an approved two-step action envelope.");
      }

      const authorize = async (stage, suboperation, target, menuCandidate = candidate) => {
        const decision = await authorizeSuboperation({
          stage,
          suboperation,
          candidate: target,
          menuCandidate,
          actionEnvelope
        });
        if (decision?.allowed !== true) return decision ?? { allowed: false, reason: "Composite selection suboperation was not authorized." };
        return decision;
      };
      const complete = async (suboperation, target, menuCandidate = candidate) => {
        const decision = await authorize("completed", suboperation, target, menuCandidate);
        if (decision?.allowed !== true) throw new Error(decision?.reason ?? "Composite selection suboperation could not be recorded.");
      };

      const openStep = "open_observed_combobox";
      const openAuthorization = await authorize("prepare", openStep, candidate);
      if (openAuthorization?.allowed !== true || openAuthorization.candidate?.identity !== candidate.identity) {
        return { dispatched: false, selected: false, selectionStatus: "refused", reason: openAuthorization?.reason ?? "The combobox changed before it could be opened." };
      }
      const openedCombobox = openAuthorization.candidate;
      try {
        await this.click(openedCombobox, {
          beforeDispatch: async () => {
            const decision = await authorize("dispatch", openStep, openedCombobox);
            if (decision?.allowed !== true) {
              const error = new Error(decision?.reason ?? "Opening the combobox was refused before dispatch.");
              error.compositeSuboperationRefused = true;
              throw error;
            }
          }
        });
      } catch (error) {
        if (error?.compositeSuboperationRefused) {
          return { dispatched: false, selected: false, selectionStatus: "refused", reason: String(error.message ?? error) };
        }
        throw error;
      }
      await complete(openStep, openedCombobox);

      const opened = await this.observe();
      if (opened.targetId !== this.target.id) throw new Error("The opened combobox menu belongs to a different browser target.");
      const currentCombobox = (opened.candidates ?? []).find(option => option.identity === candidate.identity
        && option.targetId === this.target.id
        && option.documentGeneration === this.documentGeneration
        && option.role === "combobox");
      if (!currentCombobox) {
        return { dispatched: true, selected: false, selectionStatus: "unresolved", reason: "The opened combobox could not be reidentified in fresh evidence.", completedSuboperations: [openStep] };
      }
      const visibleOptions = (opened.candidates ?? []).filter(option => option.targetId === this.target.id
        && option.documentGeneration === this.documentGeneration
        && option.frameTargetId == null && option.visible === true && option.disabled !== true
        && String(option.role ?? "").toLowerCase() === "option" && option.name === value);
      const relatedOptions = [];
      for (const option of visibleOptions) {
        if (await this.#isOptionControlledByCombobox(currentCombobox, option, value)) relatedOptions.push(option);
      }
      if (relatedOptions.length !== 1) {
        return { dispatched: true, selected: false, selectionStatus: "unresolved", reason: "The opened combobox did not expose exactly one visible, related option with the caller's exact value.", completedSuboperations: [openStep] };
      }
      const selectStep = "select_exact_controlled_option";
      const optionAuthorization = await authorize("prepare", selectStep, relatedOptions[0], currentCombobox);
      if (optionAuthorization?.allowed !== true
        || optionAuthorization.candidate?.identity !== relatedOptions[0].identity
        || optionAuthorization.menuCandidate?.identity !== currentCombobox.identity) {
        return { dispatched: true, selected: false, selectionStatus: "refused_after_open", reason: optionAuthorization?.reason ?? "The option or combobox changed before selection.", completedSuboperations: [openStep] };
      }
      const selectedOption = optionAuthorization.candidate;
      const selectedCombobox = optionAuthorization.menuCandidate;
      if (!await this.#isOptionControlledByCombobox(selectedCombobox, selectedOption, value)) {
        return { dispatched: true, selected: false, selectionStatus: "unresolved", reason: "The exact option is no longer controlled by the opened combobox.", completedSuboperations: [openStep] };
      }
      try {
        const selected = await this.click(selectedOption, {
          beforeDispatch: async () => {
            if (!await this.#isOptionControlledByCombobox(selectedCombobox, selectedOption, value)) {
              const error = new Error("The selected option is no longer related to the opened combobox.");
              error.compositeSuboperationRefused = true;
              throw error;
            }
            const decision = await authorize("dispatch", selectStep, selectedOption, selectedCombobox);
            if (decision?.allowed !== true) {
              const error = new Error(decision?.reason ?? "Option selection was refused before dispatch.");
              error.compositeSuboperationRefused = true;
              throw error;
            }
          }
        });
        await complete(selectStep, selectedOption, selectedCombobox);
        return { ...selected, selected: true, selectionStatus: "selected", selectedLabelMatches: true, completedSuboperations: [openStep, selectStep] };
      } catch (error) {
        if (error?.compositeSuboperationRefused) {
          return { dispatched: true, selected: false, selectionStatus: "refused_after_open", reason: String(error.message ?? error), completedSuboperations: [openStep] };
        }
        throw error;
      }
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
      await beforeDispatch?.({ candidate });
      this.#assertTargetAttached();
      if (candidate.documentGeneration !== this.documentGeneration) throw new Error("Dropdown became stale immediately before dispatch.");
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

  async uploadFile(candidate, filePaths, { beforeDispatch = null, grantToken = null } = {}) {
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
    if (!isFileUploadDispatchToken(grantToken, { targetId: this.target.id, candidateIdentity: candidate.identity, filePaths })) {
      throw new Error("File uploads require a one-use scoped grant for this exact input and approved staged file.");
    }
    if (typeof beforeDispatch !== "function") throw new Error("File uploads require an immediate grant and target-lease recheck before dispatch.");
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
      await beforeDispatch?.({ candidate });
      this.#assertTargetAttached();
      if (candidate.documentGeneration !== this.documentGeneration) throw new Error("File input became stale immediately before dispatch.");
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
    const observation = await this.observe({ profile: "lightweight" });
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
        functionDeclaration: "function(query){const norm=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();const labels=[document.title,...Array.from(document.querySelectorAll('h1,h2,[role=heading]'),element=>element.textContent)];const resultHeading=labels.some(label=>/\\b(?:search results?|results? for|no results)\\b/i.test(norm(label)));const field=Array.from(document.querySelectorAll('input[type=search],input[name=q][type=text],[role=searchbox]')).find(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'});const fieldMatches=field&&norm(field.value)===norm(query);let urlQuery='';try{urlQuery=new URL(location.href).searchParams.get('q')||''}catch{}const urlMatches=norm(urlQuery)===norm(query);const resultLinks=document.querySelectorAll('main a[href],#links a[href],[data-testid*=result] a[href]').length>0;const resultState=resultHeading||(urlMatches&&resultLinks);const content=norm(document.body?.innerText);return Boolean(resultState&&(fieldMatches||urlMatches||content.includes(norm(query))))}",
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
    this.#invalidateVisualProbe("target_closed");
    await this.#frameSessionManager.detachAll();
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
