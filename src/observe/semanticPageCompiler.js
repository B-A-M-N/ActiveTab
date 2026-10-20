import { discoverVisibleRecordGroups } from "../extraction/recordGroupResolver.js";
import { discoverVisibleTableSources } from "../extraction/recordResolver.js";
import { descendantNodeIndexes, documentIndexFor } from "./documentIndex.js";
import { compileStructuredDataHints } from "./semantic/structuredData.js";
import { resolveFieldSemantics, semanticRoleFromText } from "./semanticFieldSemantics.js";
import { controlInteraction, controlKind } from "./semanticControlMechanics.js";
import { controlAriaRelationships, controlLabelAssociation, evidenceRef, frameContextKey, isNodeWithin, nearestRegion, sourceDocumentKey } from "./semanticDomRelationships.js";
export { rankInteractionCandidates } from "./semanticCandidateRanking.js";

const MAX_SEMANTIC_REGIONS = 96;
const MAX_SEMANTIC_COLLECTIONS = 48;
const MAX_SEMANTIC_CONTROLS = 200;
const MAX_EXPANDED_SEMANTIC_CONTROLS = 384;
const MAX_SEMANTIC_HEADINGS = 100;
const MAX_SEMANTIC_TABLE_RECORDS = 64;
const MAX_SEMANTIC_TABLE_FIELDS = 16;
const MAX_SEMANTIC_TABLE_FIELD_TEXT = 180;
const REGION_TAGS = new Map([
  ["MAIN", "main"], ["ARTICLE", "article"], ["SECTION", "section"],
  ["NAV", "navigation"], ["ASIDE", "complementary"], ["FORM", "form"],
  ["FIELDSET", "fieldset"], ["TABLE", "table"]
]);
const REGION_ROLES = new Set(["main", "navigation", "banner", "contentinfo", "complementary", "region", "search"]);

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function nodeText(nodeIndex, index, maxLength = 180) {
  const values = [];
  for (const current of [nodeIndex, ...descendantNodeIndexes(nodeIndex, index, 256)]) {
    if (index.tags[current] !== "#TEXT") continue;
    const value = stringAt(index.strings, index.textValues[current] ?? index.nodeValues[current]).replace(/\s+/gu, " ").trim();
    if (value) values.push(value);
    if (values.join(" ").length >= maxLength) break;
  }
  return values.join(" ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function regionKind(tag, attributes) {
  const role = String(attributes?.role ?? "").trim().toLowerCase();
  if (REGION_ROLES.has(role)) return role;
  return REGION_TAGS.get(tag) ?? null;
}

function labelForRegion(nodeIndex, index) {
  const attributes = index.attributes[nodeIndex] ?? {};
  if (attributes["aria-label"]?.trim()) return { value: attributes["aria-label"].trim().slice(0, 180), source: "aria_label", status: "observed" };
  if (attributes.title?.trim()) return { value: attributes.title.trim().slice(0, 180), source: "title", status: "observed" };
  const heading = descendantNodeIndexes(nodeIndex, index, 256).find(child => /^H[1-6]$/.test(index.tags[child]));
  if (heading !== undefined) {
    const value = nodeText(heading, index);
    if (value) return { value, source: "descendant_heading", status: "inferred" };
  }
  return { value: null, source: null, status: "unknown" };
}

function classifyPageType({ regions, forms, collections, headings }) {
  const sections = regions.filter(region => region.kind === "section").length;
  if (sections >= 3 && headings.length >= 4) return Object.freeze({ value: "article", status: "inferred" });
  const repeated = collections.find(collection => collection.kind === "repeated_dom_structure" || collection.kind.startsWith("microdata_"));
  if (repeated) return Object.freeze({ value: "repeated_content", status: "inferred" });
  const article = regions.find(region => region.kind === "article");
  if (article) return Object.freeze({ value: "article", status: "observed" });
  const table = collections.find(collection => collection.kind === "html_table");
  if (table) return Object.freeze({ value: "tabular_data", status: "observed" });
  if (forms.length) return Object.freeze({ value: "form", status: "observed" });
  const navigation = regions.find(region => region.kind === "navigation");
  if (navigation) return Object.freeze({ value: "navigation", status: "observed" });
  return Object.freeze({ value: "unknown", status: "unknown" });
}

function classHasToken(attributes, token) {
  return typeof attributes?.class === "string" && attributes.class.split(/[\t\n\f\r ]+/u).includes(token);
}

function fieldSemantics(nodeIndex, index, source = null) {
  return resolveFieldSemantics(nodeIndex, index, source, nodeText);
}

function microdataType(attributes) {
  if (!Object.hasOwn(attributes ?? {}, "itemscope")) return null;
  const itemtypes = String(attributes?.itemtype ?? "").trim().split(/\s+/u).filter(Boolean);
  if (itemtypes.length !== 1) return null;
  try {
    const url = new URL(itemtypes[0]);
    const typeName = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    if (!(["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(typeName))) return null;
    return { itemtype: url.href, typeName };
  } catch { return null; }
}

function visibleMicrodataGroups(index) {
  if (!index || !Array.isArray(index.tags)) return [];
  const groups = new Map();
  for (let nodeIndex = 0; nodeIndex < index.tags.length; nodeIndex++) {
    if (!index.visible.has(nodeIndex)) continue;
    const type = microdataType(index.attributes[nodeIndex]);
    if (!type) continue;
    const parent = index.parents[nodeIndex];
    if (!Number.isInteger(parent) || parent < 0) continue;
    const key = `${parent}\u0000${type.itemtype}`;
    const group = groups.get(key) ?? { parent, ...type, items: [] };
    group.items.push(nodeIndex);
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.items.length >= 2);
}

function visibleMicrodataProperties(itemNode, index) {
  if (!index || !Array.isArray(index.tags)) return new Map();
  const properties = new Map();
  const stack = [itemNode];
  while (stack.length) {
    const nodeIndex = stack.pop();
    if (nodeIndex !== itemNode && Object.hasOwn(index.attributes[nodeIndex] ?? {}, "itemscope")) continue;
    const attributes = index.attributes[nodeIndex] ?? {};
    const names = String(attributes.itemprop ?? "").trim().split(/\s+/u).filter(name => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name));
    if (names.length && index.visible.has(nodeIndex)) {
      for (const name of names) {
        const matches = properties.get(name) ?? [];
        matches.push(nodeIndex);
        properties.set(name, matches);
      }
    }
    const children = index.children.get(nodeIndex) ?? [];
    for (let child = children.length - 1; child >= 0; child--) stack.push(children[child]);
  }
  return properties;
}

function visibleMicrodataValue(nodeIndex, index) {
  return nodeText(nodeIndex, index, MAX_SEMANTIC_TABLE_FIELD_TEXT + 1);
}

function repeatedFieldNode(itemNode, index, source, descendants = null) {
  const nodes = descendants ?? [itemNode, ...descendantNodeIndexes(itemNode, index)];
  const matches = nodes.filter(node => index.visible.has(node)
    && index.tags[node] === source.sourceTagName && classHasToken(index.attributes[node], source.sourceKey));
  return matches.length === 1 ? matches[0] : null;
}

function commonRepeatedFieldSemantics(items, index, sources) {
  const result = [];
  for (const source of sources.slice(0, MAX_SEMANTIC_TABLE_FIELDS)) {
    const observed = items.map(itemNode => {
      const node = repeatedFieldNode(itemNode, index, source);
      return fieldSemantics(node, index, source);
    });
    const roles = new Set(observed.map(item => item.semanticRole));
    const semanticRole = roles.size === 1 ? observed[0]?.semanticRole ?? null : null;
    const roleStatuses = new Set(observed.map(item => item.semanticRoleStatus));
    const semanticRoleStatus = semanticRole && roleStatuses.size === 1 ? observed[0].semanticRoleStatus : "unknown";
    const labels = new Set(observed.map(item => JSON.stringify(item.label)));
    const label = labels.size === 1 ? observed[0]?.label : Object.freeze({ value: null, status: "unknown", source: null });
    result.push(Object.freeze({ semanticRole, semanticRoleStatus, label }));
  }
  return result;
}

function structuralCollectionMembers(index, selector) {
  const members = new Set();
  for (const group of structuralCollectionGroups(index, selector)) for (const item of group.items) members.add(item);
  return members;
}

function structuralCollectionGroups(index, selector) {
  const groups = [];
  for (let parent = 0; parent < index.tags.length; parent++) {
    if (!index.visible.has(parent) || index.tags[parent] !== selector.containerTagName
      || !classHasToken(index.attributes[parent], selector.containerClassToken)) continue;
    const items = (index.children.get(parent) ?? []).filter(item => index.visible.has(item) && index.tags[item] === selector.itemTagName
      && classHasToken(index.attributes[item], selector.itemClassToken));
    if (items.length) groups.push({ parent, items });
  }
  return groups;
}

function repeatedRecordFields(itemNode, index, sources, commonSemantics = []) {
  const descendants = [itemNode, ...descendantNodeIndexes(itemNode, index)];
  return sources.slice(0, MAX_SEMANTIC_TABLE_FIELDS).map((source, fieldIndex) => {
    const fieldNode = repeatedFieldNode(itemNode, index, source, descendants);
    const text = fieldNode === null ? "" : nodeText(fieldNode, index, MAX_SEMANTIC_TABLE_FIELD_TEXT + 1);
    const backendNodeId = fieldNode === null ? null : index.backendNodeIds[fieldNode];
    const semantics = commonSemantics[fieldIndex] ?? fieldSemantics(fieldNode, index, source);
    const valueRef = evidenceRef(index, backendNodeId);
    return Object.freeze({
      name: `field_${fieldIndex + 1}`,
      semanticRole: semantics.semanticRole,
      semanticRoleStatus: semantics.semanticRoleStatus,
      label: semantics.label,
      value: text.slice(0, MAX_SEMANTIC_TABLE_FIELD_TEXT),
      status: text ? "observed" : "unknown",
      evidenceRef: valueRef,
      valueRef,
      truncated: text.length > MAX_SEMANTIC_TABLE_FIELD_TEXT
    });
  });
}

function boundedRecordGroupSource(recordGroup) {
  if (!recordGroup || typeof recordGroup !== "object") return null;
  const validToken = (value, maxLength) => typeof value === "string" && value.length > 0
    && value.length <= maxLength && /^[A-Za-z0-9_.-]+$/u.test(value);
  if (!validToken(recordGroup.containerTagName, 16) || !validToken(recordGroup.itemTagName, 16)
    || !validToken(recordGroup.containerClassToken, 128) || !validToken(recordGroup.itemClassToken, 128)) return null;
  return Object.freeze({
    containerTagName: recordGroup.containerTagName,
    containerClassToken: recordGroup.containerClassToken,
    itemTagName: recordGroup.itemTagName,
    itemClassToken: recordGroup.itemClassToken
  });
}

/** Compile fresh DOM and accessibility evidence into a bounded structural page model. */
export function compileSemanticPageModel({
  observationId,
  targetId,
  documentGeneration,
  page,
  domSnapshot,
  frameSnapshots = [],
  documentIndex = null,
  frameDocumentIndexes = [],
  candidates = [],
  controlLimit = MAX_SEMANTIC_CONTROLS,
  headings = [],
  candidateCoverage = null,
  headingCount = headings.length,
  coverage = {}
} = {}) {
  if (typeof observationId !== "string" || !observationId || typeof targetId !== "string" || !targetId
    || !Number.isInteger(documentGeneration) || !page || typeof page !== "object"
    || !Number.isInteger(controlLimit) || controlLimit < MAX_SEMANTIC_CONTROLS || controlLimit > MAX_EXPANDED_SEMANTIC_CONTROLS) {
    throw new Error("Semantic page compilation requires a bound observation, target, generation, and page.");
  }
  const snapshot = domSnapshot && typeof domSnapshot === "object" ? domSnapshot : { strings: [], documents: [] };
  if (!Array.isArray(frameSnapshots) || frameSnapshots.length > 64
    || !Array.isArray(frameDocumentIndexes) || frameDocumentIndexes.length > frameSnapshots.length
    || (frameDocumentIndexes.length > 0 && frameDocumentIndexes.length !== frameSnapshots.length)) {
    throw new Error("Semantic page compilation requires a bounded array of captured frame snapshots.");
  }
  const frameSources = frameSnapshots.map((frame, frameIndex) => {
    if (!frame || typeof frame !== "object" || typeof frame.frameId !== "string"
      || typeof frame.targetId !== "string" || (frame.parentFrameId !== null && typeof frame.parentFrameId !== "string")
      || !frame.domSnapshot || typeof frame.domSnapshot !== "object") {
      throw new Error("Semantic frame snapshots require captured frame and target identity.");
    }
    return {
      snapshot: frame.domSnapshot,
      frameTargetId: frame.targetId,
      parentFrameId: frame.parentFrameId,
      suppliedIndex: frameDocumentIndexes[frameIndex] ?? null
    };
  });
  const sources = [
    { snapshot, frameTargetId: null, parentFrameId: null, suppliedIndex: documentIndex },
    ...frameSources
  ].map(source => {
    const { suppliedIndex, ...identity } = source;
    return { ...identity, index: documentIndexFor(source.snapshot, suppliedIndex, identity) };
  });
  const indexes = sources.flatMap(source => source.index.documents.filter(Boolean));
  const indexByFrame = new Map(indexes.map(index => [frameContextKey(index.frameTargetId, index.frameId), index]));
  const indexByDocument = new Map(indexes.map(index => [sourceDocumentKey(index.frameTargetId, index.documentIndex), index]));
  const regions = [];
  const regionsByNodeByFrame = new Map();
  for (const index of indexes) {
    if (regions.length >= MAX_SEMANTIC_REGIONS) break;
    const byNode = new Map();
    for (let nodeIndex = 0; nodeIndex < index.tags.length; nodeIndex++) {
      if (!index.visible.has(nodeIndex)) continue;
      const tag = index.tags[nodeIndex];
      const kind = regionKind(tag, index.attributes[nodeIndex]);
      if (!kind) continue;
      const backendNodeId = index.backendNodeIds[nodeIndex];
      if (!Number.isInteger(backendNodeId)) continue;
      const label = labelForRegion(nodeIndex, index);
      const ref = `region_${regions.length + 1}`;
      const region = Object.freeze({
        ref,
        kind,
        tag: tag.toLowerCase(),
        label,
        frameId: index.frameId,
        frameTargetId: index.frameTargetId,
        parentFrameId: index.parentFrameId,
        evidenceRef: evidenceRef(index, backendNodeId),
        controlRefs: []
      });
      regions.push(region);
      byNode.set(nodeIndex, ref);
      if (regions.length >= MAX_SEMANTIC_REGIONS) break;
    }
    regionsByNodeByFrame.set(frameContextKey(index.frameTargetId, index.frameId), byNode);
  }

  const collections = [];
  // Each member root represents its exact DOM subtree. Membership is resolved
  // by walking the candidate's fresh parent chain, so nested tables select the
  // nearest table without materializing overlapping descendant sets.
  const collectionNodeMembers = new Map();
  const tableRootsByIndex = new Map();
  const tableRecordsByIndex = new Map();
  const repeatedRecordRootsByIndex = new Map();
  const structuredRecordRootsByIndex = new Map();
  let remainingTableRecords = MAX_SEMANTIC_TABLE_RECORDS;
  const tableSources = [];
  for (const source of sources) {
    if (remainingTableRecords <= 0) break;
    const tables = discoverVisibleTableSources(source.snapshot, { maxRecords: remainingTableRecords, index: source.index });
    for (const table of tables) {
      tableSources.push(table);
      remainingTableRecords = Math.max(0, remainingTableRecords - table.rows.length);
    }
  }
  remainingTableRecords = MAX_SEMANTIC_TABLE_RECORDS;
  for (const table of tableSources.slice(0, MAX_SEMANTIC_COLLECTIONS)) {
    const index = indexByDocument.get(sourceDocumentKey(table.frameTargetId, table.documentIndex));
    if (!index || !Number.isInteger(table.nodeIndex) || !Number.isInteger(table.backendNodeId)) continue;
    const ref = `collection_${collections.length + 1}`;
    const fields = table.headers.slice(0, MAX_SEMANTIC_TABLE_FIELDS).map((name, fieldIndex) => {
      const label = String(name).slice(0, 120);
      const semanticRole = semanticRoleFromText(label);
      return Object.freeze({
        name: label,
        semanticRole,
        semanticRoleStatus: semanticRole ? "inferred" : "unknown",
        label: Object.freeze({ value: label, status: "observed", source: "table_header" }),
        status: "observed",
        ordinal: fieldIndex + 1,
        evidenceRef: evidenceRef(index, table.headerCells[fieldIndex]?.backendNodeId)
      });
    });
    const rows = table.rows.slice(0, remainingTableRecords);
    remainingTableRecords -= rows.length;
    const items = rows.map((row, rowIndex) => {
      const itemRef = `record_${collections.length + 1}_${rowIndex + 1}`;
      const rowEvidenceRef = evidenceRef(index, row.backendNodeId);
      return {
        ref: itemRef,
        ordinal: rowIndex + 1,
        evidenceRef: rowEvidenceRef,
        fields: fields.map((field, fieldIndex) => {
          const cell = row.cells[fieldIndex];
          const valueRef = evidenceRef(index, cell?.backendNodeId);
          return {
            name: field.name,
            semanticRole: field.semanticRole,
            semanticRoleStatus: field.semanticRoleStatus,
            label: field.label,
            value: typeof cell?.value === "string" ? cell.value.slice(0, MAX_SEMANTIC_TABLE_FIELD_TEXT) : "",
            status: cell && Number.isInteger(cell.backendNodeId) ? "observed" : "unknown",
            evidenceRef: valueRef,
            valueRef,
            truncated: typeof cell?.value === "string" && cell.value.length > MAX_SEMANTIC_TABLE_FIELD_TEXT
          };
        }),
        controlRefs: []
      };
    });
    collections.push({
      ref,
      kind: "html_table",
      status: "observed",
      frameId: index.frameId,
      frameTargetId: index.frameTargetId,
      parentFrameId: index.parentFrameId,
      visibleCount: table.visibleRowCount,
      visibleCountStatus: "observed",
      totalCount: null,
      completeness: "unknown",
      evidenceRef: evidenceRef(index, table.backendNodeId),
      fields,
      fieldsTruncated: table.headers.length > fields.length,
      items,
      itemsTruncated: items.length < table.visibleRowCount
    });
    collectionNodeMembers.set(ref, { index, roots: new Set([table.nodeIndex]), kind: "html_table" });
    const roots = tableRootsByIndex.get(index) ?? new Map();
    roots.set(table.nodeIndex, ref);
    tableRootsByIndex.set(index, roots);
    const rowRoots = tableRecordsByIndex.get(index) ?? new Map();
    for (const [rowIndex, item] of rows.entries()) {
      if (Number.isInteger(item.nodeIndex) && item.nodeIndex >= 0 && items[rowIndex]?.evidenceRef) {
        rowRoots.set(item.nodeIndex, { collectionRef: ref, recordRef: items[rowIndex].ref });
      }
    }
    tableRecordsByIndex.set(index, rowRoots);
  }
  const groups = sources.flatMap(source => discoverVisibleRecordGroups(source.snapshot, { index: source.index })
    .map(group => ({ ...group, sourceFrameTargetId: source.frameTargetId })));
  for (const group of groups.slice(0, Math.max(0, MAX_SEMANTIC_COLLECTIONS - collections.length))) {
    const ref = `collection_${collections.length + 1}`;
    const index = indexByDocument.get(sourceDocumentKey(group.sourceFrameTargetId, group.documentIndex));
    const matchedGroups = index ? structuralCollectionGroups(index, group.recordGroup) : [];
    const recordRoots = new Map();
    const uniqueGroupItems = matchedGroups.length === 1 ? matchedGroups[0].items : [];
    const sharedFieldSemantics = index && uniqueGroupItems.length
      ? commonRepeatedFieldSemantics(uniqueGroupItems, index, group.fields)
      : group.fields.slice(0, MAX_SEMANTIC_TABLE_FIELDS).map(() => fieldSemantics(null, null));
    const items = uniqueGroupItems.slice(0, MAX_SEMANTIC_TABLE_RECORDS).map((itemNode, rowIndex) => {
      const itemRef = `record_${collections.length + 1}_${rowIndex + 1}`;
      const backendNodeId = index.backendNodeIds[itemNode];
      const item = {
        ref: itemRef,
        ordinal: rowIndex + 1,
        evidenceRef: evidenceRef(index, backendNodeId),
        fields: repeatedRecordFields(itemNode, index, group.fields, sharedFieldSemantics),
        controlRefs: []
      };
      if (Number.isInteger(backendNodeId) && item.evidenceRef) recordRoots.set(itemNode, { collectionRef: ref, recordRef: itemRef });
      return item;
    });
    const repeatedRecords = repeatedRecordRootsByIndex.get(index) ?? new Map();
    for (const [nodeIndex, binding] of recordRoots) repeatedRecords.set(nodeIndex, binding);
    if (index) repeatedRecordRootsByIndex.set(index, repeatedRecords);
    collections.push(Object.freeze({
      ref,
      kind: "repeated_dom_structure",
      status: "inferred",
      frameId: index?.frameId ?? group.frameId ?? null,
      frameTargetId: group.sourceFrameTargetId,
      parentFrameId: index?.parentFrameId ?? group.parentFrameId ?? null,
      documentIndex: group.documentIndex,
      visibleCount: group.visibleRecordCount,
      visibleCountStatus: "observed",
      totalCount: null,
      completeness: "unknown",
      recordBindingStatus: matchedGroups.length === 1 ? "unique" : "ambiguous",
      sourceGroup: boundedRecordGroupSource(group.recordGroup),
      fields: group.fields.slice(0, MAX_SEMANTIC_TABLE_FIELDS).map((field, fieldIndex) => Object.freeze({
        name: `field_${fieldIndex + 1}`,
        sourceKey: field.sourceKey,
        sourceTag: String(field.sourceTagName).toLowerCase(),
        semanticRole: sharedFieldSemantics[fieldIndex]?.semanticRole ?? null,
        semanticRoleStatus: sharedFieldSemantics[fieldIndex]?.semanticRoleStatus ?? "unknown",
        label: sharedFieldSemantics[fieldIndex]?.label ?? Object.freeze({ value: null, status: "unknown", source: null }),
        status: sharedFieldSemantics[fieldIndex]?.semanticRole ? "inferred" : "unknown",
        ordinal: fieldIndex + 1
      })),
      fieldsTruncated: group.fields.length > MAX_SEMANTIC_TABLE_FIELDS,
      items: Object.freeze(items),
      itemsTruncated: matchedGroups.length === 1 && items.length < uniqueGroupItems.length
    }));
    if (index) collectionNodeMembers.set(ref, { index, roots: new Set(matchedGroups.flatMap(itemGroup => itemGroup.items)), kind: "repeated_dom_structure" });
  }

  const semanticDocumentIndexes = sources.flatMap(source => source.index.documents.filter(Boolean));
  for (const index of semanticDocumentIndexes) {
    for (const group of visibleMicrodataGroups(index).slice(0, Math.max(0, MAX_SEMANTIC_COLLECTIONS - collections.length))) {
      const ref = `collection_${collections.length + 1}`;
      const propertyMaps = group.items.map(itemNode => visibleMicrodataProperties(itemNode, index));
      const propertyNames = [...new Set(propertyMaps.flatMap(properties => [...properties.keys()]))];
      const boundedPropertyNames = propertyNames.slice(0, MAX_SEMANTIC_TABLE_FIELDS);
      const items = group.items.slice(0, MAX_SEMANTIC_TABLE_RECORDS).map((itemNode, rowIndex) => {
        const itemRef = `record_${collections.length + 1}_${rowIndex + 1}`;
        const properties = propertyMaps[rowIndex];
        const fields = boundedPropertyNames.map(name => {
          const nodes = properties.get(name) ?? [];
          const nodeIndex = nodes.length === 1 ? nodes[0] : null;
          const value = nodeIndex === null ? "" : visibleMicrodataValue(nodeIndex, index);
          const semanticRole = semanticRoleFromText(name);
          const valueRef = evidenceRef(index, nodeIndex === null ? null : index.backendNodeIds[nodeIndex]);
          return Object.freeze({
            name,
            semanticRole,
            semanticRoleStatus: semanticRole ? "observed" : "unknown",
            label: Object.freeze({ value: name, status: "observed", source: "microdata_itemprop" }),
            value: value.slice(0, MAX_SEMANTIC_TABLE_FIELD_TEXT),
            status: nodeIndex !== null && value ? "observed" : "unknown",
            evidenceRef: valueRef,
            valueRef,
            truncated: value.length > MAX_SEMANTIC_TABLE_FIELD_TEXT
          });
        });
        return {
          ref: itemRef,
          ordinal: rowIndex + 1,
          evidenceRef: evidenceRef(index, index.backendNodeIds[itemNode]),
          fields,
          controlRefs: []
        };
      });
      const fields = boundedPropertyNames.map((name, fieldIndex) => {
        const semanticRole = semanticRoleFromText(name);
        const nodes = propertyMaps.map(properties => properties.get(name) ?? []);
        const evidenceNode = nodes.find(matches => matches.length === 1)?.[0];
        return Object.freeze({
          name,
          semanticRole,
          semanticRoleStatus: semanticRole ? "observed" : "unknown",
          label: Object.freeze({ value: name, status: "observed", source: "microdata_itemprop" }),
          status: nodes.every(matches => matches.length === 1) ? "observed" : "unknown",
          ordinal: fieldIndex + 1,
          evidenceRef: evidenceRef(index, evidenceNode === undefined ? null : index.backendNodeIds[evidenceNode])
        });
      });
      const typeName = group.typeName.toLowerCase().replace(/[^a-z0-9_-]/gu, "_").slice(0, 32);
      collections.push({
        ref,
        kind: `microdata_${typeName}`,
        status: "observed",
        frameId: index.frameId,
        frameTargetId: index.frameTargetId,
        parentFrameId: index.parentFrameId,
        visibleCount: group.items.length,
        visibleCountStatus: "observed",
        totalCount: null,
        completeness: "unknown",
        recordBindingStatus: "unique",
        evidenceRef: evidenceRef(index, index.backendNodeIds[group.parent])
          ?? evidenceRef(index, index.backendNodeIds[group.items[0]]),
        fields,
        fieldsTruncated: propertyNames.length > boundedPropertyNames.length,
        items,
        itemsTruncated: group.items.length > items.length
      });
      const roots = new Set(group.items);
      collectionNodeMembers.set(ref, { index, roots, kind: "microdata" });
      const records = structuredRecordRootsByIndex.get(index) ?? new Map();
      for (const [rowIndex, itemNode] of group.items.slice(0, items.length).entries()) {
        if (Number.isInteger(index.backendNodeIds[itemNode]) && items[rowIndex]?.evidenceRef) {
          records.set(itemNode, { collectionRef: ref, recordRef: items[rowIndex].ref });
        }
      }
      structuredRecordRootsByIndex.set(index, records);
    }
  }

  // If every class-derived record contains exactly one record from the same
  // explicit microdata collection, keep the stronger typed grouping once.
  const structuredCollections = collections.filter(collection => collection.kind.startsWith("microdata_"));
  for (const collection of [...collections]) {
    if (collection.kind !== "repeated_dom_structure") continue;
    const members = collectionNodeMembers.get(collection.ref);
    if (!members) continue;
    const recordRoots = [...members.roots];
    const duplicate = structuredCollections.some(structured => {
      const structuredMembers = collectionNodeMembers.get(structured.ref);
      if (!structuredMembers || structuredMembers.index !== members.index
        || structuredMembers.roots.size !== recordRoots.length) return false;
      const structuredRoots = [...structuredMembers.roots];
      return recordRoots.every(recordRoot => structuredRoots.filter(structuredRoot =>
        isNodeWithin(members.index, structuredRoot, recordRoot)).length === 1)
        && structuredRoots.every(structuredRoot => recordRoots.filter(recordRoot =>
          isNodeWithin(members.index, structuredRoot, recordRoot)).length === 1);
    });
    if (!duplicate) continue;
    collections.splice(collections.indexOf(collection), 1);
    collectionNodeMembers.delete(collection.ref);
    const records = repeatedRecordRootsByIndex.get(members.index);
    if (records) {
      for (const [nodeIndex, binding] of records) {
        if (binding.collectionRef === collection.ref) records.delete(nodeIndex);
      }
    }
  }

  // Build observation-local association maps once. Control compilation can
  // involve hundreds of controls and must not scan every collection/record
  // for each one. These maps never escape this immutable compilation.
  const collectionByRef = new Map(collections.map(collection => [collection.ref, collection]));
  const recordByRef = new Map();
  const repeatedRootByDocument = new Map();
  for (const collection of collections) {
    for (const record of collection.items ?? []) recordByRef.set(`${collection.ref}\u0000${record.ref}`, record);
    if (collection.kind !== "repeated_dom_structure") continue;
    const members = collectionNodeMembers.get(collection.ref);
    if (!members) continue;
    const documentKey = sourceDocumentKey(members.index.frameTargetId, members.index.documentIndex);
    const roots = repeatedRootByDocument.get(documentKey) ?? new Map();
    for (const root of members.roots) roots.set(root, collection.ref);
    repeatedRootByDocument.set(documentKey, roots);
  }

  const collectionForNode = (index, nodeIndex) => {
    const tableRoots = tableRootsByIndex.get(index);
    let current = nodeIndex;
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const tableRef = tableRoots?.get(current);
      if (tableRef) return tableRef;
      current = index.parents[current];
    }
    current = nodeIndex;
    const structuredRoots = structuredRecordRootsByIndex.get(index);
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const record = structuredRoots?.get(current);
      if (record) return record.collectionRef;
      current = index.parents[current];
    }
    current = nodeIndex;
    const repeatedRoots = repeatedRootByDocument.get(sourceDocumentKey(index.frameTargetId, index.documentIndex));
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const repeatedRef = repeatedRoots?.get(current);
      if (repeatedRef) return repeatedRef;
      current = index.parents[current];
    }
    return null;
  };

  const recordForNode = (index, nodeIndex, collectionRef) => {
    if (!collectionRef) return null;
    const rowRoots = tableRecordsByIndex.get(index);
    let current = nodeIndex;
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const record = rowRoots?.get(current);
      if (record?.collectionRef === collectionRef) return record.recordRef;
      current = index.parents[current];
    }
    current = nodeIndex;
    const structuredRoots = structuredRecordRootsByIndex.get(index);
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const record = structuredRoots?.get(current);
      if (record?.collectionRef === collectionRef) return record.recordRef;
      current = index.parents[current];
    }
    current = nodeIndex;
    const repeatedRoots = repeatedRecordRootsByIndex.get(index);
    for (let depth = 0; depth < 64 && Number.isInteger(current) && current >= 0; depth++) {
      const record = repeatedRoots?.get(current);
      if (record?.collectionRef === collectionRef) return record.recordRef;
      current = index.parents[current];
    }
    return null;
  };

  const formMap = new Map();
  const controls = [];
  const regionControls = new Map();
  for (const candidate of candidates.slice(0, controlLimit)) {
    if (!candidate || typeof candidate.identity !== "string") continue;
    const index = indexByFrame.get(frameContextKey(candidate.frameTargetId ?? null, String(candidate.frameId ?? "")));
    const nodeIndex = Number.isInteger(candidate.backendNodeId) ? index?.backendNodeIndexes.get(candidate.backendNodeId) : undefined;
    const regionRef = Number.isInteger(nodeIndex) ? nearestRegion(nodeIndex, index, regionsByNodeByFrame.get(frameContextKey(index.frameTargetId, index.frameId)) ?? new Map()) : null;
    const collectionRef = Number.isInteger(nodeIndex) ? collectionForNode(index, nodeIndex) : null;
    const recordRef = Number.isInteger(nodeIndex) ? recordForNode(index, nodeIndex, collectionRef) : null;
    const formRef = typeof candidate.formIdentity === "string" ? candidate.formIdentity : null;
    const attributes = Number.isInteger(nodeIndex) ? index.attributes[nodeIndex] : {};
    const labelAssociation = Number.isInteger(nodeIndex) ? controlLabelAssociation(nodeIndex, index, attributes) : null;
    const ariaRelationships = Number.isInteger(nodeIndex) ? controlAriaRelationships(attributes, index) : null;
    const labelValue = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 300) : null;
    const control = Object.freeze({
      targetRef: candidate.identity,
      frameId: index?.frameId ?? candidate.frameId ?? null,
      frameTargetId: index?.frameTargetId ?? candidate.frameTargetId ?? null,
      parentFrameId: index?.parentFrameId ?? candidate.parentFrameId ?? null,
      identityEvidence: "fresh_dom_accessibility_candidate",
      classification: { value: controlKind(candidate), status: controlKind(candidate) === "unknown" ? "unknown" : "observed" },
      label: { value: labelValue, status: labelValue ? "observed" : "unknown", source: labelValue ? "dom_accessibility_name" : null },
      ...(labelAssociation ? { labelAssociation } : {}),
      ...(ariaRelationships ? { ariaRelationships } : {}),
      role: String(candidate.role ?? "unknown").slice(0, 64),
      tag: String(candidate.tag ?? "unknown").slice(0, 32),
      type: typeof candidate.type === "string" ? candidate.type.slice(0, 32) : null,
      regionRef,
      formRef,
      collectionRef,
      recordRef,
      contextLabel: typeof candidate.contextName === "string" && candidate.contextName ? { value: candidate.contextName.slice(0, 180), status: "inferred", source: "nearby_heading_or_named_container" } : null,
      interaction: controlInteraction(candidate, attributes, page.url),
      visible: candidate.visible === true,
      disabled: candidate.disabled === true,
      operationMeaning: { value: null, status: "unknown" },
      effect: "unknown"
    });
    controls.push(control);
    if (recordRef && collectionByRef.has(collectionRef)) {
      const record = recordByRef.get(`${collectionRef}\u0000${recordRef}`);
      record?.controlRefs.push(candidate.identity);
    }
    if (regionRef) {
      const refs = regionControls.get(regionRef) ?? [];
      refs.push(candidate.identity);
      regionControls.set(regionRef, refs);
    }
    if (formRef) {
      const current = formMap.get(formRef) ?? {
        ref: formRef,
        method: candidate.formMethod ?? null,
        actionOrigin: candidate.formActionOrigin ?? null,
        evidenceRef: Number.isInteger(candidate.formBackendNodeId) ? evidenceRef(index, candidate.formBackendNodeId) : null,
        frameId: index?.frameId ?? candidate.frameId ?? null,
        frameTargetId: index?.frameTargetId ?? candidate.frameTargetId ?? null,
        controlRefs: [],
        submitControlRefs: []
      };
      current.controlRefs.push(candidate.identity);
      if (candidate.submitsForm === true) current.submitControlRefs.push(candidate.identity);
      formMap.set(formRef, current);
    }
  }

  const normalizedRegions = regions.map(region => Object.freeze({
    ...region,
    controlRefs: Object.freeze((regionControls.get(region.ref) ?? []).slice(0, controlLimit))
  }));
  const normalizedForms = [...formMap.values()].slice(0, 32).map(form => Object.freeze({
    ref: form.ref,
    method: form.method,
    actionOrigin: form.actionOrigin,
    evidenceRef: form.evidenceRef,
    frameId: form.frameId,
    frameTargetId: form.frameTargetId,
    controlRefs: Object.freeze(form.controlRefs.slice(0, controlLimit)),
    submitControlRefs: Object.freeze(form.submitControlRefs.slice(0, 32)),
    effect: "unknown"
  }));
  const normalizedCollections = collections.map(collection => Object.freeze({
    ...collection,
    fields: Object.freeze(collection.fields.map(field => Object.freeze({ ...field }))),
    ...(Array.isArray(collection.items) ? {
      items: Object.freeze(collection.items.map(item => Object.freeze({
        ...item,
        fields: Object.freeze(item.fields.map(field => Object.freeze({ ...field }))),
        controlRefs: Object.freeze(item.controlRefs.slice(0, controlLimit))
      })))
    } : {})
  }));
  const compiledHeadings = headings.length ? headings : indexes.flatMap(index => {
    const values = [];
    for (let nodeIndex = 0; nodeIndex < index.tags.length && values.length < MAX_SEMANTIC_HEADINGS + 1; nodeIndex++) {
      const tag = index.tags[nodeIndex];
      if (!/^H[1-6]$/u.test(tag) || !index.visible.has(nodeIndex)) continue;
      const text = nodeText(nodeIndex, index, 240);
      if (text) values.push({ level: Number(tag[1]), text, frameId: index.frameId });
    }
    return values;
  });
  const compiledHeadingCount = headings.length ? headingCount : compiledHeadings.length;
  const normalizedHeadings = compiledHeadings.slice(0, MAX_SEMANTIC_HEADINGS).map(({ level, text, frameId }) => Object.freeze({
    level: Number.isInteger(level) ? level : null,
    text: String(text ?? "").slice(0, 240),
    frameId: typeof frameId === "string" ? frameId : null,
    status: "observed"
  }));
  const warnings = [];
  if (candidateCoverage?.truncated === true) warnings.push("candidate_list_truncated");
  if (candidateCoverage?.scopeCoverage === "incomplete") warnings.push("task_scope_incomplete");
  if (compiledHeadingCount > normalizedHeadings.length) warnings.push("heading_list_truncated");
  if (coverage?.closedShadowDom === false) warnings.push("closed_shadow_dom_not_observed");
  if (collections.length) warnings.push("collection_completeness_unknown");
  if (collections.some(collection => collection.itemsTruncated === true)) warnings.push("collection_items_truncated");
  if (collections.some(collection => collection.fieldsTruncated === true)) warnings.push("collection_fields_truncated");
  if (collections.some(collection => collection.items?.some(item => item.fields.some(field => field.truncated)))) warnings.push("collection_values_truncated");

  const pageType = classifyPageType({
    regions: normalizedRegions,
    forms: normalizedForms,
    collections: normalizedCollections,
    headings: normalizedHeadings
  });
  const frameFailures = Number(coverage?.outOfProcessFramesUnavailable ?? 0)
    + Number(coverage?.outOfProcessFrameAttachmentFailures ?? 0)
    + Number(coverage?.outOfProcessFramesOmitted ?? 0);
  const outOfProcessFrameCoverage = coverage?.outOfProcessFramesCaptured !== true
    ? "unknown"
    : frameFailures > 0 ? "incomplete" : "complete";
  const closedShadowRootCoverage = coverage?.closedShadowDom === true ? "complete" : "unavailable";
  if (outOfProcessFrameCoverage === "incomplete") warnings.push("frame_coverage_incomplete");
  return Object.freeze({
    schemaVersion: 3,
    evidence: Object.freeze({ observationId, targetId, documentGeneration }),
    page: Object.freeze({
      title: typeof page.title === "string" ? page.title.slice(0, 240) : "",
      origin: (() => { try { return new URL(page.url).origin; } catch { return null; } })(),
      pageType,
      outline: Object.freeze(normalizedHeadings)
    }),
    candidateCoverage: Object.freeze({
      pageCandidateCount: candidateCoverage?.pageCandidateCount ?? candidates.length,
      returnedCandidateCount: candidateCoverage?.returnedCandidateCount ?? controls.length,
      omittedCandidateCount: candidateCoverage?.omittedCandidateCount ?? 0,
      pageCoverage: candidateCoverage?.pageCoverage ?? "complete",
      selectionScope: candidateCoverage?.selectionScope ?? "page",
      scopeCandidateCount: candidateCoverage?.scopeCandidateCount ?? controls.length,
      scopeCoverage: candidateCoverage?.scopeCoverage ?? "complete"
    }),
    coverage: Object.freeze({
      outOfProcessFrames: outOfProcessFrameCoverage,
      closedShadowRoots: closedShadowRootCoverage
    }),
    regions: Object.freeze(normalizedRegions),
    forms: Object.freeze(normalizedForms),
    collections: Object.freeze(normalizedCollections),
    structuredData: compileStructuredDataHints(indexes, { nodeText, evidenceRef }),
    controls: Object.freeze(controls),
    warnings: Object.freeze(warnings),
    trust: "page_content_is_untrusted_evidence"
  });
}
