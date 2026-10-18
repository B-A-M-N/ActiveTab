import { normalizeFieldValue } from "./extractionContract.js";

const MAX_GROUP_ITEMS = 10_000;

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function splitTokens(value) {
  const tokens = [];
  let token = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
      if (token) tokens.push(token);
      token = "";
    } else token += character;
  }
  if (token) tokens.push(token);
  return [...new Set(tokens)];
}

function indexDocument(snapshot, document) {
  const nodes = document?.nodes;
  if (!nodes) return null;
  const tags = (nodes.nodeName ?? []).map(index => stringAt(snapshot.strings, index).toLocaleUpperCase());
  const parentIndex = nodes.parentIndex ?? [];
  const children = new Map();
  for (let index = 0; index < parentIndex.length; index++) {
    const parent = parentIndex[index];
    if (!Number.isInteger(parent) || parent < 0) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(index);
    children.set(parent, siblings);
  }
  const attributes = (nodes.attributes ?? []).map(flat => {
    const values = {};
    for (let index = 0; index + 1 < (flat?.length ?? 0); index += 2) {
      const name = stringAt(snapshot.strings, flat[index]).toLocaleLowerCase();
      if (name) values[name] = stringAt(snapshot.strings, flat[index + 1]);
    }
    return values;
  });
  const visible = new Set();
  for (let index = 0; index < (document.layout?.nodeIndex?.length ?? 0); index++) {
    const nodeIndex = document.layout.nodeIndex[index];
    const bounds = document.layout.bounds?.[index];
    if (Number.isInteger(nodeIndex) && Array.isArray(bounds) && bounds[2] > 0 && bounds[3] > 0) visible.add(nodeIndex);
  }
  return { tags, parentIndex, children, attributes, visible, values: nodes.nodeValue ?? [], textValues: nodes.textValue ?? [], strings: snapshot.strings };
}

function descendants(root, children) {
  const result = [];
  const stack = [...(children.get(root) ?? [])].reverse();
  while (stack.length) {
    const index = stack.pop();
    result.push(index);
    const nested = children.get(index) ?? [];
    for (let child = nested.length - 1; child >= 0; child--) stack.push(nested[child]);
  }
  return result;
}

function classTokens(index, nodeIndex) {
  return splitTokens(index.attributes[nodeIndex]?.class);
}

function textUnder(index, nodeIndex) {
  let result = "";
  for (const child of [nodeIndex, ...descendants(nodeIndex, index.children)]) {
    if (index.tags[child] !== "#TEXT") continue;
    result += `${stringAt(index.strings, index.textValues[child] ?? index.values[child])} `;
  }
  return result.trim().replaceAll("\u00a0", " ").replaceAll("\n", " ").replaceAll("\t", " ");
}

function commonTokens(tokenLists) {
  if (!tokenLists.length) return [];
  return tokenLists[0].filter(token => tokenLists.every(tokens => tokens.includes(token)));
}

function preferredToken(tokens) {
  return [...tokens].sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? null;
}

function repeatedSources(index, items) {
  const perItem = items.map(item => {
    const counts = new Map();
    for (const node of descendants(item, index.children)) {
      if (!index.visible.has(node) || !index.tags[node] || index.tags[node].startsWith("#")) continue;
      if (!textUnder(index, node)) continue;
      for (const token of classTokens(index, node)) {
        const key = `${index.tags[node]}\u0000${token}`;
        const value = counts.get(key) ?? { tagName: index.tags[node], classToken: token, count: 0 };
        value.count++;
        counts.set(key, value);
      }
    }
    return counts;
  });
  if (!perItem.length) return [];
  const common = [...perItem[0].keys()].filter(key => perItem.every(sources => sources.get(key)?.count === 1));
  return common.map(key => {
    const source = perItem[0].get(key);
    return { tagName: source.tagName, classToken: source.classToken };
  }).sort((left, right) => left.classToken.localeCompare(right.classToken) || left.tagName.localeCompare(right.tagName));
}

/** Discover repeated visible sibling records without returning their values. */
export function discoverVisibleRecordGroups(snapshot, { minRecords = 2, maxRecords = MAX_GROUP_ITEMS } = {}) {
  if (!Number.isInteger(minRecords) || minRecords < 2 || !Number.isInteger(maxRecords) || maxRecords < minRecords) return [];
  const candidates = [];
  const seen = new Set();
  for (let documentIndex = 0; documentIndex < (snapshot?.documents?.length ?? 0); documentIndex++) {
    const document = snapshot.documents[documentIndex];
    const index = indexDocument(snapshot, document);
    if (!index) continue;
    for (let parent = 0; parent < index.tags.length; parent++) {
      if (!index.visible.has(parent) || !index.tags[parent] || index.tags[parent].startsWith("#")) continue;
      const containerClassToken = preferredToken(classTokens(index, parent));
      if (!containerClassToken) continue;
      const children = (index.children.get(parent) ?? []).filter(node => index.visible.has(node) && !index.tags[node]?.startsWith("#"));
      const groups = new Map();
      for (const child of children) {
        const itemTagName = index.tags[child];
        const itemClassToken = preferredToken(classTokens(index, child));
        if (!itemTagName || !itemClassToken) continue;
        const key = `${itemTagName}\u0000${itemClassToken}`;
        const group = groups.get(key) ?? { itemTagName, itemClassToken, items: [] };
        group.items.push(child);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (group.items.length < minRecords) continue;
        const sourceFields = repeatedSources(index, group.items);
        if (sourceFields.length === 0) continue;
        const identity = `${documentIndex}:${index.tags[parent]}:${containerClassToken}:${group.itemTagName}:${group.itemClassToken}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push(Object.freeze({
          documentIndex,
          recordGroup: Object.freeze({
            containerTagName: index.tags[parent],
            containerClassToken,
            itemTagName: group.itemTagName,
            itemClassToken: group.itemClassToken
          }),
          fields: Object.freeze(sourceFields.map(source => Object.freeze({ sourceKey: source.classToken, sourceTagName: source.tagName }))),
          visibleRecordCount: Math.min(group.items.length, maxRecords),
          truncated: group.items.length > maxRecords
        }));
      }
    }
  }
  return candidates;
}

function fieldSourceMatches(nodeIndex, index, field) {
  return index.visible.has(nodeIndex) && index.tags[nodeIndex] === field.sourceTagName
    && classTokens(index, nodeIndex).includes(field.sourceKey);
}

/** Resolve one registered repeated-record group against a fresh DOM snapshot. */
export function resolveVisibleRecordGroupRecords(snapshot, contract) {
  const selector = contract?.recordGroup;
  const fields = contract?.fields;
  if (!selector || !Array.isArray(fields) || fields.length === 0) {
    return { status: "invalid_contract", records: [], evidence: [] };
  }
  const groups = [];
  for (let documentIndex = 0; documentIndex < (snapshot?.documents?.length ?? 0); documentIndex++) {
    const document = snapshot.documents[documentIndex];
    const index = indexDocument(snapshot, document);
    if (!index) continue;
    for (let parent = 0; parent < index.tags.length; parent++) {
      if (!index.visible.has(parent) || index.tags[parent] !== selector.containerTagName
        || !classTokens(index, parent).includes(selector.containerClassToken)) continue;
      const items = (index.children.get(parent) ?? []).filter(node => index.visible.has(node)
        && index.tags[node] === selector.itemTagName
        && classTokens(index, node).includes(selector.itemClassToken));
      if (items.length > 0) groups.push({ documentIndex, index, parent, items });
    }
  }
  if (groups.length !== 1) return { status: groups.length === 0 ? "not_found" : "ambiguous", groupCount: groups.length, records: [], evidence: [] };
  const group = groups[0];
  const records = [];
  const rowLimit = Math.min(contract.maxRecords + 1, MAX_GROUP_ITEMS + 1);
  const selectedItems = group.items.slice(0, rowLimit);
  for (let rowIndex = 0; rowIndex < selectedItems.length; rowIndex++) {
    const item = selectedItems[rowIndex];
    const values = {};
    const fieldEvidence = {};
    let valid = true;
    for (const field of fields) {
      const matches = descendants(item, group.index.children)
        .filter(node => fieldSourceMatches(node, group.index, field));
      const raw = matches.length === 1 ? textUnder(group.index, matches[0]) : "";
      const normalized = normalizeFieldValue(raw, field);
      if (!normalized.valid) valid = false;
      values[field.name] = normalized.value;
      fieldEvidence[field.name] = {
        sourceKey: field.sourceKey,
        sourceTagName: field.sourceTagName,
        rowIndex,
        method: "visible_record_group_text",
        validation: normalized.valid ? "valid" : "invalid"
      };
    }
    records.push({ values, fieldEvidence, valid, rowIndex });
  }
  return {
    status: "available",
    records,
    truncated: group.items.length > contract.maxRecords || group.items.length > MAX_GROUP_ITEMS,
    evidence: [{
      documentIndex: group.documentIndex,
      containerTagName: selector.containerTagName,
      containerClassToken: selector.containerClassToken,
      itemTagName: selector.itemTagName,
      itemClassToken: selector.itemClassToken,
      visibleRecordCount: group.items.length
    }]
  };
}
