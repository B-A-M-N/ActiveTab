import { ACTION_VALUE_LIMITS } from "./actionLimits.js";

/** Native checkbox/select mechanics and in-process value checks; no policy admission. */
export class NativeControlsController {
  constructor(session, { assertTargetAttached, assertControlAllowed } = {}) {
    this.session = session;
    this.assertTargetAttached = assertTargetAttached;
    this.assertControlAllowed = assertControlAllowed;
  }

  async setCheckboxState(candidate, checked, { beforeDispatch = null } = {}) {
    const session = this.session;
    this.assertTargetAttached();
    this.assertControlAllowed(candidate, "toggle");
    if (typeof checked !== "boolean") throw new Error("Checkbox state must be an explicit boolean.");
    if (candidate?.targetId !== session.target.id || candidate?.documentGeneration !== session.documentGeneration
      || String(candidate?.tag ?? "").toLowerCase() !== "input"
      || String(candidate?.type ?? "").toLowerCase() !== "checkbox" || candidate?.frameTargetId) {
      throw new Error("Setting filter state requires the exact fresh native checkbox on the authorized target.");
    }
    const { node } = await session.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId || node.backendNodeId !== candidate.backendNodeId
      || String(node.nodeName ?? "").toLowerCase() !== "input") throw new Error("The selected checkbox no longer exists.");
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected checkbox could not be revalidated.");
    try {
      const validation = await session.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expectedLabel){const r=this.getBoundingClientRect(),s=getComputedStyle(this),label=(this.getAttribute('aria-label')||this.labels?.[0]?.innerText||this.getAttribute('name')||'').replace(/\\s+/g,' ').trim();return {connected:this.isConnected,checkbox:this.type==='checkbox',disabled:this.disabled===true||this.getAttribute('aria-disabled')==='true',visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&s.pointerEvents!=='none',labelMatches:!expectedLabel||!label||label.toLocaleLowerCase()===expectedLabel.toLocaleLowerCase(),checked:this.checked===true}}",
        arguments: [{ value: candidate.name ?? "" }], returnByValue: true, awaitPromise: false
      });
      const current = validation.result?.value;
      if (!current?.connected || !current.checkbox || current.disabled || !current.visible || !current.labelMatches) {
        throw new Error("The selected checkbox is no longer the same visible, enabled control.");
      }
      await beforeDispatch?.({ candidate, currentChecked: current.checked, desiredChecked: checked });
      this.assertTargetAttached();
      if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Checkbox became stale immediately before dispatch.");
      if (current.checked !== checked) {
        const changed = await session.client.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(desired){if(!this.isConnected||this.disabled||this.type!=='checkbox')return {changed:false,checked:null};this.checked=desired;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {changed:true,checked:this.checked===true}}",
          arguments: [{ value: checked }], returnByValue: true, awaitPromise: false
        });
        const state = changed.result?.value;
        if (state?.changed !== true || state.checked !== checked) throw new Error("The requested filter state could not be applied exactly.");
      }
      return { dispatched: true, changed: current.checked !== checked, checked };
    } finally { await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async verifyCheckboxState(candidate, expectedChecked) {
    const session = this.session;
    this.assertTargetAttached();
    if (typeof expectedChecked !== "boolean" || candidate?.targetId !== session.target.id
      || candidate?.documentGeneration !== session.documentGeneration || candidate?.frameTargetId
      || String(candidate?.tag ?? "").toLowerCase() !== "input"
      || String(candidate?.type ?? "").toLowerCase() !== "checkbox") {
      throw new Error("Checkbox verification requires an exact fresh native checkbox.");
    }
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return { verified: false, matches: false };
    try {
      const result = await session.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(expected){const r=this.getBoundingClientRect(),s=getComputedStyle(this);return {valid:this.isConnected&&this.type==='checkbox'&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!this.disabled,matches:this.checked===expected}}",
        arguments: [{ value: expectedChecked }], returnByValue: true, awaitPromise: false
      });
      return { verified: result.result?.value?.valid === true, matches: result.result?.value?.matches === true };
    } finally { await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async selectOption(candidate, value, { beforeDispatch = null } = {}) {
    const session = this.session;
    this.assertTargetAttached();
    this.assertControlAllowed(candidate, "select");
    if (typeof value !== "string" || value.length > ACTION_VALUE_LIMITS.select) throw new Error(`Select value exceeds the ${ACTION_VALUE_LIMITS.select}-character limit.`);
    if (candidate.targetId !== session.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate.frameTargetId) throw new Error("Select is limited to the main frame.");
    if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before acting.");
    if (String(candidate.tag ?? "").toLowerCase() !== "select") throw new Error("selectOption requires a native select or an observed ARIA combobox.");
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected dropdown could not be resolved.");
    try {
      const validation = await session.client.send("Runtime.callFunctionOn", {
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
      this.assertTargetAttached();
      if (candidate.documentGeneration !== session.documentGeneration) throw new Error("Dropdown became stale immediately before dispatch.");
      await session.client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(index){this.selectedIndex=index;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.selectedIndex}",
        arguments: [{ value: current.matchIndex }],
        returnByValue: true,
        awaitPromise: false
      });
      return { dispatched: true, backendNodeId: candidate.backendNodeId, selectedValue: current.matchValue };
    } finally { await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async verifyControlValue(candidate, expectedValue) {
    const session = this.session;
    this.assertTargetAttached();
    if (typeof expectedValue !== "string") throw new Error("Control value verification requires an exact string value.");
    if (candidate?.targetId !== session.target.id) throw new Error("Candidate belongs to a different browser target.");
    if (candidate?.frameTargetId) throw new Error("Control value verification is limited to the main frame.");
    if (candidate?.documentGeneration !== session.documentGeneration) throw new Error("Candidate belongs to a stale document generation; observe again before verifying.");
    const tag = String(candidate?.tag ?? "").toLowerCase();
    const role = String(candidate?.role ?? "").toLowerCase();
    const editable = candidate?.contentEditable === true;
    const customValueControl = (editable && ["textbox", "searchbox"].includes(role)) || role === "combobox";
    if (!["input", "textarea", "select"].includes(tag) && !customValueControl) {
      throw new Error("Value verification requires an observed native control or supported ARIA value control.");
    }
    const { node } = await session.client.send("DOM.describeNode", { backendNodeId: candidate.backendNodeId, depth: 0, pierce: true });
    if (!node?.backendNodeId) throw new Error("The selected control no longer exists.");
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId: candidate.backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("The selected control could not be resolved for verification.");
    try {
      const result = await session.client.send("Runtime.callFunctionOn", {
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
      await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}
