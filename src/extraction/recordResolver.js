import { normalizeFieldValue, normalizeHeader } from "./extractionContract.js";

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function attributes(flat, strings) {
  const result = {};
  for (let index = 0; index + 1 < (flat?.length ?? 0); index += 2) {
    const name = stringAt(strings, flat[index]).toLocaleLowerCase();
    const value = stringAt(strings, flat[index + 1]);
    if (name) result[name] = value;
  }
  return result;
}

function visibleNodes(document) {
  const visible = new Set();
  for (let index = 0; index < (document.layout?.nodeIndex?.length ?? 0); index++) {
    const nodeIndex = document.layout.nodeIndex[index];
    const bounds = document.layout.bounds?.[index];
    if (Number.isInteger(nodeIndex) && Array.isArray(bounds) && bounds[2] > 0 && bounds[3] > 0) visible.add(nodeIndex);
  }
  return visible;
}

function descendants(root, childrenByParent) {
  const result = [];
  const stack = [...(childrenByParent.get(root) ?? [])].reverse();
  while (stack.length) {
    const index = stack.pop();
    result.push(index);
    const children = childrenByParent.get(index) ?? [];
    for (let child = children.length - 1; child >= 0; child--) stack.push(children[child]);
  }
  return result;
}

function cellText(cellIndex, { tags, nodeValue, textValue, strings, childrenByParent }) {
  let text = "";
  for (const index of [cellIndex, ...descendants(cellIndex, childrenByParent)]) {
    if (tags[index] !== "#text" && tags[index] !== "#TEXT") continue;
    text += `${stringAt(strings, textValue[index] ?? nodeValue[index])} `;
  }
  return text.trim().replaceAll("\u00a0", " ").replaceAll("\n", " ").replaceAll("\t", " ");
}

function tableRows(document, tableIndex) {
  const nodes = document.nodes;
  const tags = (nodes.nodeName ?? []).map(index => stringAt(document.strings, index).toLocaleUpperCase());
  const parents = nodes.parentIndex ?? [];
  const childrenByParent = new Map();
  for (let index = 0; index < parents.length; index++) {
    const parent = parents[index];
    if (!Number.isInteger(parent) || parent < 0) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(index);
    childrenByParent.set(parent, children);
  }
  const visible = visibleNodes(document);
  const attributesByNode = (nodes.attributes ?? []).map(flat => attributes(flat, document.strings));
  const values = nodes.nodeValue ?? [];
  const textValues = nodes.textValue ?? [];
  const tableDescendants = descendants(tableIndex, childrenByParent);
  const belongsToTable = rowIndex => {
    let parent = parents[rowIndex];
    while (Number.isInteger(parent) && parent >= 0) {
      if (tags[parent] === "TABLE") return parent === tableIndex;
      parent = parents[parent];
    }
    return false;
  };
  const rowIndexes = tableDescendants.filter(index => tags[index] === "TR" && visible.has(index) && belongsToTable(index));
  const rows = [];
  for (const rowIndex of rowIndexes) {
    const cells = descendants(rowIndex, childrenByParent).filter(index => tags[index] === "TH" || tags[index] === "TD");
    if (cells.length === 0 || cells.some(index => !visible.has(index))) continue;
    rows.push({
      header: cells.every(index => tags[index] === "TH") || cells.every(index => tags[index] === "TH" || tags[index] === "TD")
        && cells.some(index => tags[index] === "TH"),
      values: cells.map(index => cellText(index, { tags, nodeValue: values, textValue: textValues, strings: document.strings, childrenByParent })),
      attributes: attributesByNode[rowIndex]
    });
  }
  return rows;
}

function listTables(snapshot) {
  const result = [];
  for (let documentIndex = 0; documentIndex < (snapshot?.documents?.length ?? 0); documentIndex++) {
    const document = snapshot.documents[documentIndex];
    if (!document.nodes) continue;
    const tags = (document.nodes.nodeName ?? []).map(index => stringAt(snapshot.strings, index).toLocaleUpperCase());
    for (let tableIndex = 0; tableIndex < tags.length; tableIndex++) {
      if (tags[tableIndex] !== "TABLE") continue;
      const rows = tableRows({ ...document, strings: snapshot.strings }, tableIndex);
      const headerIndex = rows.findIndex(row => row.header);
      if (headerIndex < 0) continue;
      const headers = rows[headerIndex].values.map(value => value.trim());
      if (headers.length === 0 || headers.some(value => !value)) continue;
      result.push({ documentIndex, tableIndex, headers, rows: rows.slice(headerIndex + 1).filter(row => !row.header) });
    }
  }
  return result;
}

export function discoverVisibleTables(snapshot) {
  return listTables(snapshot).map((table, index) => Object.freeze({
    tableIndex: index,
    headers: Object.freeze([...table.headers]),
    visibleRowCount: table.rows.length
  }));
}

/** Resolve one visible native rel=next link constrained to the current path. */
export function discoverVisibleNextPage(snapshot, currentUrl) {
  let current;
  try { current = new URL(currentUrl); }
  catch { return { status: "invalid_current_url" }; }
  const matches = [];
  const layout = snapshot?.documents ?? [];
  for (const document of layout) {
    const tags = (document.nodes?.nodeName ?? []).map(index => stringAt(snapshot.strings, index).toLocaleUpperCase());
    const visible = visibleNodes(document);
    const nodeAttributes = (document.nodes?.attributes ?? []).map(flat => attributes(flat, snapshot.strings));
    for (let index = 0; index < tags.length; index++) {
      if (tags[index] !== "A" || !visible.has(index)) continue;
      const rel = String(nodeAttributes[index]?.rel ?? "").toLocaleLowerCase();
      const relationTokens = [];
      let token = "";
      for (const character of rel) {
        const code = character.charCodeAt(0);
        if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
          if (token) relationTokens.push(token);
          token = "";
        } else token += character;
      }
      if (token) relationTokens.push(token);
      if (!relationTokens.includes("next")) continue;
      const href = nodeAttributes[index]?.href;
      if (typeof href !== "string" || !href) continue;
      let target;
      try { target = new URL(href, current); }
      catch { continue; }
      if (!["http:", "https:"].includes(target.protocol)
        || target.origin !== current.origin
        || target.pathname !== current.pathname
        || target.username || target.password
        || target.hash) continue;
      matches.push(target.href);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length > 1) return { status: "ambiguous" };
  if (unique.length === 0) return { status: "not_found" };
  return { status: "available", url: unique[0] };
}

export function resolveVisibleTableRecords(snapshot, contract) {
  const expectedHeaders = contract.fields.map(field => normalizeHeader(field.sourceHeader));
  const matches = listTables(snapshot).filter(table => {
    const available = new Set(table.headers.map(normalizeHeader));
    return expectedHeaders.every(header => available.has(header));
  });
  if (matches.length !== 1) {
    return { status: matches.length === 0 ? "not_found" : "ambiguous", tableCount: matches.length, records: [], evidence: [] };
  }
  const table = matches[0];
  const columnByHeader = new Map(table.headers.map((header, index) => [normalizeHeader(header), index]));
  const records = [];
  const recordLimit = contract.maxRecords + 1;
  for (let rowIndex = 0; rowIndex < table.rows.length && rowIndex < recordLimit; rowIndex++) {
    const row = table.rows[rowIndex];
    const values = {};
    const fieldEvidence = {};
    let valid = true;
    for (const field of contract.fields) {
      const column = columnByHeader.get(normalizeHeader(field.sourceHeader));
      const normalized = normalizeFieldValue(row.values[column], field);
      if (!normalized.valid) valid = false;
      values[field.name] = normalized.value;
      fieldEvidence[field.name] = { sourceHeader: field.sourceHeader, rowIndex, validation: normalized.valid ? "valid" : "invalid" };
    }
    records.push({ values, fieldEvidence, valid, rowIndex });
  }
  return {
    status: "available",
    tableCount: matches.length,
    headers: [...table.headers],
    records,
    truncated: table.rows.length > recordLimit,
    evidence: [{ documentIndex: table.documentIndex, tableIndex: table.tableIndex }]
  };
}
