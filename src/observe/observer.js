import { createHash, randomUUID } from "node:crypto";
import { sanitizeUrl, sanitizeUrlAttribute, URL_ATTRIBUTES } from "../browser/urlPrivacy.js";

const STYLE_NAMES = ["display", "visibility", "opacity", "pointer-events", "position", "z-index"];
const ACTIONABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const CONTEXT_CONTAINERS = new Set(["SECTION", "ARTICLE", "NAV", "ASIDE", "MAIN", "FORM"]);
const MAX_SCROLL_TARGETS_PER_FRAME = 8;
const DEFAULT_NETWORK_RESPONSE_BYTES = 32 * 1024;
const MAX_NETWORK_RESPONSE_BYTES = 256 * 1024;
const FORBIDDEN_VALUE_ATTRIBUTES = new Set(["value", "placeholder"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "progressbar"]);
const MAX_RUNTIME_PATH_SEGMENTS = 8;
const MAX_RUNTIME_PATH_SEGMENT_LENGTH = 128;
const MAX_RUNTIME_VALUE_LENGTH = 4_096;
const MAX_RUNTIME_RECORD_BYTES = 512 * 1024;
const MAX_RUNTIME_RECORDS_PER_EVIDENCE = 8;
const MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE = 1024 * 1024;

const RUNTIME_PATH_INSPECTOR = `function(path, failureMarker, includeSensitiveValues) {
  let current = this;
  for (let index = 0; index < path.length; index++) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      return failureMarker + ":parent_not_object:" + index + ":" + (current === null ? "null" : typeof current);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, path[index]);
    if (!descriptor) return failureMarker + ":not_found:" + index;
    if (!("value" in descriptor)) {
      return failureMarker + ":accessor_not_read:" + index + ":" + (typeof descriptor.get === "function") + ":" + (typeof descriptor.set === "function");
    }
    current = descriptor.value;
  }
  const type = current === null ? "null" : typeof current;
  if (type !== "object" && type !== "function") {
    if (!includeSensitiveValues) return failureMarker + ":primitive_redacted:" + type;
    if (type === "string") return current.length > ${MAX_RUNTIME_VALUE_LENGTH} ? failureMarker + ":primitive_oversize:" + current.length : current;
    if (type === "number" || type === "boolean" || type === "undefined" || type === "null") return current;
    return failureMarker + ":primitive_unavailable:" + type;
  }
  return current;
}`;

function redactRuntimeRecord(record) {
  const clone = structuredClone(record);
  const redact = item => {
    if (!item || typeof item !== "object" || !Object.hasOwn(item, "value")) return;
    delete item.value;
    item.valueRedacted = true;
  };
  redact(clone.result?.selected);
  for (const property of clone.result?.properties ?? []) redact(property);
  return clone;
}

function jsonByteLength(root) {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null) { bytes += 4; continue; }
    if (typeof value === "string") { bytes += Buffer.byteLength(JSON.stringify(value)); continue; }
    if (typeof value === "number") { bytes += Buffer.byteLength(Number.isFinite(value) ? String(value) : "null"); continue; }
    if (typeof value === "boolean") { bytes += value ? 4 : 5; continue; }
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index] ?? null);
      continue;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
      bytes += 2 + Math.max(0, entries.length - 1);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, item] = entries[index];
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push(item);
      }
    }
  }
  return bytes;
}

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? strings[index] ?? "" : "";
}

function unpackAttributes(flat, strings) {
  const result = {};
  for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) {
    const name = stringAt(strings, flat[i]);
    const value = stringAt(strings, flat[i + 1]);
    if (!FORBIDDEN_VALUE_ATTRIBUTES.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function sanitizedAttributes(attributes, baseUrl, includeSensitiveUrlData = false) {
  return Object.fromEntries(Object.entries(attributes ?? {}).map(([name, value]) => [
    name,
    sanitizeUrlAttribute(name, value, baseUrl, { includeSensitiveUrlData })
  ]));
}

function sanitizeFrameTree(frameTree, includeSensitiveUrlData = false) {
  const clone = structuredClone(frameTree);
  const visit = node => {
    if (typeof node?.frame?.url === "string") node.frame.url = sanitizeUrl(node.frame.url, { includeSensitiveUrlData });
    for (const child of node?.childFrames ?? []) visit(child);
  };
  visit(clone);
  return clone;
}

function sanitizeAccessibilityTree(tree, { includeSensitiveFormValues = false, includeSensitiveUrlData = false } = {}) {
  return (tree ?? []).map(node => {
    const result = structuredClone(node);
    if (!includeSensitiveFormValues && VALUE_ROLES.has(node.role?.value)) {
      result.value = result.value ? { ...result.value, value: "" } : result.value;
      result.properties = result.properties?.filter(property => property.name !== "value");
    }
    if (!includeSensitiveUrlData) {
      for (const property of result.properties ?? []) {
        if (property.name === "url" && typeof property.value?.value === "string") property.value.value = sanitizeUrl(property.value.value);
      }
    }
    return result;
  });
}

function sanitizeDomMutation(mutation, { includeSensitiveFormValues = false, includeSensitivePageText = false, includeSensitiveUrlData = false } = {}) {
  const result = structuredClone(mutation);
  const attributeName = String(result.attributeName ?? "").toLowerCase();
  if (!includeSensitiveFormValues) {
    if (attributeName === "value" || attributeName === "placeholder") {
      result.value = null;
      result.valueRedacted = result.valueLength !== null;
    }
  }
  if (!includeSensitivePageText) {
    if (typeof result.characterData === "string") {
      result.characterData = null;
      result.characterDataRedacted = true;
    }
    if (typeof result.nodeValue === "string") {
      result.nodeValue = null;
      result.nodeValueRedacted = true;
    }
  }
  if (!includeSensitiveFormValues) result.attributes = result.attributes?.map(attribute => {
    const name = String(attribute.name ?? "").toLowerCase();
    if (name === "value" || name === "placeholder") return { ...attribute, value: null, valueRedacted: attribute.valueLength !== null };
    return attribute;
  });
  if (!includeSensitiveUrlData) {
    if (URL_ATTRIBUTES.has(attributeName) && typeof result.value === "string") result.value = sanitizeUrl(result.value);
    result.attributes = result.attributes?.map(attribute => ({
      ...attribute,
      value: sanitizeUrlAttribute(attribute.name, attribute.value, undefined, {})
    }));
  }
  return result;
}

function rectByNodeIndex(layout) {
  const rects = new Map();
  const indices = layout?.nodeIndex ?? [];
  const bounds = layout?.bounds ?? [];
  for (let i = 0; i < Math.min(indices.length, bounds.length); i++) {
    const [x, y, width, height] = bounds[i] ?? [];
    rects.set(indices[i], { x, y, width, height });
  }
  return rects;
}

function accessibleFacts(tree) {
  const byBackendId = new Map();
  for (const node of tree ?? []) {
    if (node.ignored || !Number.isInteger(node.backendDOMNodeId)) continue;
    const name = node.name?.value;
    const role = node.role?.value;
    if ((typeof name === "string" && name.trim()) || (typeof role === "string" && role)) {
      byBackendId.set(node.backendDOMNodeId, { name: typeof name === "string" ? name.trim() : "", role: typeof role === "string" ? role : "" });
    }
  }
  return byBackendId;
}

async function captureScrollableTargets(client, { targetId, frameTargetId = null, frameId, generation, limit = MAX_SCROLL_TARGETS_PER_FRAME }) {
  let arrayObjectId;
  const elementObjectIds = [];
  const cappedLimit = Math.max(1, Math.min(MAX_SCROLL_TARGETS_PER_FRAME, limit));
  try {
    const evaluated = await client.send("Runtime.evaluate", {
      expression: `(()=>Array.from(document.querySelectorAll('*')).filter(element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return element!==document.scrollingElement&&/(auto|scroll|overlay)/.test(style.overflowY)&&element.scrollHeight>element.clientHeight+2&&rect.width>=80&&rect.height>=80&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0}).slice(0,${cappedLimit}))()`,
      returnByValue: false,
      awaitPromise: false
    });
    arrayObjectId = evaluated.result?.objectId;
    if (!arrayObjectId) return [];
    const properties = await client.send("Runtime.getProperties", { objectId: arrayObjectId, ownProperties: true, generatePreview: false });
    const elements = (properties.result ?? [])
      .filter(property => /^\d+$/.test(property.name) && typeof property.value?.objectId === "string")
      .slice(0, limit);
    elementObjectIds.push(...elements.map(property => property.value.objectId));
    return (await Promise.all(elements.map(async property => {
      const objectId = property.value.objectId;
      try {
        const [description, details] = await Promise.all([
          client.send("DOM.describeNode", { objectId, depth: 0, pierce: true }),
          client.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function(){const rect=this.getBoundingClientRect(),style=getComputedStyle(this),heading=this.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,[role=heading]');const maxScrollTop=Math.max(0,this.scrollHeight-this.clientHeight);return {tag:this.tagName.toLowerCase(),role:this.getAttribute('role')||'',name:(this.getAttribute('aria-label')||this.title||'').replace(/\\s+/g,' ').trim().slice(0,160),contextName:(heading?.innerText||heading?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),x:rect.x,y:rect.y,width:rect.width,height:rect.height,scrollTop:this.scrollTop,maxScrollTop,clientHeight:this.clientHeight,canScrollDown:maxScrollTop-this.scrollTop>2,canScrollUp:this.scrollTop>2,overflowY:style.overflowY}}",
            returnByValue: true,
            awaitPromise: false
          })
        ]);
        const node = description.node;
        const value = details.result?.value;
        if (!Number.isInteger(node?.backendNodeId) || !(value?.maxScrollTop > 0) || !value.width || !value.height) return null;
        const identity = `${targetId}:${frameTargetId ?? "root"}:${frameId}:${node.backendNodeId}:${generation}`;
        return {
          identity,
          targetId,
          frameTargetId,
          frameId,
          documentGeneration: generation,
          kind: "container",
          backendNodeId: node.backendNodeId,
          name: value.name || value.role || value.tag,
          contextName: value.contextName,
          role: value.role || value.tag,
          tag: value.tag,
          visible: true,
          bounds: { x: value.x, y: value.y, width: value.width, height: value.height },
          scrollTop: value.scrollTop,
          maxScrollTop: value.maxScrollTop,
          clientHeight: value.clientHeight,
          canScrollDown: value.canScrollDown,
          canScrollUp: value.canScrollUp
        };
      } catch { return null; }
    }))).filter(Boolean);
  } catch { return []; }
  finally {
    for (const objectId of elementObjectIds) await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
    if (arrayObjectId) await client.send("Runtime.releaseObject", { objectId: arrayObjectId }).catch(() => {});
  }
}

function viewportScrollTarget(targetId, frameId, generation, scrollState, frameTargetId = null) {
  if (!(scrollState?.maxScrollTop > 0)) return null;
  return {
    identity: `${targetId}:${frameTargetId ?? "root"}:${frameId}:viewport:${generation}`,
    targetId,
    frameTargetId,
    frameId,
    documentGeneration: generation,
    kind: "viewport",
    name: "Page",
    contextName: "",
    role: "document",
    tag: "body",
    visible: true,
    bounds: { x: 0, y: 0, width: scrollState.viewportWidth, height: scrollState.viewportHeight },
    scrollTop: scrollState.scrollTop,
    maxScrollTop: scrollState.maxScrollTop,
    clientHeight: scrollState.viewportHeight,
    canScrollDown: scrollState.canScrollDown,
    canScrollUp: scrollState.canScrollUp
  };
}

function buildCandidates(snapshot, axTree, rootFrameId, generation, targetId, { frameTargetId = null, parentFrameId = null, outOfProcess = false } = {}) {
  const axFacts = accessibleFacts(axTree);
  const candidates = [];
  const headings = [];
  const frameSummaries = [];
  for (const document of snapshot.documents ?? []) {
    const frameId = stringAt(snapshot.strings, document.frameId) || String(document.frameId ?? "unknown");
    const mainFrame = !outOfProcess && frameId === rootFrameId;
    const documentUrl = stringAt(snapshot.strings, document.documentURL);
    const nodes = document.nodes;
    const controlSupported = Boolean(nodes);
    frameSummaries.push({
      frameId,
      url: sanitizeUrl(documentUrl),
      mainFrame,
      controlSupported,
      outOfProcess,
      ...(frameTargetId ? { targetId: frameTargetId, parentFrameId } : {})
    });
    if (!nodes) continue;
    const rects = rectByNodeIndex(document.layout);
    const text = Array(nodes.nodeName?.length ?? 0).fill("");
    const nodeNames = nodes.nodeName ?? [];
    const nodeValues = nodes.nodeValue ?? [];
    const textValues = nodes.textValue ?? [];
    const parents = nodes.parentIndex ?? [];
    for (let index = nodeNames.length - 1; index >= 0; index--) {
      const value = stringAt(snapshot.strings, textValues[index] ?? nodeValues[index]);
      if (value) text[index] = value.slice(0, 2_000);
      const parent = parents[index];
      if (Number.isInteger(parent) && parent >= 0 && text[index]) text[parent] = `${text[parent]} ${text[index]}`.trim().slice(0, 2_000);
    }
    const childrenByParent = new Map();
    for (let index = 0; index < parents.length; index++) {
      const parent = parents[index];
      if (!Number.isInteger(parent) || parent < 0) continue;
      const children = childrenByParent.get(parent) ?? [];
      children.push(index);
      childrenByParent.set(parent, children);
    }
    const contextNameFor = index => {
      let branch = index;
      for (let depth = 0; depth < 8; depth++) {
        const parent = parents[branch];
        if (!Number.isInteger(parent) || parent < 0) break;
        const siblings = childrenByParent.get(parent) ?? [];
        const branchPosition = siblings.indexOf(branch);
        for (let siblingPosition = branchPosition - 1; siblingPosition >= 0; siblingPosition--) {
          const sibling = siblings[siblingPosition];
          if (/^H[1-6]$/.test(stringAt(snapshot.strings, nodeNames[sibling]).toUpperCase()) && text[sibling]) {
            return text[sibling].trim().slice(0, 160);
          }
        }
        const parentTag = stringAt(snapshot.strings, nodeNames[parent]).toUpperCase();
        const parentAttributes = unpackAttributes(nodes.attributes?.[parent], snapshot.strings);
        const parentRole = String(parentAttributes.role ?? "").toLowerCase();
        if (CONTEXT_CONTAINERS.has(parentTag) || ["region", "group"].includes(parentRole)) {
          const namedContext = parentAttributes["aria-label"] || parentAttributes.title;
          if (namedContext) return String(namedContext).trim().slice(0, 160);
        }
        branch = parent;
      }
      return null;
    };
    for (let index = 0; index < nodeNames.length; index++) {
      const tag = stringAt(snapshot.strings, nodeNames[index]).toUpperCase();
      const attrs = unpackAttributes(nodes.attributes?.[index], snapshot.strings);
      const role = attrs.role?.toLowerCase();
      const isActionable = ACTIONABLE_TAGS.has(tag) || ["button", "link", "menuitem", "option", "checkbox", "radio", "tab"].includes(role) || "tabindex" in attrs || attrs["contenteditable"] === "true";
      const backendNodeId = nodes.backendNodeId?.[index];
      if (!controlSupported || !Number.isInteger(backendNodeId)) continue;
      const accessible = axFacts.get(backendNodeId);
      const label = accessible?.name || attrs["aria-label"] || attrs.title || attrs.alt || text[index] || attrs.name || "";
      const rect = rects.get(index);
      const visible = rect ? rect.width > 0 && rect.height > 0 : null;
      const explicitType = String(attrs.type ?? "").toLowerCase();
      const submitsByDefault = tag === "BUTTON" && (!explicitType || explicitType === "submit") || tag === "INPUT" && ["submit", "image"].includes(explicitType);
      let ancestor = parents[index];
      let associatedWithForm = Boolean(attrs.form);
      while (!associatedWithForm && Number.isInteger(ancestor) && ancestor >= 0) {
        associatedWithForm = stringAt(snapshot.strings, nodeNames[ancestor]).toUpperCase() === "FORM";
        ancestor = parents[ancestor];
      }
      if (/^H[1-6]$/.test(tag) && text[index]) headings.push({ level: Number(tag[1]), text: text[index].trim().slice(0, 300), frameId });
      if (!isActionable) continue;
      candidates.push({
        identity: `${targetId}:${frameTargetId ?? "root"}:${frameId}:${backendNodeId}:${generation}`,
        targetId,
        frameTargetId,
        documentUrl,
        attributes: attrs,
        backendNodeId,
        frameId,
        documentGeneration: generation,
        tag: tag.toLowerCase(),
        role: accessible?.role || role || tag.toLowerCase(),
        name: String(label).trim().slice(0, 300),
        contextName: contextNameFor(index),
        href: attrs.href ? sanitizeUrl(attrs.href, { base: stringAt(snapshot.strings, document.documentURL) }) : null,
        type: attrs.type ?? null,
        submitsForm: submitsByDefault && associatedWithForm,
        disabled: attrs.disabled !== undefined || attrs["aria-disabled"] === "true",
        visible,
        bounds: rect ?? null,
        evidence: { source: "DOMSnapshot + Accessibility tree", backendNodeId }
      });
    }
  }
  candidates.sort((a, b) => Number(b.visible === true) - Number(a.visible === true));
  return { candidates: candidates.slice(0, 200), headings: headings.slice(0, 100), frames: frameSummaries };
}

function sanitizeSnapshotForRetrieval(snapshot, { includeSensitiveFormValues = false, includeSensitiveUrlData = false } = {}) {
  const clone = structuredClone(snapshot);
  for (const document of clone.documents ?? []) {
    const baseUrl = stringAt(clone.strings, document.documentURL);
    if (!includeSensitiveUrlData && Number.isInteger(document.documentURL)) clone.strings[document.documentURL] = sanitizeUrl(baseUrl);
    const nodes = document.nodes;
    if (!nodes) continue;
    const tags = (nodes.nodeName ?? []).map(index => stringAt(clone.strings, index).toUpperCase());
    const attrsByNode = (nodes.attributes ?? []).map(flat => unpackAttributes(flat, clone.strings));
    for (let i = 0; i < (nodes.nodeName?.length ?? 0); i++) {
      if (!includeSensitiveFormValues && nodes.inputValue) {
        const valueIndex = nodes.inputValue[i];
        if (Number.isInteger(valueIndex) && valueIndex >= 0) clone.strings[valueIndex] = "";
        nodes.inputValue[i] = -1;
      }
      const tag = tags[i];
      let ancestor = i;
      let redactText = false;
      while (Number.isInteger(ancestor) && ancestor >= 0) {
        const ancestorTag = tags[ancestor];
        const editable = attrsByNode[ancestor]?.contenteditable;
        if (ancestorTag === "TEXTAREA" || editable === "true" || editable === "" || editable === "plaintext-only") { redactText = true; break; }
        ancestor = nodes.parentIndex?.[ancestor] ?? -1;
      }
      if (!includeSensitiveFormValues && redactText) {
        for (const field of ["textValue", "nodeValue"]) {
          const valueIndex = nodes[field]?.[i];
          if (Number.isInteger(valueIndex) && valueIndex >= 0) clone.strings[valueIndex] = "";
        }
      }
      if (!includeSensitiveFormValues && ["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tag) && nodes.attributes?.[i]) {
        const flat = nodes.attributes[i];
        for (let j = 0; j + 1 < flat.length; j += 2) {
          if (stringAt(clone.strings, flat[j]).toLowerCase() === "value") {
            const valueIndex = flat[j + 1];
            if (Number.isInteger(valueIndex) && valueIndex >= 0) clone.strings[valueIndex] = "";
            flat[j + 1] = -1;
          }
        }
      }
      if (!includeSensitiveUrlData && nodes.attributes?.[i]) {
        const flat = nodes.attributes[i];
        for (let j = 0; j + 1 < flat.length; j += 2) {
          const name = stringAt(clone.strings, flat[j]).toLowerCase();
          if (!URL_ATTRIBUTES.has(name)) continue;
          const valueIndex = flat[j + 1];
          const value = stringAt(clone.strings, valueIndex);
          if (Number.isInteger(valueIndex) && valueIndex >= 0) clone.strings[valueIndex] = sanitizeUrl(value, { base: baseUrl });
        }
      }
    }
  }
  if (!includeSensitiveUrlData) {
    for (let i = 0; i < clone.strings.length; i++) {
      const value = clone.strings[i];
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) clone.strings[i] = sanitizeUrl(value);
    }
  }
  return clone;
}

export class BrowserObserver {
  constructor(session, { evidenceLimit = 12, maxEvidenceBytes = 64 * 1024 * 1024 } = {}) {
    this.session = session;
    this.evidenceLimit = Math.max(1, Math.min(evidenceLimit, 100));
    this.maxEvidenceBytes = Math.max(1024 * 1024, Math.min(maxEvidenceBytes, 256 * 1024 * 1024));
    this.evidence = new Map();
    this.evidenceBytes = 0;
  }

  async inspectRuntimeState(id, { path = [], frameTargetId = null, includeSensitiveValues = false } = {}) {
    const stored = this.evidence.get(id);
    if (!stored) return { status: "expired", evidenceId: id };
    if (!Array.isArray(path) || path.length > MAX_RUNTIME_PATH_SEGMENTS || path.some(segment => typeof segment !== "string" || segment.length > MAX_RUNTIME_PATH_SEGMENT_LENGTH)) {
      throw new Error(`path must contain at most ${MAX_RUNTIME_PATH_SEGMENTS} strings of at most ${MAX_RUNTIME_PATH_SEGMENT_LENGTH} characters.`);
    }
    if (stored.evidence.documentGeneration !== this.session.documentGeneration) {
      return { status: "stale", evidenceId: id, documentGeneration: stored.evidence.documentGeneration, currentDocumentGeneration: this.session.documentGeneration };
    }
    const frame = frameTargetId ? this.session.frameSessions?.get(frameTargetId) : null;
    if (frameTargetId && (!frame || frame.status !== "ready")) {
      return { status: "unavailable", evidenceId: id, reason: "frame_session_unavailable", frameTargetId };
    }
    const client = frameTargetId ? frame.client : this.session.client;
    const objectGroup = `activetab-runtime-${randomUUID()}`;
    const remotePrimitive = remote => {
      if (remote?.subtype === "null") return null;
      if (Object.hasOwn(remote ?? {}, "value")) return remote.value;
      if (typeof remote?.unserializableValue === "string") return remote.unserializableValue;
      return undefined;
    };
    let result;
    try {
      const failureMarker = `__ACTIVETAB_RUNTIME_${randomUUID()}__`;
      const root = await client.send("Runtime.evaluate", { expression: "globalThis", objectGroup, returnByValue: false, awaitPromise: false, userGesture: false });
      if (root.exceptionDetails || typeof root.result?.objectId !== "string") {
        result = { status: "unavailable", reason: "global_object_unavailable" };
      } else {
        const selectedResponse = await client.send("Runtime.callFunctionOn", {
          objectId: root.result.objectId,
          functionDeclaration: RUNTIME_PATH_INSPECTOR,
          arguments: [{ value: path }, { value: failureMarker }, { value: includeSensitiveValues === true }],
          objectGroup,
          returnByValue: false,
          generatePreview: false,
          awaitPromise: false,
          throwOnSideEffect: true,
          userGesture: false
        });
        const selectedRemote = selectedResponse.result;
        if (selectedResponse.exceptionDetails || !selectedRemote) {
          result = { status: "unavailable", reason: "inspection_rejected_or_unsupported" };
        } else if (selectedRemote.type === "string" && typeof selectedRemote.value === "string" && selectedRemote.value.startsWith(`${failureMarker}:`)) {
          const [, status, detailOne, detailTwo, detailThree] = selectedRemote.value.split(":");
          if (status.startsWith("primitive_")) {
            const type = status === "primitive_oversize" ? "string" : detailOne;
            const selected = { kind: "primitive", type };
            if (status === "primitive_redacted" && type !== "undefined") selected.valueRedacted = true;
            if (status === "primitive_oversize") {
              selected.valueRedacted = true;
              selected.valueLength = Number(detailOne);
            }
            if (status === "primitive_unavailable") selected.valueUnavailable = true;
            result = { status: "available", selected };
          } else {
            result = { status };
            if (detailOne !== undefined && Number.isInteger(Number(detailOne))) result.pathIndex = Number(detailOne);
            if (status === "parent_not_object" && detailTwo) result.type = detailTwo;
            if (status === "accessor_not_read") {
              if (detailTwo !== undefined) result.hasGetter = detailTwo === "true";
              if (detailThree !== undefined) result.hasSetter = detailThree === "true";
            }
          }
        } else if (typeof selectedRemote.objectId === "string") {
          const type = selectedRemote.type === "function" ? "function" : "object";
          result = { status: "available", selected: { kind: "object", type }, propertyEnumeration: "not_requested" };
        } else {
          const type = selectedRemote.subtype === "null" ? "null" : selectedRemote.type;
          const selected = { kind: "primitive", type };
          const rawValue = remotePrimitive(selectedRemote);
          const rawLength = typeof rawValue === "string" ? rawValue.length : undefined;
          const redacted = includeSensitiveValues !== true && type !== "undefined";
          const overLimit = typeof rawValue === "string" && rawLength > MAX_RUNTIME_VALUE_LENGTH;
          if (redacted || overLimit) selected.valueRedacted = true;
          if (overLimit) selected.valueLength = rawLength;
          if (!redacted && !overLimit && rawValue !== undefined && type !== "symbol") selected.value = rawValue;
          result = { status: "available", selected };
        }
      }
    } catch {
      // CDP versions and V8 values differ; page exceptions stay local and are not returned as tool text.
      result = { status: "unavailable", reason: "runtime_inspection_failed" };
    } finally {
      await client.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
    if (stored.evidence.documentGeneration !== this.session.documentGeneration) {
      return { status: "stale", evidenceId: id, documentGeneration: stored.evidence.documentGeneration, currentDocumentGeneration: this.session.documentGeneration };
    }
    const record = {
      id: randomUUID(),
      evidenceId: id,
      inspectedAt: new Date().toISOString(),
      documentGeneration: stored.evidence.documentGeneration,
      frameTargetId,
      path: [...path],
      sensitiveValuesIncluded: includeSensitiveValues === true,
      status: result.status,
      result
    };
    const recordBytes = jsonByteLength(record);
    const currentRuntimeBytes = stored.evidence.runtimeStateBytes ?? 0;
    let retained = recordBytes <= MAX_RUNTIME_RECORD_BYTES
      && stored.byteLength - currentRuntimeBytes + recordBytes <= this.maxEvidenceBytes
      && this.evidenceBytes - currentRuntimeBytes + recordBytes <= this.maxEvidenceBytes;
    if (retained) {
      const records = stored.evidence.runtimeStateRecords;
      const originalRecords = records.slice();
      const originalRuntimeBytes = currentRuntimeBytes;
      const originalEntryBytes = stored.byteLength;
      const originalTotalBytes = this.evidenceBytes;
      while (records.length && (records.length >= MAX_RUNTIME_RECORDS_PER_EVIDENCE || (stored.evidence.runtimeStateBytes ?? 0) + recordBytes > MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE)) {
        const removed = records.shift();
        const removedBytes = jsonByteLength(removed);
        stored.evidence.runtimeStateBytes = Math.max(0, (stored.evidence.runtimeStateBytes ?? 0) - removedBytes);
        stored.byteLength -= removedBytes;
        this.evidenceBytes -= removedBytes;
      }
      if ((stored.evidence.runtimeStateBytes ?? 0) + recordBytes > MAX_RUNTIME_EVIDENCE_BYTES_PER_PAGE) retained = false;
      else {
        records.push(record);
        stored.evidence.runtimeStateBytes = (stored.evidence.runtimeStateBytes ?? 0) + recordBytes;
        stored.byteLength = jsonByteLength(stored.evidence);
        this.evidenceBytes = originalTotalBytes + stored.byteLength - originalEntryBytes;
        if (stored.byteLength > this.maxEvidenceBytes || this.evidenceBytes > this.maxEvidenceBytes) {
          records.splice(0, records.length, ...originalRecords);
          stored.evidence.runtimeStateBytes = originalRuntimeBytes;
          stored.byteLength = originalEntryBytes;
          this.evidenceBytes = originalTotalBytes;
          retained = false;
        }
      }
    }
    return { ...structuredClone(record), retained };
  }

  async capture({ includeScreenshot = true, includeRawInResponse = false } = {}) {
    const client = this.session.client;
    const [{ frameTree }, snapshot, ax, runtime] = await Promise.all([
      client.send("Page.getFrameTree"),
      client.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLE_NAMES, includePaintOrder: true, includeDOMRects: true }),
      client.send("Accessibility.getFullAXTree"),
      client.send("Runtime.evaluate", { expression: "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,changeText:document.body?.innerText?.slice(0,4000)??'',scrollTop:document.scrollingElement?.scrollTop??0,maxScrollTop:Math.max(0,(document.scrollingElement?.scrollHeight??0)-(document.scrollingElement?.clientHeight??innerHeight)),viewportHeight:innerHeight,viewportWidth:innerWidth})", returnByValue: true })
    ]);
    const pageState = JSON.parse(runtime.result?.value ?? "{}" );
    const changeText = String(pageState.changeText ?? "");
    delete pageState.changeText;
    const scrollState = {
      scrollTop: Number(pageState.scrollTop ?? 0),
      maxScrollTop: Number(pageState.maxScrollTop ?? 0),
      viewportHeight: Number(pageState.viewportHeight ?? 0),
      viewportWidth: Number(pageState.viewportWidth ?? 0),
      canScrollDown: Number(pageState.maxScrollTop ?? 0) - Number(pageState.scrollTop ?? 0) > 2,
      canScrollUp: Number(pageState.scrollTop ?? 0) > 2
    };
    delete pageState.scrollTop;
    delete pageState.maxScrollTop;
    delete pageState.viewportHeight;
    delete pageState.viewportWidth;
    const pageChangeFingerprint = createHash("sha256").update(JSON.stringify([pageState.url, pageState.title, changeText])).digest("hex");
    const rootFrameId = frameTree?.frame?.id;
    const rootScrollTargets = [
      viewportScrollTarget(this.session.target.id, rootFrameId, this.session.documentGeneration, scrollState),
      ...await captureScrollableTargets(client, { targetId: this.session.target.id, frameId: rootFrameId, generation: this.session.documentGeneration })
    ].filter(Boolean);
    let screenshot = null;
    if (includeScreenshot) {
      try { screenshot = (await client.send("Page.captureScreenshot", { format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false })).data ?? null; }
      catch { screenshot = null; }
    }
    const activity = this.session.activity.snapshot();
    const baseEvidenceBytes = jsonByteLength({ page: pageState, domSnapshot: snapshot, accessibilityTree: ax.nodes ?? [], frameTree, activity, screenshotBase64: screenshot, scrollTargets: rootScrollTargets });
    let remainingFrameBytes = Math.max(0, this.maxEvidenceBytes - baseEvidenceBytes - Math.max(256 * 1024, Math.floor(this.maxEvidenceBytes / 10)));
    const attachedFrames = await this.session.getOutOfProcessFrames?.() ?? [];
    const captureFrame = async frame => {
      try {
        const [frameTreeResult, frameSnapshot, frameAx, frameRuntime] = await Promise.all([
          frame.client.send("Page.getFrameTree"),
          frame.client.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLE_NAMES, includePaintOrder: true, includeDOMRects: true }),
          frame.client.send("Accessibility.getFullAXTree"),
          frame.client.send("Runtime.evaluate", { expression: "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,scrollTop:document.scrollingElement?.scrollTop??0,maxScrollTop:Math.max(0,(document.scrollingElement?.scrollHeight??0)-(document.scrollingElement?.clientHeight??innerHeight)),viewportHeight:innerHeight,viewportWidth:innerWidth})", returnByValue: true })
        ]);
        const childFrameId = frameTreeResult.frameTree?.frame?.id ?? frame.frameId;
        const page = JSON.parse(frameRuntime.result?.value ?? "{}");
        const frameScrollState = {
          scrollTop: Number(page.scrollTop ?? 0),
          maxScrollTop: Number(page.maxScrollTop ?? 0),
          viewportHeight: Number(page.viewportHeight ?? 0),
          viewportWidth: Number(page.viewportWidth ?? 0),
          canScrollDown: Number(page.maxScrollTop ?? 0) - Number(page.scrollTop ?? 0) > 2,
          canScrollUp: Number(page.scrollTop ?? 0) > 2
        };
        delete page.scrollTop;
        delete page.maxScrollTop;
        delete page.viewportHeight;
        delete page.viewportWidth;
        const frameScrollTargets = [
          viewportScrollTarget(this.session.target.id, childFrameId, this.session.documentGeneration, frameScrollState, frame.targetId),
          ...await captureScrollableTargets(frame.client, { targetId: this.session.target.id, frameTargetId: frame.targetId, frameId: childFrameId, generation: this.session.documentGeneration, limit: 4 })
        ].filter(Boolean);
        return {
          targetId: frame.targetId,
          frameId: childFrameId,
          parentFrameId: frame.parentFrameId,
          page,
          domSnapshot: frameSnapshot,
          accessibilityTree: frameAx.nodes ?? [],
          scrollTargets: frameScrollTargets,
          domMutationObservationAvailable: frame.domObservationAvailable,
          networkObservationAvailable: frame.networkObservationAvailable,
          status: "available"
        };
      } catch (error) {
        return { targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "unavailable", errorName: error.name };
      }
    };
    const frameResults = [];
    for (const frame of attachedFrames) {
      if (remainingFrameBytes < 1) {
        frameResults.push({ targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "omitted", reason: "observation_budget" });
        continue;
      }
      const captured = await captureFrame(frame);
      if (captured.status === "available") {
        const frameBytes = jsonByteLength(captured);
        if (frameBytes > remainingFrameBytes) {
          frameResults.push({ targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: "omitted", reason: "observation_budget" });
          continue;
        }
        remainingFrameBytes -= frameBytes;
      }
      frameResults.push(captured);
    }
    const frameSnapshots = frameResults.filter(frame => frame.status === "available");
    const mainDerived = buildCandidates(snapshot, ax.nodes, rootFrameId, this.session.documentGeneration, this.session.target.id);
    const childDerived = frameSnapshots.map(frame => buildCandidates(
      frame.domSnapshot,
      frame.accessibilityTree,
      frame.frameId,
      this.session.documentGeneration,
      this.session.target.id,
      { frameTargetId: frame.targetId, parentFrameId: frame.parentFrameId, outOfProcess: true }
    ));
    const derived = {
      candidates: [...mainDerived.candidates, ...childDerived.flatMap(frame => frame.candidates)].slice(0, 200),
      headings: [...mainDerived.headings, ...childDerived.flatMap(frame => frame.headings)].slice(0, 100),
      frames: [...mainDerived.frames, ...childDerived.flatMap(frame => frame.frames)]
    };
    const scrollTargets = [...rootScrollTargets, ...frameSnapshots.flatMap(frame => frame.scrollTargets ?? [])].slice(0, 32);
    const id = randomUUID();
    const evidence = {
      id,
      capturedAt: new Date().toISOString(),
      documentGeneration: this.session.documentGeneration,
      page: pageState,
      domSnapshot: snapshot,
      accessibilityTree: ax.nodes ?? [],
      frameTree,
      outOfProcessFrames: frameResults,
      activity,
      runtimeStateRecords: [],
      runtimeStateBytes: 0,
      domMutationObservationAvailable: this.session.domObservationAvailable,
      screenshotBase64: screenshot,
      scrollTargets,
      elements: derived.candidates
    };
    const byteLength = jsonByteLength(evidence);
    let retained = byteLength <= this.maxEvidenceBytes;
    if (retained) {
      this.evidence.set(id, { evidence, byteLength });
      this.evidenceBytes += byteLength;
      while (this.evidence.size > this.evidenceLimit || this.evidenceBytes > this.maxEvidenceBytes) {
        const oldestId = this.evidence.keys().next().value;
        const oldest = this.evidence.get(oldestId);
        this.evidence.delete(oldestId);
        this.evidenceBytes -= oldest.byteLength;
        if (oldestId === id) retained = false;
      }
    }
    const compact = {
      evidenceId: id,
      capturedAt: evidence.capturedAt,
      documentGeneration: evidence.documentGeneration,
      page: { ...pageState, url: sanitizeUrl(pageState.url ?? "") },
      frames: derived.frames,
      headings: derived.headings,
      candidates: derived.candidates.map(({ evidence: _e, attributes: _attributes, documentUrl: _documentUrl, ...candidate }) => candidate),
      scrollTargets,
      candidateCount: derived.candidates.length,
      retained,
      networkRequestCount: evidence.activity.totalRequests,
      lifecycleEventCount: evidence.activity.totalLifecycleEvents,
      domMutationCount: evidence.activity.totalDomMutations,
      coverage: {
        domSnapshot: true,
        accessibility: true,
        frameTree: true,
        layout: true,
        scrollTargets: true,
        screenshot: screenshot !== null,
        network: this.session.networkObservationAvailable,
        lifecycleEvents: true,
        domMutations: this.session.domObservationAvailable,
        closedShadowDom: false,
        crossFrameActions: this.session.frameAttachmentAvailable,
        outOfProcessFramesObserved: frameSnapshots.length,
        outOfProcessFramesUnavailable: frameResults.filter(frame => frame.status === "unavailable").length,
        outOfProcessFrameAttachmentFailures: [...(this.session.frameSessions?.values?.() ?? [])].filter(frame => frame.status === "failed").length,
        outOfProcessFramesOmitted: (this.session.frameAttachmentOmitted ?? 0) + frameResults.filter(frame => frame.status === "omitted").length
      }
    };
    Object.defineProperty(compact, "pageChangeFingerprint", { value: pageChangeFingerprint });
    if (includeRawInResponse) compact.raw = this.getEvidence(id, { includeSensitiveFormValues: false });
    return compact;
  }

  async inspectNetworkResponse(id, { requestId, includeSensitive = false, includeSensitiveUrlData = false, maxBytes = DEFAULT_NETWORK_RESPONSE_BYTES } = {}) {
    const stored = this.evidence.get(id)?.evidence;
    if (!stored) return { status: "expired", evidenceId: id };
    if (typeof requestId !== "string" || !requestId) return { status: "not_found", evidenceId: id, requestId: requestId ?? null };
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_NETWORK_RESPONSE_BYTES) {
      throw new Error(`maxBytes must be an integer from 1 to ${MAX_NETWORK_RESPONSE_BYTES}.`);
    }
    const request = stored.activity.networkRequests.filter(item => item.requestId === requestId).at(-1);
    if (!request) return { status: "not_found", evidenceId: id, requestId };
    const { protocolRequestId: _protocolRequestId, ...publicRequest } = request;
    const requestEvidence = {
      ...structuredClone(publicRequest),
      url: request.url ? sanitizeUrl(request.url, { includeSensitiveUrlData }) : request.url,
      redirectedTo: request.redirectedTo ? sanitizeUrl(request.redirectedTo, { includeSensitiveUrlData }) : request.redirectedTo
    };
    if (includeSensitive !== true) {
      return {
        status: "available",
        evidenceId: id,
        request: requestEvidence,
        responseBody: {
          status: "not_returned",
          available: request.finishedAt !== null && !request.failure && !request.redirectedTo,
          reason: "Response bodies may contain credentials or personal data. Set includeSensitive:true only when the caller explicitly wants this response body."
        }
      };
    }
    if (request.failure) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "failed_request" } };
    if (request.redirectedTo) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "redirect_body_unavailable" } };
    if (request.finishedAt === null) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "request_not_finished" } };
    if (!request.protocolRequestId) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "request_identity_unavailable" } };
    const client = this.session.networkClientForTarget?.(request.frameTargetId ?? null);
    if (!client) return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "network_session_unavailable" } };
    let response;
    try {
      response = await client.send("Network.getResponseBody", { requestId: request.protocolRequestId });
    } catch {
      return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "body_evicted_or_unavailable" } };
    }
    if (typeof response?.body !== "string") return { status: "unavailable", evidenceId: id, request: requestEvidence, responseBody: { status: "empty_or_unavailable" } };
    const base64Encoded = response.base64Encoded === true;
    const bytes = base64Encoded ? Buffer.from(response.body, "base64") : Buffer.from(response.body, "utf8");
    const returned = bytes.subarray(0, maxBytes);
    return {
      status: "available",
      evidenceId: id,
      request: requestEvidence,
      responseBody: {
        status: "included",
        contentType: request.mimeType,
        encoding: base64Encoded ? "base64" : "utf-8",
        data: base64Encoded ? returned.toString("base64") : returned.toString("utf8"),
        totalBytes: bytes.length,
        returnedBytes: returned.length,
        truncated: bytes.length > returned.length
      }
    };
  }

  getEvidence(id, { includeSensitiveFormValues = false, includeSensitivePageText = false, includeSensitiveUrlData = false, includeSensitiveRuntimeValues = false, includeScreenshot = false, facets, backendNodeId, frameTargetId = null } = {}) {
    const stored = this.evidence.get(id)?.evidence;
    if (!stored) return { status: "expired", evidenceId: id };
    const selected = new Set(facets ?? ["page", "domSnapshot", "accessibilityTree", "frameTree"]);
    const availableFacets = new Set(["page", "domSnapshot", "accessibilityTree", "frameTree", "outOfProcessFrames", "scrollTargets", "selectedElement", "networkActivity", "lifecycleEvents", "domMutations", "runtimeState"]);
    for (const facet of selected) if (!availableFacets.has(facet)) throw new Error(`Unknown evidence facet: ${facet}`);
    const result = { status: "available", evidenceId: id, capturedAt: stored.capturedAt, documentGeneration: stored.documentGeneration };
    for (const facet of selected) {
      if (facet === "selectedElement") {
        const element = stored.elements.find(item => item.backendNodeId === backendNodeId && (item.frameTargetId ?? null) === frameTargetId);
        if (!element) result.selectedElement = { status: "not_found", backendNodeId };
        else {
          result.selectedElement = structuredClone({ ...element, evidence: undefined, documentUrl: undefined });
          result.selectedElement.frameUrl = sanitizeUrl(element.documentUrl ?? stored.page.url, { includeSensitiveUrlData });
          result.selectedElement.attributes = sanitizedAttributes(element.attributes, element.documentUrl ?? stored.page.url, includeSensitiveUrlData);
          result.selectedElement.href = element.href ? sanitizeUrl(element.href, { includeSensitiveUrlData }) : null;
        }
      } else if (facet === "page") {
        result.page = structuredClone(stored.page);
        if (!includeSensitiveUrlData) result.page.url = sanitizeUrl(result.page.url ?? "");
      } else if (facet === "domSnapshot") {
        result.domSnapshot = sanitizeSnapshotForRetrieval(stored.domSnapshot, { includeSensitiveFormValues, includeSensitiveUrlData });
      } else if (facet === "accessibilityTree") {
        result.accessibilityTree = sanitizeAccessibilityTree(stored.accessibilityTree, { includeSensitiveFormValues, includeSensitiveUrlData });
      } else if (facet === "frameTree") result.frameTree = sanitizeFrameTree(stored.frameTree, includeSensitiveUrlData);
      else if (facet === "scrollTargets") result.scrollTargets = structuredClone(stored.scrollTargets);
      else if (facet === "runtimeState") result.runtimeState = stored.runtimeStateRecords.map(record => includeSensitiveRuntimeValues === true ? structuredClone(record) : redactRuntimeRecord(record));
      else if (facet === "outOfProcessFrames") {
        result.outOfProcessFrames = stored.outOfProcessFrames.map(frame => frame.status === "available" ? {
          targetId: frame.targetId,
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          page: { ...structuredClone(frame.page), url: sanitizeUrl(frame.page?.url ?? "", { includeSensitiveUrlData }) },
          domSnapshot: sanitizeSnapshotForRetrieval(frame.domSnapshot, { includeSensitiveFormValues, includeSensitiveUrlData }),
          accessibilityTree: sanitizeAccessibilityTree(frame.accessibilityTree, { includeSensitiveFormValues, includeSensitiveUrlData }),
          scrollTargets: structuredClone(frame.scrollTargets ?? []),
          domMutationObservationAvailable: frame.domMutationObservationAvailable,
          networkObservationAvailable: frame.networkObservationAvailable,
          status: frame.status
        } : { targetId: frame.targetId, frameId: frame.frameId, parentFrameId: frame.parentFrameId, status: frame.status, errorName: frame.errorName, reason: frame.reason });
      }
      else if (facet === "networkActivity") {
        result.networkActivity = stored.activity.networkRequests.map(request => {
          const { protocolRequestId: _protocolRequestId, ...publicRequest } = request;
          return {
            ...structuredClone(publicRequest),
            url: request.url ? sanitizeUrl(request.url, { includeSensitiveUrlData }) : request.url,
            redirectedTo: request.redirectedTo ? sanitizeUrl(request.redirectedTo, { includeSensitiveUrlData }) : request.redirectedTo
          };
        });
        result.networkActivityCoverage = {
          total: stored.activity.totalRequests,
          dropped: stored.activity.droppedRequests,
          bodiesCaptured: false,
          responseBodyRetrieval: this.session.networkObservationAvailable ? "selected_on_demand" : "unavailable",
          maxSelectedBodyBytes: MAX_NETWORK_RESPONSE_BYTES,
          headersCaptured: false
        };
      } else if (facet === "lifecycleEvents") {
        result.lifecycleEvents = stored.activity.lifecycleEvents.map(event => ({
          ...structuredClone(event),
          url: event.url ? sanitizeUrl(event.url, { includeSensitiveUrlData }) : event.url
        }));
        result.lifecycleEventCoverage = {
          total: stored.activity.totalLifecycleEvents,
          dropped: stored.activity.droppedLifecycleEvents
        };
      } else {
        result.domMutations = stored.activity.domMutations.map(mutation => sanitizeDomMutation(mutation, { includeSensitiveFormValues, includeSensitivePageText, includeSensitiveUrlData }));
        result.domMutationCoverage = {
          total: stored.activity.totalDomMutations,
          dropped: stored.activity.droppedDomMutations,
          available: stored.domMutationObservationAvailable
        };
      }
    }
    if (includeScreenshot) result.screenshotBase64 = stored.screenshotBase64;
    // AX names and DOM text are page-provided, untrusted content. They are evidence, not instructions.
    return result;
  }
}
