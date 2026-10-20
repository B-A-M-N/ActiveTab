import { ACTION_VALUE_LIMITS } from "./actionLimits.js";

async function replaceFocusedText(client, value, { beforeReplace = null, afterDelete = null } = {}) {
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
  await beforeReplace?.();
  if (value) {
    await client.send("Input.insertText", { text: value });
    return;
  }
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
  });
  await afterDelete?.();
}

/** Native text-field mechanics; admission and target ownership stay with BrowserSession. */
export class TextInputController {
  constructor(session, { assertTargetAttached, assertControlAllowed } = {}) {
    this.session = session;
    this.assertTargetAttached = assertTargetAttached;
    this.assertControlAllowed = assertControlAllowed;
  }

  async #assertFocusedCandidate(candidate, action) {
    const session = this.session;
    this.assertTargetAttached();
    if (candidate?.targetId !== session.target.id || candidate?.documentGeneration !== session.documentGeneration) {
      throw new Error(`The ${action} target became stale before text delivery.`);
    }
    let resolved;
    try {
      resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    } catch {
      throw new Error(`The ${action} target could not be resolved after focus.`);
    }
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`The ${action} target could not be resolved after focus.`);
    try {
      const response = await session.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){const root=this.getRootNode();const active=root.activeElement;return {connected:this.isConnected===true,focused:active===this||(this.isContentEditable===true&&active instanceof Element&&this.contains(active))}}",
        returnByValue: true,
        awaitPromise: false
      });
      const state = response.result?.value;
      if (state?.connected !== true) throw new Error(`The ${action} target was replaced after focus.`);
      if (state?.focused !== true) throw new Error(`Focus moved away from the ${action} target before text delivery.`);
    } finally {
      await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async typeSearchPhrase(candidate, phrase, observation = null, { beforeDispatch = null } = {}) {
    const session = this.session;
    this.assertTargetAttached();
    this.assertControlAllowed(candidate, "type");
    if (typeof phrase !== "string" || !phrase.trim() || phrase.length > ACTION_VALUE_LIMITS.type) throw new Error(`Search text is empty or exceeds the ${ACTION_VALUE_LIMITS.type}-character input limit.`);
    if (candidate.targetId !== session.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Search text entry is limited to the main frame.");
    if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    let observedOrigin = null;
    try { observedOrigin = new URL(observation?.page?.url ?? "").origin; }
    catch { /* A bounded same-origin query-field contract requires a valid observation URL. */ }
    const nativeSearch = candidate.tag === "input" && String(candidate.type ?? "").toLowerCase() === "search";
    const sameOriginQueryField = candidate.tag === "input"
      && String(candidate.type ?? "").toLowerCase() === "text"
      && candidate.queryField === true
      && candidate.formMethod === "get"
      && candidate.formTargetSameContext === true
      && Boolean(candidate.formIdentity)
      && Boolean(observedOrigin)
      && candidate.formActionOrigin === observedOrigin;
    if (!nativeSearch && !sameOriginQueryField) {
      throw new Error("Text entry is limited to a native search input or an observed same-origin GET query field.");
    }
    const { node } = await session.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected search input no longer exists.");
    await session.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected search input could not be revalidated.");
    const validation = await session.client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect();const s=getComputedStyle(this);const x=r.left+r.width/2,y=r.top+r.height/2;let top=document.elementFromPoint(x,y);for(let depth=0;top&&top.shadowRoot&&depth<8;depth++){const inner=top.shadowRoot.elementFromPoint(x,y);if(!inner||inner===top)break;top=inner}const label=(this.getAttribute('aria-label')||this.title||Array.from(this.labels??[]).map(label=>label.innerText||label.textContent||'').join(' ')||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();const form=this.form;let formActionOrigin=null;let formTargetSameContext=false;if(form){try{formActionOrigin=new URL(form.action||location.href,location.href).origin}catch{}const target=String(this.getAttribute('formtarget')||form.target||'').trim().toLowerCase();formTargetSameContext=!target||target==='_self'}return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',type:String(this.type||'').toLowerCase(),name:this.getAttribute('name'),formMethod:form?String(this.getAttribute('formmethod')||form.method||'get').toLowerCase():null,formActionOrigin,formTargetSameContext,disabled:this.disabled===true,readOnly:this.readOnly===true,label,occluded:!!top&&top!==this&&!this.contains(top),labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
      arguments: [{ value: candidate.name ?? "" }],
      returnByValue: true,
      awaitPromise: false
    });
    const current = validation.result?.value;
    const liveNativeSearch = current?.type === "search";
    const liveSameOriginQueryField = sameOriginQueryField
      && current?.type === "text"
      && current.name === "q"
      && current.formMethod === "get"
      && current.formTargetSameContext === true
      && current.formActionOrigin === observedOrigin
      && current.formMethod === candidate.formMethod
      && current.formActionOrigin === candidate.formActionOrigin
      && current.formTargetSameContext === candidate.formTargetSameContext;
    if (!current?.connected || (!liveNativeSearch && !liveSameOriginQueryField) || current.disabled || current.readOnly) throw new Error("The selected search input is no longer editable under its observed search contract.");
    if (!current.visible) throw new Error("The selected search input is no longer visible.");
    if (!current.labelMatches) throw new Error("The selected search input label changed; observe and plan again.");
    if (current.occluded) throw new Error("The selected search input is occluded.");
    await beforeDispatch?.({ candidate });
    this.assertTargetAttached();
    if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Search input became stale immediately before dispatch.");
    await session.client.send("DOM.focus", { backendNodeId: candidate.backendNodeId });
    await beforeDispatch?.({ candidate });
    await this.#assertFocusedCandidate(candidate, "search input");
    await replaceFocusedText(session.client, phrase, {
      beforeReplace: async () => {
        await beforeDispatch?.({ candidate });
        await this.#assertFocusedCandidate(candidate, "search input");
      }
    });
    return { dispatched: true, backendNodeId: candidate.backendNodeId };
  }

  async fillField(candidate, value, { beforeDispatch = null } = {}) {
    const session = this.session;
    this.assertTargetAttached();
    this.assertControlAllowed(candidate, "fill");
    if (typeof value !== "string" || value.length > ACTION_VALUE_LIMITS.fill) throw new Error(`Field value exceeds the ${ACTION_VALUE_LIMITS.fill}-character input limit.`);
    if (candidate.targetId !== session.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Field text entry is limited to the main frame.");
    if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    const tag = String(candidate.tag ?? "").toLowerCase();
    const contentEditable = candidate.contentEditable === true;
    const ariaTextbox = ["textbox", "searchbox"].includes(String(candidate.role ?? "").toLowerCase());
    if (!["input", "textarea"].includes(tag) && !(contentEditable && ariaTextbox)) {
      throw new Error("fillField requires an observed native text field or contenteditable ARIA textbox.");
    }
    const { node } = await session.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected form field no longer exists.");
    await session.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId });
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    if (!resolved.object?.objectId) throw new Error("The selected form field could not be revalidated.");
    const validation = await session.client.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect(),s=getComputedStyle(this);let top=this.ownerDocument.elementFromPoint(r.left+r.width/2,r.top+r.height/2);for(let depth=0;top&&depth<8;depth++){const shadow=top.shadowRoot;if(!shadow)break;const inner=shadow.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!inner||inner===top)break;top=inner}const label=(this.getAttribute('aria-label')||this.title||Array.from(this.labels??[]).map(l=>l.innerText||l.textContent||'').join(' ')||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();return {connected:this.isConnected,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',tag:this.tagName.toLowerCase(),type:String(this.type||'').toLowerCase(),editable:this.isContentEditable===true,role:this.getAttribute('role')||'',disabled:this.disabled===true,readOnly:this.readOnly===true,label,occluded:!!top&&top!==this&&!this.contains(top),labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase()}}",
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
    await beforeDispatch?.({ candidate });
    this.assertTargetAttached();
    if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Form field became stale immediately before dispatch.");
    await session.client.send("DOM.focus", { backendNodeId: candidate.backendNodeId });
    await beforeDispatch?.({ candidate });
    await this.#assertFocusedCandidate(candidate, "form field");
    await replaceFocusedText(session.client, value, {
      beforeReplace: async () => {
        await beforeDispatch?.({ candidate });
        await this.#assertFocusedCandidate(candidate, "form field");
      },
      afterDelete: () => this.#assertFocusedCandidate(candidate, "form field")
    });
    return { dispatched: true, backendNodeId: candidate.backendNodeId, valueLength: value.length };
  }
}
