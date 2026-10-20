import { sanitizeUrl } from "../browser/urlPrivacy.js";
import { documentIndexFor } from "./documentIndex.js";
import { rankInteractionCandidates } from "./semanticPageCompiler.js";

const ACTIONABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const CONTEXT_CONTAINERS = new Set(["SECTION", "ARTICLE", "NAV", "ASIDE", "MAIN", "FORM"]);

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function rectByNodeIndex(layout) {
  const rects = new Map();
  const indices = layout?.nodeIndex ?? [];
  const bounds = layout?.bounds ?? [];
  for (let index = 0; index < Math.min(indices.length, bounds.length); index++) {
    const [x, y, width, height] = bounds[index] ?? [];
    rects.set(indices[index], { x, y, width, height });
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
      byBackendId.set(node.backendDOMNodeId, {
        name: typeof name === "string" ? name.trim() : "",
        role: typeof role === "string" ? role : ""
      });
    }
  }
  return byBackendId;
}

/** Derive bounded action candidates from one exact snapshot and its shared index. */
export function buildCandidates(snapshot, axTree, rootFrameId, generation, targetId, {
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
      if (Number.isInteger(parent) && parent >= 0 && text[index]) {
        text[parent] = `${text[parent]} ${text[index]}`.trim().slice(0, 2_000);
      }
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
      const isActionable = ACTIONABLE_TAGS.has(tag)
        || ["button", "link", "menuitem", "option", "checkbox", "radio", "tab", "textbox", "combobox"].includes(role)
        || "tabindex" in attrs
        || attrs["contenteditable"] === "true";
      const backendNodeId = nodes.backendNodeId?.[index];
      if (!controlSupported || !Number.isInteger(backendNodeId)) continue;
      const accessible = axFacts.get(backendNodeId);
      const label = accessible?.name || attrs["aria-label"] || attrs.title || attrs.alt || text[index] || attrs.name || "";
      const rect = rects.get(index);
      const visible = rect ? rect.width > 0 && rect.height > 0 : null;
      const explicitType = String(attrs.type ?? "").toLowerCase();
      const submitsByDefault = tag === "BUTTON" && (!explicitType || explicitType === "submit")
        || tag === "INPUT" && ["submit", "image"].includes(explicitType);
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
      if (/^H[1-6]$/.test(tag) && text[index]) {
        headings.push({ level: Number(tag[1]), text: text[index].trim().slice(0, 300), frameId });
      }
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
