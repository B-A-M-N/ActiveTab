import { createHash, randomUUID } from "node:crypto";
import { sanitizeUrl, sanitizeUrlAttribute, URL_ATTRIBUTES } from "../browser/urlPrivacy.js";
import { redactCredentialUrl } from "./responseBodyInspector.js";
import { inspectNetworkResponse, pageResponseProjection, MAX_NETWORK_RESPONSE_CHUNK_BYTES } from "./selectedResponseInspector.js";
import { planJevImagePreparation } from "../decisions/imagePreparation.js";
import { compileSemanticPageModel, rankInteractionCandidates } from "./semanticPageCompiler.js";
import { queryRetainedControls } from "./targetedControlLookup.js";
import { buildDocumentIndex, documentIndexFor } from "./documentIndex.js";
import { jsonByteLength } from "./evidenceSizing.js";
import { inspectRuntimeState } from "./runtimeStateInspector.js";

const STYLE_NAMES = ["display", "visibility", "opacity", "pointer-events", "position", "z-index"];
const ACTIONABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const CONTEXT_CONTAINERS = new Set(["SECTION", "ARTICLE", "NAV", "ASIDE", "MAIN", "FORM"]);
const MAX_SCROLL_TARGETS_PER_FRAME = 8;
const NETWORK_RESPONSE_PROJECTION_CACHE_TTL_MS = 5 * 60_000;
const NETWORK_RESPONSE_PROJECTION_CACHE_MAX_ENTRIES = 2;
const NETWORK_RESPONSE_PROJECTION_CACHE_MAX_BYTES = 18 * 1024 * 1024;
const NETWORK_RESPONSE_PROJECTION_CACHE_MAX_ENTRY_BYTES = 17 * 1024 * 1024;
const FORBIDDEN_VALUE_ATTRIBUTES = new Set(["value", "placeholder"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "progressbar"]);
const MAX_RETAINED_LOOKUP_CANDIDATES = 10_000;
const OBSERVATION_PROFILES = new Set(["lightweight", "interaction", "structural", "visual"]);
const keyForNode = (frameTargetId, documentIndex, nodeIndex) => `${frameTargetId ?? "root"}:${documentIndex}:${nodeIndex}`;
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

function retainDocumentTraversalIndex(index) {
  if (!index) return null;
  return {
    snapshot: index.snapshot,
    frameTargetId: index.frameTargetId,
    parentFrameId: index.parentFrameId,
    documents: index.documents.map(document => document ? {
      snapshot: index.snapshot,
      documentIndex: document.documentIndex,
      frameId: document.frameId,
      sourceDocument: document.sourceDocument,
      children: document.children,
      backendNodeIndexes: document.backendNodeIndexes
    } : null)
  };
}

function estimateLookupIndexBytes(index) {
  if (!index?.available) return 0;
  let bytes = jsonByteLength(index.candidates);
  for (const frame of index.frames) {
    for (const document of frame.documents ?? []) {
      if (!document) continue;
      const nodeCount = document.sourceDocument?.nodes?.nodeName?.length ?? 0;
      // Account for retained parent/child and backend-node lookup structures.
      bytes += nodeCount * 64 + (document.children?.size ?? 0) * 40;
    }
  }
  return bytes;
}

function instrumentCaptureClient(client, metrics) {
  return {
    send(method, ...args) {
      metrics.cdpRoundTrips++;
      const startedAt = Date.now();
      if (method === "DOMSnapshot.captureSnapshot") metrics.domSnapshotCount++;
      return Promise.resolve().then(() => client.send(method, ...args)).finally(() => {
        const duration = Date.now() - startedAt;
        metrics.totalCdpRoundTripMs += duration;
        if (metrics.cdpRoundTripDurations.length < 2048) metrics.cdpRoundTripDurations.push(duration);
      });
    }
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function parentFrameIdFromTree(tree, childFrameId, parentId = null) {
  const node = tree?.frameTree ?? tree;
  if (!node?.frame?.id) return null;
  if (node.frame.id === childFrameId) return parentId;
  for (const child of node.childFrames ?? []) {
    const found = parentFrameIdFromTree(child, childFrameId, node.frame.id);
    if (found) return found;
  }
  return null;
}

async function captureFrameGeometry(session, frame, childFrameId, frameViewport, rootClient, metrics) {
  const parentFrame = [...(session.frameSessions?.values?.() ?? [])].find(item => item.sessionId === frame.parentSessionId);
  const isRootParent = frame.parentSessionId === session.sessionId;
  const parentClient = parentFrame?.client ?? (isRootParent ? rootClient : null);
  if (!parentClient) return { status: "unavailable", reason: "parent_frame_session_unavailable" };
  try {
    const client = instrumentCaptureClient(parentClient, metrics);
    let parentFrameId = frame.parentFrameId;
    if (!parentFrameId) {
      const parentTree = await client.send("Page.getFrameTree");
      parentFrameId = parentFrameIdFromTree(parentTree, childFrameId);
    }
    if (!parentFrameId) return { status: "unavailable", reason: "parent_frame_identity_unavailable" };
    const owner = await client.send("DOM.getFrameOwner", { frameId: childFrameId });
    if (!Number.isInteger(owner?.backendNodeId)) return { status: "unavailable", reason: "frame_owner_unavailable" };
    const box = await client.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
    const quad = box?.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) {
      return { status: "unavailable", reason: "frame_owner_geometry_unavailable" };
    }
    return {
      status: "available",
      frameTargetId: frame.targetId,
      frameId: frame.frameId,
      parentTargetId: parentFrame?.targetId ?? null,
      parentFrameId,
      viewport: { width: frameViewport.width, height: frameViewport.height },
      ownerContentQuad: quad
    };
  } catch {
    return { status: "unavailable", reason: "frame_geometry_capture_failed" };
  }
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

function buildCandidates(snapshot, axTree, rootFrameId, generation, targetId, {
  frameTargetId = null,
  parentFrameId = null,
  outOfProcess = false,
  selectionGoal = "",
  candidateLimit = 200,
  priorityCandidateIdentities = [],
  documentIndex: suppliedIndex = null
} = {}) {
  const axFacts = accessibleFacts(axTree);
  const candidates = [];
  const candidateLocations = [];
  const headings = [];
  const frameSummaries = [];
  const sharedIndex = documentIndexFor(snapshot, suppliedIndex, { frameTargetId, parentFrameId });
  for (const indexedDocument of sharedIndex.documents) {
    const document = indexedDocument?.sourceDocument;
    if (!document) continue;
    const frameId = indexedDocument.frameId;
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
    const attributesByNode = indexedDocument.attributes;
    const formIndexesById = indexedDocument.formIndexesById;
    for (let index = nodeNames.length - 1; index >= 0; index--) {
      const value = stringAt(snapshot.strings, textValues[index] ?? nodeValues[index]);
      if (value) text[index] = value.slice(0, 2_000);
      const parent = parents[index];
      if (Number.isInteger(parent) && parent >= 0 && text[index]) text[parent] = `${text[parent]} ${text[index]}`.trim().slice(0, 2_000);
    }
    const childrenByParent = indexedDocument.children;
    const contextNameFor = index => {
      let branch = index;
      for (let depth = 0; depth < 8; depth++) {
        const parent = parents[branch];
        if (!Number.isInteger(parent) || parent < 0) break;
        const siblings = childrenByParent.get(parent) ?? [];
        const branchPosition = siblings.indexOf(branch);
        for (let siblingPosition = branchPosition - 1; siblingPosition >= 0; siblingPosition--) {
          const sibling = siblings[siblingPosition];
          if (/^H[1-6]$/.test(indexedDocument.tags[sibling]) && text[sibling]) {
            return text[sibling].trim().slice(0, 160);
          }
        }
        const parentTag = indexedDocument.tags[parent];
        const parentAttributes = attributesByNode[parent];
        const parentRole = String(parentAttributes.role ?? "").toLowerCase();
        if (CONTEXT_CONTAINERS.has(parentTag) || ["region", "group"].includes(parentRole)) {
          const namedContext = parentAttributes["aria-label"] || parentAttributes.title;
          if (namedContext) return String(namedContext).trim().slice(0, 160);
        }
        branch = parent;
      }
      return null;
    };
    const recordContextFor = index => {
      let ancestor = parents[index];
      for (let depth = 0; depth < 12 && Number.isInteger(ancestor) && ancestor >= 0; depth++) {
        const ancestorTag = indexedDocument.tags[ancestor];
        const ancestorRole = String(attributesByNode[ancestor]?.role ?? "").toLowerCase();
        if (["TR", "LI", "ARTICLE"].includes(ancestorTag) || ["row", "listitem", "article"].includes(ancestorRole)) {
          const value = String(text[ancestor] ?? "").replace(/\s+/gu, " ").trim();
          if (value) return value.slice(0, 180);
        }
        ancestor = parents[ancestor];
      }
      return null;
    };
    for (let index = 0; index < nodeNames.length; index++) {
      const tag = indexedDocument.tags[index];
      const attrs = attributesByNode[index];
      const role = attrs.role?.toLowerCase();
      const isActionable = ACTIONABLE_TAGS.has(tag) || ["button", "link", "menuitem", "option", "checkbox", "radio", "tab", "textbox", "combobox"].includes(role) || "tabindex" in attrs || attrs["contenteditable"] === "true";
      const backendNodeId = nodes.backendNodeId?.[index];
      if (!controlSupported || !Number.isInteger(backendNodeId)) continue;
      const accessible = axFacts.get(backendNodeId);
      const label = accessible?.name || attrs["aria-label"] || attrs.title || attrs.alt || text[index] || attrs.name || "";
      const rect = rects.get(index);
      const visible = rect ? rect.width > 0 && rect.height > 0 : null;
      const explicitType = String(attrs.type ?? "").toLowerCase();
      const submitsByDefault = tag === "BUTTON" && (!explicitType || explicitType === "submit") || tag === "INPUT" && ["submit", "image"].includes(explicitType);
      let formIndex = attrs.form ? formIndexesById.get(String(attrs.form)) : undefined;
      let ancestor = parents[index];
      while (!Number.isInteger(formIndex) && Number.isInteger(ancestor) && ancestor >= 0) {
        if (stringAt(snapshot.strings, nodeNames[ancestor]).toUpperCase() === "FORM") formIndex = ancestor;
        ancestor = parents[ancestor];
      }
      const associatedWithForm = Number.isInteger(formIndex);
      const linkTarget = typeof attrs.target === "string" ? attrs.target.trim().toLowerCase() : "";
      const opensNewTarget = Boolean(linkTarget && !["_self", "_parent", "_top"].includes(linkTarget));
      const formAttributes = Number.isInteger(formIndex) ? attributesByNode[formIndex] : null;
      const formBackendNodeId = Number.isInteger(formIndex) ? nodes.backendNodeId?.[formIndex] : null;
      let formActionOrigin = null;
      if (formAttributes) {
        try { formActionOrigin = new URL(attrs.formaction || formAttributes.action || documentUrl, documentUrl).origin; }
        catch { formActionOrigin = null; }
      }
      const formMethod = formAttributes
        ? String(attrs.formmethod ?? formAttributes.method ?? "get").toLowerCase()
        : null;
      const formTarget = String(attrs.formtarget ?? formAttributes?.target ?? "").trim().toLowerCase();
      const formTargetSameContext = !formTarget || formTarget === "_self";
      let documentOrigin = null;
      try { documentOrigin = new URL(documentUrl).origin; }
      catch { /* A malformed document URL cannot produce a public query-field cue. */ }
      const isSameOriginGetQueryField = explicitType === "text"
        && String(attrs.name ?? "") === "q"
        && Boolean(formAttributes)
        && formMethod === "get"
        && formTargetSameContext
        && Boolean(documentOrigin)
        && formActionOrigin === documentOrigin;
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
        contentEditable: ["true", "", "plaintext-only"].includes(attrs.contenteditable),
        name: String(label).trim().slice(0, 300),
        contextName: contextNameFor(index),
        recordContext: recordContextFor(index),
        ...(isSameOriginGetQueryField ? { queryField: true } : {}),
        href: attrs.href ? sanitizeUrl(attrs.href, { base: stringAt(snapshot.strings, document.documentURL) }) : null,
        opensNewTarget,
        type: attrs.type ?? null,
        submitsForm: submitsByDefault && associatedWithForm,
        ...(formAttributes && Number.isInteger(formBackendNodeId) ? {
          formIdentity: `${targetId}:${frameTargetId ?? "root"}:${frameId}:${formBackendNodeId}:${generation}`,
          formBackendNodeId,
          formMethod,
          formActionOrigin,
          formTargetSameContext
        } : {}),
        disabled: attrs.disabled !== undefined || attrs["aria-disabled"] === "true",
        visible,
        bounds: rect ?? null,
        evidence: { source: "DOMSnapshot + Accessibility tree", backendNodeId }
      });
      candidateLocations.push({ documentIndex: indexedDocument.documentIndex, nodeIndex: index });
    }
  }
  const selection = rankInteractionCandidates(candidates, selectionGoal, {
    maxCandidates: candidateLimit,
    priorityCandidateIdentities
  });
  return {
    candidates: [...selection.candidates],
    candidateCount: candidates.length,
    taskRelevantCandidateCount: selection.taskRelevantCandidateCount,
    scopeCandidateCount: selection.scopeCandidateCount,
    returnedCandidateCount: selection.candidates.length,
    returnedScopeCandidateCount: selection.returnedScopeCandidateCount,
    scopeCandidateIdentities: [...selection.scopeCandidateIdentities],
    lookupCandidates: candidates.map((candidate, candidateIndex) => {
      const location = candidateLocations[candidateIndex];
      return {
        identity: candidate.identity,
        targetId: candidate.targetId,
        documentGeneration: candidate.documentGeneration,
        frameTargetId: candidate.frameTargetId ?? null,
        frameId: candidate.frameId,
        documentIndex: location.documentIndex,
        nodeIndex: location.nodeIndex,
        backendNodeId: candidate.backendNodeId,
        role: candidate.role,
        tag: candidate.tag,
        name: candidate.name,
        contextName: candidate.contextName,
        visible: candidate.visible,
        disabled: candidate.disabled,
        bounds: candidate.bounds
      };
    }),
    headings: headings.slice(0, 100),
    headingCount: headings.length,
    frames: frameSummaries
  };
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
    this.peakRetainedEvidenceBytes = 0;
    this.networkSignalState = new Map();
    this.responseProjectionCache = new Map();
    this.responseProjectionCacheBytes = 0;
  }

  async queryAccessibility(id, query) {
    const stored = this.evidence.get(id);
    if (!stored) return { status: "expired", evidenceId: id, actionAuthorized: false };
    return queryRetainedControls({
      session: this.session,
      evidence: stored.evidence,
      lookupIndex: stored.lookupIndex,
      input: query
    });
  }

  async lookupRetainedCandidates(id, { targetTokens, maxNodes = 500, maxResults = 20, timeoutMs = 1_500 } = {}) {
    return this.queryAccessibility(id, { targetTokens, maxNodes, maxResults, timeoutMs });
  }

  getHitTestContext(id) {
    const stored = this.evidence.get(id);
    if (!stored) return { status: "expired", evidenceId: id };
    const evidence = stored.evidence;
    if (evidence.targetId !== this.session.target?.id
      || evidence.documentGeneration !== this.session.documentGeneration) {
      return { status: "stale", reasonCode: "stale_document", evidenceId: id };
    }
    const mutationCount = this.session.activity?.totalDomMutations;
    if (!Number.isInteger(mutationCount) || mutationCount !== evidence.activity?.totalDomMutations) {
      return { status: "stale", reasonCode: Number.isInteger(mutationCount) ? "dom_changed_since_observation" : "dom_freshness_unavailable", evidenceId: id };
    }
    if (evidence.observationProfile !== "visual" || typeof evidence.screenshotBase64 !== "string") {
      return { status: "unavailable", reasonCode: "visual_evidence_unavailable", evidenceId: id };
    }
    if (!stored.lookupIndex?.available) return { status: "unavailable", reasonCode: "retained_lookup_unavailable", evidenceId: id };
    return {
      status: "available",
      evidenceId: id,
      targetId: evidence.targetId,
      documentGeneration: evidence.documentGeneration,
      viewport: structuredClone(evidence.viewport),
      viewportScroll: structuredClone(evidence.viewportScroll ?? { x: 0, y: evidence.scrollTargets?.[0]?.scrollTop ?? 0 }),
      deviceScaleFactor: evidence.deviceScaleFactor,
      rootFrameId: evidence.frameTree?.frame?.id ?? null,
      domMutationCount: evidence.activity.totalDomMutations
    };
  }

  resolveCandidateForHitNode(id, { backendNodeId, frameId, x, y } = {}) {
    const stored = this.evidence.get(id);
    if (!stored) return { status: "expired", reasonCode: "evidence_expired" };
    const evidence = stored.evidence;
    const lookupIndex = stored.lookupIndex;
    if (evidence.targetId !== this.session.target?.id
      || evidence.documentGeneration !== this.session.documentGeneration) {
      return { status: "stale", reasonCode: "stale_document" };
    }
    if (!Number.isInteger(this.session.activity?.totalDomMutations)
      || this.session.activity.totalDomMutations !== evidence.activity?.totalDomMutations) {
      return { status: "stale", reasonCode: "dom_changed_since_observation" };
    }
    if (!Number.isInteger(backendNodeId) || typeof frameId !== "string" || !frameId
      || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { status: "invalid", reasonCode: "hit_test_binding_invalid" };
    }
    const rootFrameId = evidence.frameTree?.frame?.id;
    if (!rootFrameId || frameId !== rootFrameId) return { status: "unavailable", reasonCode: "frame_unavailable" };
    const rootIndex = lookupIndex?.frames?.find(frame => frame.frameTargetId === null);
    const documents = rootIndex?.documents?.filter(document => document?.frameId === frameId) ?? [];
    if (documents.length !== 1) return { status: "unavailable", reasonCode: "snapshot_unavailable" };
    const document = documents[0];
    if (document.snapshot !== rootIndex.snapshot || document.snapshot !== evidence.domSnapshot) {
      return { status: "stale", reasonCode: "snapshot_binding_mismatch" };
    }
    const startNodeIndex = document.backendNodeIndexes?.get(backendNodeId);
    if (!Number.isInteger(startNodeIndex)) return { status: "unavailable", reasonCode: "hit_node_not_in_retained_snapshot" };
    const candidateByNode = new Map((lookupIndex.candidates ?? []).map(candidate => [
      keyForNode(candidate.frameTargetId, candidate.documentIndex, candidate.nodeIndex), candidate
    ]));
    const parentIndexes = document.sourceDocument?.nodes?.parentIndex ?? [];
    const visited = new Set();
    let nodeIndex = startNodeIndex;
    for (let depth = 0; depth < 16 && Number.isInteger(nodeIndex) && nodeIndex >= 0; depth++) {
      if (visited.has(nodeIndex)) return { status: "unavailable", reasonCode: "snapshot_cycle" };
      visited.add(nodeIndex);
      const candidate = candidateByNode.get(keyForNode(null, document.documentIndex, nodeIndex));
      if (candidate) {
        if (candidate.targetId !== evidence.targetId || candidate.documentGeneration !== evidence.documentGeneration
          || candidate.frameTargetId !== null || candidate.frameId !== frameId) {
          return { status: "stale", reasonCode: "candidate_binding_mismatch" };
        }
        if (candidate.visible !== true || candidate.disabled === true) {
          return { status: "unavailable", reasonCode: "hit_candidate_not_actionable" };
        }
        const bounds = candidate.bounds;
        if (!bounds || x < bounds.x - 2 || y < bounds.y - 2
          || x > bounds.x + bounds.width + 2 || y > bounds.y + bounds.height + 2) {
          return { status: "unavailable", reasonCode: "hit_candidate_bounds_mismatch" };
        }
        return {
          status: "candidate",
          candidateHint: {
            identity: candidate.identity,
            targetId: candidate.targetId,
            documentGeneration: candidate.documentGeneration,
            frameTargetId: candidate.frameTargetId,
            frameId: candidate.frameId,
            backendNodeId: candidate.backendNodeId
          },
          visitedNodeCount: visited.size,
          reasonCode: "candidate_found_at_hit_location"
        };
      }
      nodeIndex = parentIndexes[nodeIndex];
    }
    return { status: "unavailable", visitedNodeCount: visited.size, reasonCode: "no_actionable_candidate_at_hit_location" };
  }

  async inspectRuntimeState(id, options = {}) {
    return inspectRuntimeState(this, id, options);
  }

  async capture({ profile = "interaction", includeScreenshot, includeRawInResponse = false, prepareForJev = false, selectionGoal = "", candidateLimit = 200, priorityCandidateIdentities = [] } = {}) {
    if (!OBSERVATION_PROFILES.has(profile)) throw new Error(`profile must be one of: ${[...OBSERVATION_PROFILES].join(", ")}.`);
    if (includeScreenshot !== undefined && typeof includeScreenshot !== "boolean") throw new Error("includeScreenshot must be a boolean.");
    if (typeof prepareForJev !== "boolean") throw new Error("prepareForJev must be a boolean.");
    if (typeof selectionGoal !== "string" || selectionGoal.length > 2_048) throw new Error("selectionGoal must be a string no longer than 2048 characters.");
    if (!Number.isInteger(candidateLimit) || candidateLimit < 200 || candidateLimit > 384) throw new Error("candidateLimit must be an integer from 200 to 384.");
    if (!Array.isArray(priorityCandidateIdentities) || priorityCandidateIdentities.length > 4
      || priorityCandidateIdentities.some(identity => typeof identity !== "string" || !identity || identity.length > 256)) {
      throw new Error("priorityCandidateIdentities must contain at most four bounded exact candidate identities.");
    }
    priorityCandidateIdentities = [...new Set(priorityCandidateIdentities)];
    const captureStartedAt = Date.now();
    const memoryBefore = process.memoryUsage();
    const metrics = { cdpRoundTrips: 0, totalCdpRoundTripMs: 0, domSnapshotCount: 0, cdpRoundTripDurations: [] };
    const rawClient = this.session.client;
    const client = instrumentCaptureClient(rawClient, metrics);
    const captureStructure = profile !== "lightweight";
    const deriveInteraction = profile === "interaction" || profile === "visual";
    const deriveSemantic = profile !== "lightweight";
    const captureScreenshot = includeScreenshot ?? profile === "visual";
    const runtimeExpression = profile === "lightweight"
      ? "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState})"
      : "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,scrollTop:document.scrollingElement?.scrollTop??0,scrollLeft:document.scrollingElement?.scrollLeft??0,scrollX,scrollY,maxScrollTop:Math.max(0,(document.scrollingElement?.scrollHeight??0)-(document.scrollingElement?.clientHeight??innerHeight)),viewportHeight:innerHeight,viewportWidth:innerWidth,deviceScaleFactor:window.devicePixelRatio||1})";
    const [{ frameTree }, snapshot, ax, runtime] = await Promise.all([
      client.send("Page.getFrameTree"),
      captureStructure
        ? client.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLE_NAMES, includePaintOrder: true, includeDOMRects: true })
        : Promise.resolve({ strings: [], documents: [] }),
      captureStructure ? client.send("Accessibility.getFullAXTree") : Promise.resolve({ nodes: [] }),
      client.send("Runtime.evaluate", { expression: runtimeExpression, returnByValue: true })
    ]);
    const pageState = JSON.parse(runtime.result?.value ?? "{}" );
    const deviceScaleFactor = Number.isFinite(pageState.deviceScaleFactor) && pageState.deviceScaleFactor > 0 && pageState.deviceScaleFactor <= 8
      ? pageState.deviceScaleFactor : 1;
    const viewportScroll = {
      x: Number.isFinite(pageState.scrollX) ? pageState.scrollX : Number(pageState.scrollLeft ?? 0),
      y: Number.isFinite(pageState.scrollY) ? pageState.scrollY : Number(pageState.scrollTop ?? 0)
    };
    const activity = this.session.activity.snapshot();
    const scrollState = {
      scrollTop: Number(pageState.scrollTop ?? 0),
      scrollLeft: Number(pageState.scrollLeft ?? 0),
      maxScrollTop: Number(pageState.maxScrollTop ?? 0),
      viewportHeight: Number(pageState.viewportHeight ?? 0),
      viewportWidth: Number(pageState.viewportWidth ?? 0),
      deviceScaleFactor,
      canScrollDown: Number(pageState.maxScrollTop ?? 0) - Number(pageState.scrollTop ?? 0) > 2,
      canScrollUp: Number(pageState.scrollTop ?? 0) > 2
    };
    delete pageState.scrollTop;
    delete pageState.scrollLeft;
    delete pageState.scrollX;
    delete pageState.scrollY;
    delete pageState.maxScrollTop;
    delete pageState.viewportHeight;
    delete pageState.viewportWidth;
    delete pageState.deviceScaleFactor;
    const pageChangeFingerprint = createHash("sha256").update(JSON.stringify([
      pageState.url,
      pageState.title,
      pageState.readyState,
      this.session.documentGeneration,
      activity.totalDomMutations,
      activity.totalLifecycleEvents
    ])).digest("hex");
    const rootFrameId = frameTree?.frame?.id;
    const rootScrollTargets = deriveInteraction ? [
      viewportScrollTarget(this.session.target.id, rootFrameId, this.session.documentGeneration, scrollState),
      ...await captureScrollableTargets(client, { targetId: this.session.target.id, frameId: rootFrameId, generation: this.session.documentGeneration })
    ].filter(Boolean) : [];
    let screenshot = null;
    if (captureScreenshot) {
      const preparation = prepareForJev ? planJevImagePreparation({
        width: Math.round(scrollState.viewportWidth * deviceScaleFactor),
        height: Math.round(scrollState.viewportHeight * deviceScaleFactor)
      }) : null;
      const screenshotOptions = { format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false };
      if (preparation?.status === "ready" && preparation.scale < 1) {
        screenshotOptions.clip = {
          x: 0,
          y: 0,
          width: scrollState.viewportWidth,
          height: scrollState.viewportHeight,
          scale: preparation.scale
        };
      }
      try { screenshot = (await client.send("Page.captureScreenshot", screenshotOptions)).data ?? null; }
      catch { screenshot = null; }
    }
    const baseEvidenceBytes = jsonByteLength({ page: pageState, domSnapshot: snapshot, accessibilityTree: ax.nodes ?? [], frameTree, activity, screenshotBase64: screenshot, scrollTargets: rootScrollTargets });
    let remainingFrameBytes = Math.max(0, this.maxEvidenceBytes - baseEvidenceBytes - Math.max(256 * 1024, Math.floor(this.maxEvidenceBytes / 10)));
    const attachedFrames = captureStructure
      ? await this.session.getOutOfProcessFrames?.({
        onCdpRoundTrip: durationMs => {
          metrics.cdpRoundTrips++;
          metrics.totalCdpRoundTripMs += durationMs;
        }
      }) ?? []
      : [];
    const captureFrame = async frame => {
      try {
        const frameClient = instrumentCaptureClient(frame.client, metrics);
        const [frameTreeResult, frameSnapshot, frameAx, frameRuntime] = await Promise.all([
          frameClient.send("Page.getFrameTree"),
          frameClient.send("DOMSnapshot.captureSnapshot", { computedStyles: STYLE_NAMES, includePaintOrder: true, includeDOMRects: true }),
          frameClient.send("Accessibility.getFullAXTree"),
          frameClient.send("Runtime.evaluate", { expression: runtimeExpression, returnByValue: true })
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
        const frameGeometry = await captureFrameGeometry(this.session, frame, childFrameId, {
          width: frameScrollState.viewportWidth,
          height: frameScrollState.viewportHeight
        }, client, metrics);
        delete page.scrollTop;
        delete page.maxScrollTop;
        delete page.viewportHeight;
        delete page.viewportWidth;
        const frameScrollTargets = deriveInteraction ? [
          viewportScrollTarget(this.session.target.id, childFrameId, this.session.documentGeneration, frameScrollState, frame.targetId),
          ...await captureScrollableTargets(frameClient, { targetId: this.session.target.id, frameTargetId: frame.targetId, frameId: childFrameId, generation: this.session.documentGeneration, limit: 4 })
        ].filter(Boolean) : [];
        return {
          targetId: frame.targetId,
          frameId: childFrameId,
          parentFrameId: frame.parentFrameId,
          page,
          frameGeometry,
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
    const documentIndexStartedAt = performance.now();
    const rootDocumentIndex = deriveSemantic
      ? buildDocumentIndex(snapshot, { frameTargetId: null, parentFrameId: null })
      : null;
    const frameDocumentIndexes = deriveSemantic ? frameSnapshots.map(frame => buildDocumentIndex(frame.domSnapshot, {
      frameTargetId: frame.targetId,
      parentFrameId: frame.parentFrameId
    })) : [];
    metrics.documentIndexBuildCount = deriveSemantic ? 1 + frameDocumentIndexes.length : 0;
    metrics.documentIndexBuildMs = performance.now() - documentIndexStartedAt;
    const candidateDerivationStartedAt = performance.now();
    const mainDerived = deriveInteraction
      ? buildCandidates(snapshot, ax.nodes, rootFrameId, this.session.documentGeneration, this.session.target.id, {
        selectionGoal,
        candidateLimit,
        priorityCandidateIdentities,
        documentIndex: rootDocumentIndex
      })
      : { candidates: [], lookupCandidates: [], candidateCount: 0, taskRelevantCandidateCount: 0, scopeCandidateCount: 0, returnedCandidateCount: 0, returnedScopeCandidateCount: 0, scopeCandidateIdentities: [], headings: [], headingCount: 0, frames: [] };
    const childDerived = deriveInteraction ? frameSnapshots.map((frame, frameIndex) => buildCandidates(
      frame.domSnapshot,
      frame.accessibilityTree,
      frame.frameId,
      this.session.documentGeneration,
      this.session.target.id,
      {
        frameTargetId: frame.targetId,
        parentFrameId: frame.parentFrameId,
        outOfProcess: true,
        selectionGoal,
        candidateLimit,
        priorityCandidateIdentities,
        documentIndex: frameDocumentIndexes[frameIndex]
      }
    )) : [];
    metrics.candidateDerivationMs = performance.now() - candidateDerivationStartedAt;
    const observedCandidateCount = mainDerived.candidateCount + childDerived.reduce((total, frame) => total + frame.candidateCount, 0);
    const observedHeadingCount = mainDerived.headingCount + childDerived.reduce((total, frame) => total + frame.headingCount, 0);
    const taskRelevantCandidateCount = mainDerived.taskRelevantCandidateCount + childDerived.reduce((total, frame) => total + frame.taskRelevantCandidateCount, 0);
    const scopeCandidateCount = taskRelevantCandidateCount > 0
      ? mainDerived.scopeCandidateCount + childDerived.reduce((total, frame) => total + frame.scopeCandidateCount, 0)
      : observedCandidateCount;
    const combinedCandidates = [...mainDerived.candidates, ...childDerived.flatMap(frame => frame.candidates)];
    const combinedPriorityCandidateIdentities = mainDerived.scopeCandidateIdentities
      .concat(...childDerived.map(frame => frame.scopeCandidateIdentities));
    const combinedRanking = rankInteractionCandidates(combinedCandidates, selectionGoal, {
      maxCandidates: candidateLimit,
      priorityCandidateIdentities: [...combinedPriorityCandidateIdentities, ...priorityCandidateIdentities]
    });
    const derived = {
      candidates: [...combinedRanking.candidates],
      headings: [...mainDerived.headings, ...childDerived.flatMap(frame => frame.headings)].slice(0, 100),
      frames: [...mainDerived.frames, ...childDerived.flatMap(frame => frame.frames)]
    };
    const allLookupCandidates = [
      ...mainDerived.lookupCandidates,
      ...childDerived.flatMap(frame => frame.lookupCandidates)
    ];
    const lookupIndex = {
      available: deriveInteraction && Boolean(rootDocumentIndex),
      candidateCount: allLookupCandidates.length,
      candidateCoverage: deriveInteraction && allLookupCandidates.length <= MAX_RETAINED_LOOKUP_CANDIDATES ? "complete" : "incomplete",
      candidates: allLookupCandidates.slice(0, MAX_RETAINED_LOOKUP_CANDIDATES),
      frames: rootDocumentIndex ? [
        retainDocumentTraversalIndex(rootDocumentIndex),
        ...frameDocumentIndexes.map(retainDocumentTraversalIndex)
      ] : []
    };
    const lookupIndexBytes = estimateLookupIndexBytes(lookupIndex);
    const returnedScopeCandidateCount = mainDerived.scopeCandidateIdentities
      .concat(...childDerived.map(frame => frame.scopeCandidateIdentities))
      .filter(identity => derived.candidates.some(candidate => candidate.identity === identity)).length;
    const taskScopedSelection = combinedRanking.selectionScope === "task_relevant_region" && taskRelevantCandidateCount > 0;
    const candidateCoverage = {
      pageCandidateCount: observedCandidateCount,
      returnedCandidateCount: derived.candidates.length,
      omittedCandidateCount: Math.max(0, observedCandidateCount - derived.candidates.length),
      pageCoverage: observedCandidateCount <= derived.candidates.length ? "complete" : "partial",
      selectionScope: taskScopedSelection ? "task_relevant_region" : "page",
      taskRelevantCandidateCount,
      scopeCandidateCount,
      returnedScopeCandidateCount,
      scopeCoverage: scopeCandidateCount <= returnedScopeCandidateCount ? "complete" : "incomplete",
      truncated: observedCandidateCount > derived.candidates.length
    };
    const headingCoverage = {
      pageHeadingCount: observedHeadingCount,
      returnedHeadingCount: derived.headings.length,
      truncated: observedHeadingCount > derived.headings.length
    };
    const scrollTargets = [...rootScrollTargets, ...frameSnapshots.flatMap(frame => frame.scrollTargets ?? [])].slice(0, 32);
    const coverage = {
      domSnapshot: captureStructure,
      accessibility: captureStructure,
      frameTree: true,
      layout: captureStructure,
      scrollTargets: deriveInteraction,
      interactionCandidates: deriveInteraction,
      interactionCandidatesTruncated: candidateCoverage.truncated,
      interactionCandidateCount: observedCandidateCount,
      screenshot: screenshot !== null,
      network: this.session.networkObservationAvailable,
      lifecycleEvents: true,
      domMutations: this.session.domObservationAvailable,
      closedShadowDom: false,
      crossFrameActions: deriveInteraction && this.session.frameAttachmentAvailable,
      outOfProcessFramesCaptured: captureStructure,
      outOfProcessFramesObserved: frameSnapshots.length,
      outOfProcessFramesUnavailable: frameResults.filter(frame => frame.status === "unavailable").length,
      outOfProcessFrameAttachmentFailures: captureStructure ? [...(this.session.frameSessions?.values?.() ?? [])].filter(frame => frame.status === "failed").length : 0,
      outOfProcessFramesOmitted: captureStructure ? (this.session.frameAttachmentOmitted ?? 0) + frameResults.filter(frame => frame.status === "omitted").length : 0
    };
    const id = randomUUID();
    const evidence = {
      id,
      targetId: this.session.target.id,
      capturedAt: new Date().toISOString(),
      documentGeneration: this.session.documentGeneration,
      viewport: { width: scrollState.viewportWidth, height: scrollState.viewportHeight },
      viewportScroll,
      deviceScaleFactor,
      observationProfile: profile,
      coverage,
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
    const semanticCompilationStartedAt = performance.now();
    const semanticPage = deriveSemantic ? compileSemanticPageModel({
      observationId: id,
      targetId: this.session.target.id,
      documentGeneration: this.session.documentGeneration,
      page: pageState,
      domSnapshot: snapshot,
      frameSnapshots: frameSnapshots.map(frame => ({
        targetId: frame.targetId,
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        domSnapshot: frame.domSnapshot
      })),
      documentIndex: rootDocumentIndex,
      frameDocumentIndexes,
      candidates: deriveInteraction ? derived.candidates : [],
      controlLimit: candidateLimit,
      headings: derived.headings,
      headingCount: observedHeadingCount,
      candidateCoverage,
      coverage
    }) : null;
    metrics.semanticCompilationMs = deriveSemantic ? performance.now() - semanticCompilationStartedAt : 0;
    evidence.semanticPage = semanticPage;
    const serializedByteLength = jsonByteLength(evidence);
    const byteLength = serializedByteLength + lookupIndexBytes;
    let retained = byteLength <= this.maxEvidenceBytes;
    if (retained) {
      this.evidence.set(id, { evidence, byteLength, serializedByteLength, lookupIndexBytes, lookupIndex });
      this.evidenceBytes += byteLength;
      while (this.evidence.size > this.evidenceLimit || this.evidenceBytes > this.maxEvidenceBytes) {
        const oldestId = this.evidence.keys().next().value;
        const oldest = this.evidence.get(oldestId);
        this.evidence.delete(oldestId);
        this.evidenceBytes -= oldest.byteLength;
        this.#deleteResponseProjectionsForEvidence(oldestId);
        if (oldestId === id) retained = false;
      }
      this.peakRetainedEvidenceBytes = Math.max(this.peakRetainedEvidenceBytes, this.evidenceBytes);
    }
    const domNodeCount = (snapshot.documents ?? []).reduce((total, document) => total + (document.nodes?.nodeName?.length ?? 0), 0)
      + frameSnapshots.reduce((total, frame) => total + (frame.domSnapshot.documents ?? []).reduce((frameTotal, document) => frameTotal + (document.nodes?.nodeName?.length ?? 0), 0), 0);
    const accessibilityNodeCount = (ax.nodes ?? []).length + frameSnapshots.reduce((total, frame) => total + frame.accessibilityTree.length, 0);
    const memoryAfter = process.memoryUsage();
    const compact = {
      evidenceId: id,
      targetId: this.session.target.id,
      capturedAt: evidence.capturedAt,
      documentGeneration: evidence.documentGeneration,
      viewport: { ...evidence.viewport },
      deviceScaleFactor: evidence.deviceScaleFactor,
      observationProfile: profile,
      page: { ...pageState, url: sanitizeUrl(pageState.url ?? "") },
      frames: derived.frames,
      outOfProcessFrameGeometry: frameSnapshots.map(frame => frame.frameGeometry).filter(Boolean),
      headings: derived.headings,
      candidates: derived.candidates.map(({ evidence: _e, attributes: _attributes, documentUrl: _documentUrl, formBackendNodeId: _formBackendNodeId, recordContext: _recordContext, ...candidate }) => candidate),
      scrollTargets,
      candidateCount: derived.candidates.length,
      candidateCoverage,
      headingCoverage,
      semanticPage,
      retained,
      networkRequestCount: evidence.activity.totalRequests,
      networkSignals: this.#networkSignals(evidence.activity),
      lifecycleEventCount: evidence.activity.totalLifecycleEvents,
      domMutationCount: evidence.activity.totalDomMutations,
      coverage,
      captureMetrics: {
        captureDurationMs: Date.now() - captureStartedAt,
        cdpRoundTrips: metrics.cdpRoundTrips,
        totalCdpRoundTripMs: metrics.totalCdpRoundTripMs,
        cdpRoundTripP95Ms: percentile(metrics.cdpRoundTripDurations, 0.95),
        domSnapshotCount: metrics.domSnapshotCount,
        documentIndexBuildCount: metrics.documentIndexBuildCount ?? 0,
        documentIndexBuildMs: metrics.documentIndexBuildMs ?? 0,
        candidateDerivationMs: metrics.candidateDerivationMs ?? 0,
        semanticCompilationMs: metrics.semanticCompilationMs ?? 0,
        serializedEvidenceBytes: serializedByteLength,
        retainedLookupIndexBytes: retained ? lookupIndexBytes : 0,
        retainedEvidenceBytes: retained ? byteLength : 0,
        peakRetainedEvidenceBytes: this.peakRetainedEvidenceBytes,
        screenshotBase64Bytes: screenshot === null ? 0 : Buffer.byteLength(screenshot, "ascii"),
        domNodeCount,
        accessibilityNodeCount,
        outOfProcessFrames: frameSnapshots.length,
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        heapBeforeBytes: memoryBefore.heapUsed,
        heapAfterBytes: memoryAfter.heapUsed
      }
    };
    Object.defineProperty(compact, "pageChangeFingerprint", { value: pageChangeFingerprint });
    if (includeRawInResponse) compact.raw = this.getEvidence(id, { includeSensitiveFormValues: false });
    return compact;
  }

  #networkSignals(activity) {
    const signals = [];
    for (const request of activity.networkRequests) {
      if (!request.requestId) continue;
      const state = `${request.status ?? "pending"}:${request.failure?.errorText ?? ""}:${request.finishedAt ?? "pending"}`;
      const previous = this.networkSignalState.get(request.requestId);
      if (request.status === 429 && request.finishedAt !== null && request.finishedAt !== undefined && previous !== state) signals.push({
        kind: "http_rate_limit",
        status: 429,
        method: request.method,
        resourceType: request.resourceType,
        frameTargetId: request.frameTargetId,
        observedAt: new Date().toISOString()
      });
      this.networkSignalState.set(request.requestId, state);
    }
    while (this.networkSignalState.size > 1_000) this.networkSignalState.delete(this.networkSignalState.keys().next().value);
    return signals.slice(-32);
  }

  async inspectNetworkResponse(id, options = {}) {
    return inspectNetworkResponse(this, id, options, {
      getProjection: key => this.#getResponseProjection(key),
      storeProjection: (key, projection) => this.#storeResponseProjection(key, projection),
      pageProjection: pageResponseProjection
    });
  }

  #getResponseProjection(key) {
    const entry = this.responseProjectionCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.responseProjectionCache.delete(key);
      this.responseProjectionCacheBytes -= entry.weightBytes;
      return null;
    }
    this.responseProjectionCache.delete(key);
    this.responseProjectionCache.set(key, entry);
    return entry;
  }

  #deleteResponseProjectionsForEvidence(evidenceId) {
    for (const [key, entry] of this.responseProjectionCache) {
      if (entry.projection.evidenceId !== evidenceId) continue;
      this.responseProjectionCache.delete(key);
      this.responseProjectionCacheBytes -= entry.weightBytes;
    }
  }

  #storeResponseProjection(key, projection) {
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      analysis: projection.analysis,
      credentialDetails: projection.credentialDetails,
      sections: projection.markdownIndex?.sections,
      blocks: projection.markdownIndex?.blocks
    })) + (projection.byteOffsets.checkpoints.length * 32);
    const weightBytes = metadataBytes + (projection.selectedView.length * 2);
    if (weightBytes > NETWORK_RESPONSE_PROJECTION_CACHE_MAX_ENTRY_BYTES) return false;
    const prior = this.responseProjectionCache.get(key);
    if (prior) {
      this.responseProjectionCache.delete(key);
      this.responseProjectionCacheBytes -= prior.weightBytes;
    }
    const now = Date.now();
    const entry = { projection, weightBytes, expiresAt: now + NETWORK_RESPONSE_PROJECTION_CACHE_TTL_MS };
    this.responseProjectionCache.set(key, entry);
    this.responseProjectionCacheBytes += weightBytes;
    while (this.responseProjectionCache.size > NETWORK_RESPONSE_PROJECTION_CACHE_MAX_ENTRIES
      || this.responseProjectionCacheBytes > NETWORK_RESPONSE_PROJECTION_CACHE_MAX_BYTES) {
      const oldestKey = this.responseProjectionCache.keys().next().value;
      const oldest = this.responseProjectionCache.get(oldestKey);
      this.responseProjectionCache.delete(oldestKey);
      this.responseProjectionCacheBytes -= oldest.weightBytes;
    }
    return this.responseProjectionCache.has(key);
  }


  getEvidence(id, { includeSensitiveFormValues = false, includeSensitivePageText = false, includeSensitiveUrlData = false, includeSensitiveRuntimeValues = false, includeScreenshot = false, facets, backendNodeId, frameTargetId = null } = {}) {
    const stored = this.evidence.get(id)?.evidence;
    if (!stored) return { status: "expired", evidenceId: id };
    const selected = new Set(facets ?? ["page", "domSnapshot", "accessibilityTree", "frameTree"]);
    const availableFacets = new Set(["page", "domSnapshot", "accessibilityTree", "frameTree", "outOfProcessFrames", "scrollTargets", "selectedElement", "networkActivity", "lifecycleEvents", "domMutations", "runtimeState"]);
    for (const facet of selected) if (!availableFacets.has(facet)) throw new Error(`Unknown evidence facet: ${facet}`);
    const result = {
      status: "available",
      evidenceId: id,
      targetId: stored.targetId,
      capturedAt: stored.capturedAt,
      documentGeneration: stored.documentGeneration,
      viewport: structuredClone(stored.viewport ?? { width: 0, height: 0 }),
      observationProfile: stored.observationProfile ?? "interaction",
      coverage: structuredClone(stored.coverage ?? {})
    };
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
            url: request.url ? redactCredentialUrl(sanitizeUrl(request.url, { includeSensitiveUrlData }), { includeUserInfo: includeSensitiveUrlData }) : request.url,
            redirectedTo: request.redirectedTo ? redactCredentialUrl(sanitizeUrl(request.redirectedTo, { includeSensitiveUrlData }), { includeUserInfo: includeSensitiveUrlData }) : request.redirectedTo
          };
        });
        result.networkActivityCoverage = {
          total: stored.activity.totalRequests,
          dropped: stored.activity.droppedRequests,
          bodiesCaptured: false,
          responseBodyRetrieval: this.session.networkObservationAvailable ? "selected_on_demand" : "unavailable",
          maxSelectedBodyChunkBytes: MAX_NETWORK_RESPONSE_CHUNK_BYTES,
          headersCaptured: false
        };
      } else if (facet === "lifecycleEvents") {
        result.lifecycleEvents = stored.activity.lifecycleEvents.map(event => ({
          ...structuredClone(event),
          url: event.url ? redactCredentialUrl(sanitizeUrl(event.url, { includeSensitiveUrlData }), { includeUserInfo: includeSensitiveUrlData }) : event.url
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
