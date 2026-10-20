const MAX_ARIA_RELATION_IDS = 16;

export function evidenceRef(index, backendNodeId) {
  return Number.isInteger(index?.documentIndex) && Number.isInteger(backendNodeId)
    ? `${index.frameTargetId ?? "root"}:${index.documentIndex}:${backendNodeId}`
    : null;
}

function resolveAriaIdReferences(value, index) {
  const source = typeof value === "string" ? value.slice(0, 2_048) : "";
  const identifiers = source.trim().split(/\s+/u).filter(Boolean);
  if (!identifiers.length) return null;
  const evidenceRefs = [];
  let unresolvedCount = 0;
  for (const identifier of identifiers.slice(0, MAX_ARIA_RELATION_IDS)) {
    const matches = index.elementIndexesById?.get(identifier) ?? [];
    const nodeIndex = matches.length === 1 ? matches[0] : null;
    const reference = Number.isInteger(nodeIndex) ? evidenceRef(index, index.backendNodeIds[nodeIndex]) : null;
    if (reference) evidenceRefs.push(reference);
    else unresolvedCount++;
  }
  const truncated = identifiers.length > MAX_ARIA_RELATION_IDS || source.length >= 2_048;
  if (truncated) unresolvedCount += Math.max(0, identifiers.length - MAX_ARIA_RELATION_IDS) || 1;
  return Object.freeze({
    status: unresolvedCount ? evidenceRefs.length ? "partial" : "unknown" : "observed",
    evidenceRefs: Object.freeze(evidenceRefs),
    unresolvedCount,
    truncated
  });
}

export function controlLabelAssociation(nodeIndex, index, attributes) {
  if (Object.hasOwn(attributes, "aria-labelledby")) {
    const association = resolveAriaIdReferences(attributes["aria-labelledby"], index);
    if (association) return Object.freeze({ source: "aria_labelledby", ...association });
  }
  const id = attributes.id;
  const explicitLabels = typeof id === "string" && id ? index.labelIndexesByFor?.get(id) ?? [] : [];
  if (explicitLabels.length) {
    const refs = explicitLabels.slice(0, MAX_ARIA_RELATION_IDS)
      .map(labelIndex => evidenceRef(index, index.backendNodeIds[labelIndex])).filter(Boolean);
    return Object.freeze({
      source: "html_label_for",
      status: explicitLabels.length === 1 && refs.length === 1 ? "observed" : "unknown",
      evidenceRefs: Object.freeze(refs),
      unresolvedCount: Math.max(0, explicitLabels.length - refs.length),
      truncated: explicitLabels.length > MAX_ARIA_RELATION_IDS
    });
  }
  let parent = index.parents[nodeIndex];
  for (let depth = 0; depth < 64 && Number.isInteger(parent) && parent >= 0; depth++) {
    if (index.tags[parent] === "LABEL") {
      const reference = evidenceRef(index, index.backendNodeIds[parent]);
      return Object.freeze({
        source: "html_label_wrapping",
        status: reference ? "observed" : "unknown",
        evidenceRefs: Object.freeze(reference ? [reference] : []),
        unresolvedCount: reference ? 0 : 1,
        truncated: false
      });
    }
    parent = index.parents[parent];
  }
  return null;
}

export function controlAriaRelationships(attributes, index) {
  const relationships = {};
  if (Object.hasOwn(attributes, "aria-controls")) {
    relationships.controls = resolveAriaIdReferences(attributes["aria-controls"], index);
  }
  if (Object.hasOwn(attributes, "aria-owns")) {
    relationships.owns = resolveAriaIdReferences(attributes["aria-owns"], index);
  }
  return Object.keys(relationships).length ? Object.freeze(relationships) : null;
}

export function frameContextKey(frameTargetId, frameId) {
  return `${frameTargetId ?? "root"}\u0000${frameId}`;
}

export function sourceDocumentKey(frameTargetId, documentIndex) {
  return `${frameTargetId ?? "root"}\u0000${documentIndex}`;
}

export function isNodeWithin(index, nodeIndex, ancestorIndex) {
  let current = nodeIndex;
  for (let depth = 0; depth < 128 && Number.isInteger(current) && current >= 0; depth++) {
    if (current === ancestorIndex) return true;
    current = index.parents[current];
  }
  return false;
}

export function nearestRegion(nodeIndex, index, regionsByNode) {
  let current = nodeIndex;
  for (let depth = 0; depth < 24 && Number.isInteger(current) && current >= 0; depth++) {
    const ref = regionsByNode.get(current);
    if (ref) return ref;
    current = index.parents[current];
  }
  return null;
}
