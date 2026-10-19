function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function unpackAttributes(flat, strings) {
  const result = {};
  for (let index = 0; index + 1 < (flat?.length ?? 0); index += 2) {
    const name = stringAt(strings, flat[index]).toLowerCase();
    if (name) result[name] = stringAt(strings, flat[index + 1]);
  }
  return result;
}

/** Build transient DOMSnapshot indexes shared by observation and extraction. */
export function buildDocumentIndex(snapshot, { frameTargetId = null, parentFrameId = null } = {}) {
  const documents = [];
  const byBackendNodeId = new Map();
  const byFrameId = new Map();
  const sourceDocuments = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];

  for (let documentIndex = 0; documentIndex < sourceDocuments.length; documentIndex++) {
    const document = sourceDocuments[documentIndex];
    const nodes = document?.nodes;
    if (!nodes) {
      documents.push(null);
      continue;
    }
    const tags = (nodes.nodeName ?? []).map(index => stringAt(strings, index).toUpperCase());
    const attributes = (nodes.attributes ?? []).map(flat => unpackAttributes(flat, strings));
    const parents = nodes.parentIndex ?? [];
    const children = new Map();
    const backendNodeIndexes = new Map();
    const backendNodeIds = [];
    const formIndexesById = new Map();
    const elementIndexesById = new Map();
    const labelIndexesByFor = new Map();
    for (let nodeIndex = 0; nodeIndex < parents.length; nodeIndex++) {
      const parent = parents[nodeIndex];
      if (Number.isInteger(parent) && parent >= 0) {
        const siblings = children.get(parent) ?? [];
        siblings.push(nodeIndex);
        children.set(parent, siblings);
      }
      const backendNodeId = nodes.backendNodeId?.[nodeIndex];
      backendNodeIds[nodeIndex] = backendNodeId;
      if (Number.isInteger(backendNodeId)) backendNodeIndexes.set(backendNodeId, nodeIndex);
      const id = attributes[nodeIndex]?.id;
      if (typeof id === "string" && id) {
        const indexes = elementIndexesById.get(id) ?? [];
        indexes.push(nodeIndex);
        elementIndexesById.set(id, indexes);
      }
      const labelFor = attributes[nodeIndex]?.for;
      if (tags[nodeIndex] === "LABEL" && typeof labelFor === "string" && labelFor) {
        const indexes = labelIndexesByFor.get(labelFor) ?? [];
        indexes.push(nodeIndex);
        labelIndexesByFor.set(labelFor, indexes);
      }
      if (tags[nodeIndex] === "FORM" && typeof attributes[nodeIndex]?.id === "string" && attributes[nodeIndex].id) {
        formIndexesById.set(attributes[nodeIndex].id, nodeIndex);
      }
    }
    const visible = new Set();
    const layoutBoundsByNodeIndex = new Map();
    for (let layoutIndex = 0; layoutIndex < (document.layout?.nodeIndex?.length ?? 0); layoutIndex++) {
      const nodeIndex = document.layout.nodeIndex[layoutIndex];
      const bounds = document.layout.bounds?.[layoutIndex];
      if (Number.isInteger(nodeIndex) && Array.isArray(bounds) && bounds[2] > 0 && bounds[3] > 0) {
        visible.add(nodeIndex);
        if (bounds.length >= 4 && bounds.slice(0, 4).every(Number.isFinite)) {
          layoutBoundsByNodeIndex.set(nodeIndex, Object.freeze({ x: bounds[0], y: bounds[1], width: bounds[2], height: bounds[3] }));
        }
      }
    }
    const frameId = stringAt(strings, document.frameId) || String(document.frameId ?? "unknown");
    const indexed = {
      documentIndex,
      frameId,
      frameTargetId,
      parentFrameId,
      sourceDocument: document,
      tags,
      attributes,
      parents,
      children,
      formIndexesById,
      elementIndexesById,
      labelIndexesByFor,
      visible,
      layoutBoundsByNodeIndex,
      backendNodeIndexes,
      backendNodeIds,
      nodeValues: nodes.nodeValue ?? [],
      textValues: nodes.textValue ?? [],
      strings
    };
    documents.push(indexed);
    const frameDocuments = byFrameId.get(frameId) ?? [];
    frameDocuments.push(indexed);
    byFrameId.set(frameId, frameDocuments);
    for (const [backendNodeId, nodeIndex] of backendNodeIndexes) {
      const locators = byBackendNodeId.get(backendNodeId) ?? [];
      locators.push(Object.freeze({ documentIndex, frameId, frameTargetId, nodeIndex }));
      byBackendNodeId.set(backendNodeId, locators);
    }
  }

  return Object.freeze({
    snapshot,
    frameTargetId,
    parentFrameId,
    documents: Object.freeze(documents),
    byBackendNodeId,
    byFrameId
  });
}

/** Reuse an index only with the exact immutable snapshot from which it was built. */
export function documentIndexFor(snapshot, index = null, frameContext = undefined) {
  if (index !== null && index !== undefined) {
    if (index.snapshot !== snapshot || !Array.isArray(index.documents)) {
      throw new Error("A shared DOMSnapshot index must belong to the exact source snapshot.");
    }
    if (frameContext && (index.frameTargetId !== (frameContext.frameTargetId ?? null)
      || index.parentFrameId !== (frameContext.parentFrameId ?? null))) {
      throw new Error("A shared DOMSnapshot index must use the source frame identity.");
    }
    return index;
  }
  return buildDocumentIndex(snapshot, frameContext);
}

export function descendantNodeIndexes(root, index, limit = Number.MAX_SAFE_INTEGER) {
  const result = [];
  const stack = [...(index.children.get(root) ?? [])].reverse();
  while (stack.length && result.length < limit) {
    const current = stack.pop();
    result.push(current);
    const nested = index.children.get(current) ?? [];
    for (let child = nested.length - 1; child >= 0; child--) stack.push(nested[child]);
  }
  return result;
}
