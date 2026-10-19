import { fieldResolutionState, normalizeFieldValue, normalizeHeader } from "./extractionContract.js";
import { descendantNodeIndexes, documentIndexFor } from "../observe/documentIndex.js";

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings?.[index] ?? "") : "";
}

function cellText(cellIndex, index) {
  let text = "";
  for (const nodeIndex of [cellIndex, ...descendantNodeIndexes(cellIndex, index)]) {
    if (index.tags[nodeIndex] !== "#TEXT") continue;
    text += `${stringAt(index.strings, index.textValues[nodeIndex] ?? index.nodeValues[nodeIndex])} `;
  }
  return text.trim().replaceAll("\u00a0", " ").replaceAll("\n", " ").replaceAll("\t", " ");
}

function tableRows(index, tableIndex, { maxDataRowsWithText = Number.MAX_SAFE_INTEGER } = {}) {
  const tags = index.tags;
  const parents = index.parents;
  const tableDescendants = descendantNodeIndexes(tableIndex, index);
  const belongsToTable = rowIndex => {
    let parent = parents[rowIndex];
    while (Number.isInteger(parent) && parent >= 0) {
      if (tags[parent] === "TABLE") return parent === tableIndex;
      parent = parents[parent];
    }
    return false;
  };
  const rowIndexes = tableDescendants.filter(nodeIndex => tags[nodeIndex] === "TR" && index.visible.has(nodeIndex) && belongsToTable(nodeIndex));
  const belongsToRow = (cellIndex, rowIndex) => {
    let parent = parents[cellIndex];
    while (Number.isInteger(parent) && parent >= 0) {
      if (tags[parent] === "TR") return parent === rowIndex;
      parent = parents[parent];
    }
    return false;
  };
  const rows = [];
  let headerFound = false;
  let visibleRecordCount = 0;
  let storedRecordCount = 0;
  let textDataRowCount = 0;
  for (const rowIndex of rowIndexes) {
    const cells = descendantNodeIndexes(rowIndex, index).filter(nodeIndex =>
      (tags[nodeIndex] === "TH" || tags[nodeIndex] === "TD") && belongsToRow(nodeIndex, rowIndex)
    );
    if (cells.length === 0 || cells.some(nodeIndex => !index.visible.has(nodeIndex))) continue;
    const header = cells.every(nodeIndex => tags[nodeIndex] === "TH") || cells.every(nodeIndex => tags[nodeIndex] === "TH" || tags[nodeIndex] === "TD")
      && cells.some(nodeIndex => tags[nodeIndex] === "TH");
    if (header) headerFound = true;
    else if (headerFound) visibleRecordCount++;
    const keepRecord = header || (headerFound && storedRecordCount < maxDataRowsWithText);
    const includeText = header || (keepRecord && textDataRowCount < maxDataRowsWithText);
    if (!header && keepRecord) storedRecordCount++;
    if (!header && includeText && headerFound) textDataRowCount++;
    if (!keepRecord) continue;
    const cellRecords = cells.map(nodeIndex => ({
      nodeIndex,
      backendNodeId: index.backendNodeIds[nodeIndex] ?? null,
      value: includeText ? cellText(nodeIndex, index) : ""
    }));
    rows.push({
      nodeIndex: rowIndex,
      backendNodeId: index.backendNodeIds[rowIndex] ?? null,
      header,
      values: cellRecords.map(cell => cell.value),
      cells: cellRecords,
      textIncluded: includeText,
      attributes: index.attributes[rowIndex]
    });
  }
  return { rows, visibleRecordCount, textDataRowCount };
}

function listTables(snapshot, { maxSourceRecordRows = Number.MAX_SAFE_INTEGER, index: suppliedIndex = null } = {}) {
  const result = [];
  let remainingSourceRecordRows = maxSourceRecordRows;
  const sharedIndex = documentIndexFor(snapshot, suppliedIndex);
  for (const indexedDocument of sharedIndex.documents) {
    if (!indexedDocument) continue;
    const { documentIndex, tags } = indexedDocument;
    for (let tableIndex = 0; tableIndex < tags.length; tableIndex++) {
      if (tags[tableIndex] !== "TABLE") continue;
      const { rows, visibleRecordCount, textDataRowCount } = tableRows(
        indexedDocument,
        tableIndex,
        { maxDataRowsWithText: remainingSourceRecordRows }
      );
      const headerIndex = rows.findIndex(row => row.header);
      if (headerIndex < 0) continue;
      const headerRow = rows[headerIndex];
      const headers = headerRow.values.map(value => value.trim());
      if (headers.length === 0 || headers.some(value => !value)) continue;
      const records = rows.slice(headerIndex + 1).filter(row => !row.header);
      remainingSourceRecordRows = Math.max(0, remainingSourceRecordRows - textDataRowCount);
      result.push({
        documentIndex,
        frameId: indexedDocument.frameId,
        frameTargetId: indexedDocument.frameTargetId,
        parentFrameId: indexedDocument.parentFrameId,
        tableIndex,
        nodeIndex: tableIndex,
        backendNodeId: indexedDocument.backendNodeIds[tableIndex] ?? null,
        bounds: indexedDocument.layoutBoundsByNodeIndex.get(tableIndex) ?? null,
        headers,
        headerCells: headerRow.cells,
        visibleRowCount: visibleRecordCount,
        rows: records
      });
    }
  }
  return result;
}

export function discoverVisibleTables(snapshot, { index: suppliedIndex = null } = {}) {
  return listTables(snapshot, { index: suppliedIndex }).map((table, index) => Object.freeze({
    tableIndex: index,
    headers: Object.freeze([...table.headers]),
    visibleRowCount: table.visibleRowCount
  }));
}

/** Internal semantic compiler view; source locators are observation-local evidence, never action capabilities. */
export function discoverVisibleTableSources(snapshot, { maxRecords = 64, index: suppliedIndex = null } = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 0 || maxRecords > 1_000) {
    throw new Error("Semantic table source record limit is outside its bound.");
  }
  let remaining = maxRecords;
  return listTables(snapshot, { maxSourceRecordRows: maxRecords, index: suppliedIndex }).map(table => {
    const rows = table.rows.slice(0, remaining);
    remaining -= rows.length;
    return Object.freeze({
    documentIndex: table.documentIndex,
    frameId: table.frameId,
    frameTargetId: table.frameTargetId,
    parentFrameId: table.parentFrameId,
    nodeIndex: table.nodeIndex,
    backendNodeId: table.backendNodeId,
    bounds: table.bounds ?? null,
    headers: Object.freeze([...table.headers]),
    headerCells: Object.freeze(table.headerCells.map(cell => Object.freeze({ ...cell }))),
    visibleRowCount: table.visibleRowCount,
    rows: Object.freeze(rows.map(row => Object.freeze({
      nodeIndex: row.nodeIndex,
      backendNodeId: row.backendNodeId,
      cells: Object.freeze(row.cells.map(cell => Object.freeze({ ...cell })))
    })))
  });
  });
}

function paginationAnchorCandidates(snapshot, current, suppliedIndex) {
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) return null;
  const matches = [];
  const declaredNextLinkCount = { value: 0 };
  const unusableNextLinkCount = { value: 0 };
  const sharedIndex = documentIndexFor(snapshot, suppliedIndex);
  for (const indexedDocument of sharedIndex.documents) {
    if (!indexedDocument) continue;
    for (let nodeIndex = 0; nodeIndex < indexedDocument.tags.length; nodeIndex++) {
      if (indexedDocument.tags[nodeIndex] !== "A") continue;
      const attributes = indexedDocument.attributes[nodeIndex] ?? {};
      const relTokens = String(attributes.rel ?? "").toLocaleLowerCase().split(/[\t\n\f\r ]+/u).filter(Boolean);
      const accessibleName = String(attributes["aria-label"] ?? attributes.title ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
      const isExplicitNext = /^(?:next|next page|next results?|older|more results?)$/u.test(accessibleName);
      if (!relTokens.includes("next") && !isExplicitNext) continue;
      declaredNextLinkCount.value++;
      if (!indexedDocument.visible.has(nodeIndex)) { unusableNextLinkCount.value++; continue; }
      const href = attributes.href;
      if (typeof href !== "string" || !href) { unusableNextLinkCount.value++; continue; }
      let target;
      try { target = new URL(href, current); }
      catch { unusableNextLinkCount.value++; continue; }
      if (!new Set(["http:", "https:"]).has(target.protocol)
        || target.origin !== current.origin || target.pathname !== current.pathname
        || target.username || target.password || target.hash) { unusableNextLinkCount.value++; continue; }
      matches.push({ url: target.href, relNext: relTokens.includes("next"), explicitNext: isExplicitNext });
    }
  }
  return { matches, declaredNextLinkCount: declaredNextLinkCount.value, unusableNextLinkCount: unusableNextLinkCount.value };
}

function paginationButtonCandidates(snapshot, suppliedIndex) {
  const result = { matches: [], declared: 0, unusable: 0 };
  const sharedIndex = documentIndexFor(snapshot, suppliedIndex);
  for (const indexedDocument of sharedIndex.documents) {
    if (!indexedDocument) continue;
    for (let nodeIndex = 0; nodeIndex < indexedDocument.tags.length; nodeIndex++) {
      const tag = indexedDocument.tags[nodeIndex];
      if (tag !== "BUTTON" && tag !== "INPUT") continue;
      const attributes = indexedDocument.attributes[nodeIndex] ?? {};
      if (tag === "INPUT" && !["button", "submit"].includes(String(attributes.type ?? "").toLowerCase())) continue;
      const text = descendantNodeIndexes(nodeIndex, indexedDocument)
        .filter(index => indexedDocument.tags[index] === "#TEXT")
        .map(index => stringAt(indexedDocument.strings, indexedDocument.textValues[index] ?? indexedDocument.nodeValues[index]))
        .join(" ").replace(/\s+/gu, " ").trim();
      const label = String(attributes["aria-label"] ?? attributes.title ?? attributes.value ?? text).trim().replace(/\s+/gu, " ").toLocaleLowerCase();
      if (!/^(?:next|next page|next results?|older|more results?)$/u.test(label)) continue;
      result.declared++;
      const backendNodeId = indexedDocument.backendNodeIds[nodeIndex];
      if (!indexedDocument.visible.has(nodeIndex) || !Number.isInteger(backendNodeId)) {
        result.unusable++;
        continue;
      }
      result.matches.push({ frameId: indexedDocument.frameId, backendNodeId, tag: tag.toLowerCase() });
    }
  }
  return result;
}

function sameQueryExceptPageParameter(current, target, parameter) {
  const normalize = params => [...params.entries()].filter(([name]) => name !== parameter).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return JSON.stringify(normalize(current.searchParams)) === JSON.stringify(normalize(target.searchParams));
}

/** Resolve a profile-declared pagination adapter from one retained DOMSnapshot. */
export function discoverVisibleNextPage(snapshot, currentUrl, {
  index: suppliedIndex = null,
  kind = "rel_next_same_path",
  queryParameter = null
} = {}) {
  let current;
  try { current = new URL(currentUrl); }
  catch { return { status: "invalid_current_url" }; }
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) {
    return { status: "unavailable", reasonCode: "pagination_dom_evidence_unavailable" };
  }
  const anchors = paginationAnchorCandidates(snapshot, current, suppliedIndex);
  if (!anchors) return { status: "unavailable", reasonCode: "pagination_dom_evidence_unavailable" };
  let matches = [];
  let declared = anchors.declaredNextLinkCount;
  let unusable = anchors.unusableNextLinkCount;
  if (kind === "rel_next_same_path") {
    matches = anchors.matches.filter(item => item.relNext).map(item => item.url);
    declared = anchors.matches.filter(item => item.relNext).length + anchors.declaredNextLinkCount - anchors.matches.length;
    unusable = anchors.unusableNextLinkCount;
  } else if (kind === "explicit_next_same_path") {
    const explicitAnchors = anchors.matches.filter(item => item.explicitNext);
    const buttons = paginationButtonCandidates(snapshot, suppliedIndex);
    const explicitLinks = explicitAnchors.map(item => ({ kind: "link", url: item.url }));
    const explicitButtons = buttons.matches.map(target => ({ kind: "button", target }));
    const targets = [...explicitLinks, ...explicitButtons];
    declared = explicitAnchors.length + buttons.declared;
    unusable = anchors.unusableNextLinkCount + buttons.unusable;
    if (targets.length > 1) return { status: "ambiguous" };
    if (targets.length === 1 && targets[0].kind === "button") {
      return { status: "available", kind, action: "click", target: targets[0].target };
    }
    matches = explicitAnchors.map(item => item.url);
  } else if (kind === "page_number_query") {
    if (typeof queryParameter !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(queryParameter)) return { status: "invalid_strategy" };
    const currentValue = current.searchParams.get(queryParameter);
    const currentPage = currentValue === null ? 1 : /^\d{1,9}$/u.test(currentValue) ? Number(currentValue) : NaN;
    if (!Number.isSafeInteger(currentPage) || currentPage < 1) return { status: "unavailable", reasonCode: "pagination_page_number_unavailable" };
    const candidates = [];
    for (const indexedDocument of documentIndexFor(snapshot, suppliedIndex).documents) {
      if (!indexedDocument) continue;
      for (let nodeIndex = 0; nodeIndex < indexedDocument.tags.length; nodeIndex++) {
        if (indexedDocument.tags[nodeIndex] !== "A" || !indexedDocument.visible.has(nodeIndex)) continue;
        const href = indexedDocument.attributes[nodeIndex]?.href;
        if (typeof href !== "string" || !href) continue;
        let target;
        try { target = new URL(href, current); } catch { continue; }
        const pageValue = target.searchParams.get(queryParameter);
        if (target.origin === current.origin && target.pathname === current.pathname
          && !target.username && !target.password && !target.hash
          && pageValue === String(currentPage + 1)
          && sameQueryExceptPageParameter(current, target, queryParameter)) candidates.push(target.href);
      }
    }
    matches = candidates;
    declared = candidates.length;
    unusable = 0;
  } else return { status: "invalid_strategy" };
  const unique = [...new Set(matches)];
  if (unique.length > 1) return { status: "ambiguous" };
  if (unique.length === 0) return declared || unusable
    ? { status: "unavailable", reasonCode: "pagination_next_link_unusable" }
    : { status: "not_found" };
  return { status: "available", url: unique[0], kind };
}

/** Identify the same-page scroll target that owns the visible table rectangle. */
export function discoverVirtualizedListScrollTarget(observation, tableBounds) {
  if (!tableBounds || ![tableBounds.x, tableBounds.y, tableBounds.width, tableBounds.height].every(Number.isFinite)) {
    return { status: "unavailable", reasonCode: "pagination_collection_bounds_unavailable" };
  }
  const centerX = tableBounds.x + tableBounds.width / 2;
  const centerY = tableBounds.y + tableBounds.height / 2;
  if (!Array.isArray(observation?.scrollTargets) || observation.coverage?.scrollTargets !== true) {
    return { status: "unavailable", reasonCode: "pagination_scroll_evidence_unavailable" };
  }
  const targets = observation.scrollTargets.filter(target => target?.visible === true
    && target?.targetId === observation.targetId
    && target?.documentGeneration === observation.documentGeneration
    && target?.frameTargetId == null && target?.bounds
    && centerX >= target.bounds.x && centerX <= target.bounds.x + target.bounds.width
    && centerY >= target.bounds.y && centerY <= target.bounds.y + target.bounds.height);
  targets.sort((left, right) => left.bounds.width * left.bounds.height - right.bounds.width * right.bounds.height);
  if (!targets.length) return { status: "unavailable", reasonCode: "pagination_scroll_region_unavailable" };
  const smallestArea = targets[0].bounds.width * targets[0].bounds.height;
  const smallest = targets.filter(target => target.bounds.width * target.bounds.height === smallestArea);
  if (smallest.length !== 1) return { status: "ambiguous" };
  const target = smallest[0];
  if (target.canScrollDown !== true) return { status: "not_found" };
  return { status: "available", identity: target.identity, beforeScrollTop: target.scrollTop, maxScrollTop: target.maxScrollTop };
}

export function discoverPageNumberQueryParameters(snapshot, currentUrl, { index: suppliedIndex = null } = {}) {
  let current;
  try { current = new URL(currentUrl); } catch { return []; }
  if (!Array.isArray(snapshot?.documents) || !Array.isArray(snapshot?.strings)) return [];
  const parameters = new Set();
  for (const indexedDocument of documentIndexFor(snapshot, suppliedIndex).documents) {
    if (!indexedDocument) continue;
    for (let nodeIndex = 0; nodeIndex < indexedDocument.tags.length; nodeIndex++) {
      if (indexedDocument.tags[nodeIndex] !== "A" || !indexedDocument.visible.has(nodeIndex)) continue;
      const href = indexedDocument.attributes[nodeIndex]?.href;
      if (typeof href !== "string" || !href) continue;
      let target;
      try { target = new URL(href, current); } catch { continue; }
      if (target.origin !== current.origin || target.pathname !== current.pathname || target.hash
        || target.username || target.password) continue;
      const names = new Set([...current.searchParams.keys(), ...target.searchParams.keys()]);
      for (const name of names) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name)) continue;
        const currentValue = current.searchParams.get(name);
        const currentPage = currentValue === null ? 1 : /^\d{1,9}$/u.test(currentValue) ? Number(currentValue) : NaN;
        if (!Number.isSafeInteger(currentPage) || currentPage < 1
          || target.searchParams.get(name) !== String(currentPage + 1)
          || !sameQueryExceptPageParameter(current, target, name)) continue;
        parameters.add(name);
      }
    }
  }
  return [...parameters].sort();
}

export function resolveVisibleTableRecords(snapshot, contract, { index: suppliedIndex = null } = {}) {
  const expectedHeaders = contract.fields.map(field => normalizeHeader(field.sourceHeader));
  const matches = listTables(snapshot, { index: suppliedIndex }).filter(table => {
    const available = new Set(table.headers.map(normalizeHeader));
    return expectedHeaders.every(header => available.has(header));
  });
  if (matches.length !== 1) {
    return { status: matches.length === 0 ? "not_found" : "ambiguous", tableCount: matches.length, records: [], evidence: [] };
  }
  const table = matches[0];
  const columnsByHeader = new Map();
  table.headers.forEach((header, index) => {
    const key = normalizeHeader(header);
    const columns = columnsByHeader.get(key) ?? [];
    columns.push(index);
    columnsByHeader.set(key, columns);
  });
  if (expectedHeaders.some(header => columnsByHeader.get(header)?.length !== 1)) {
    return { status: "ambiguous", tableCount: matches.length, records: [], evidence: [], reasonCode: "duplicate_source_header" };
  }
  const records = [];
  const recordLimit = contract.maxRecords + 1;
  for (let rowIndex = 0; rowIndex < table.rows.length && rowIndex < recordLimit; rowIndex++) {
    const row = table.rows[rowIndex];
    const values = {};
    const fieldEvidence = {};
    let valid = true;
    for (const field of contract.fields) {
      const columns = columnsByHeader.get(normalizeHeader(field.sourceHeader)) ?? [];
      const raw = columns.length === 1 ? row.values[columns[0]] : "";
      const normalized = normalizeFieldValue(raw, field);
      const resolutionState = fieldResolutionState(raw, normalized, columns.length);
      if (!normalized.valid) valid = false;
      values[field.name] = normalized.value;
      fieldEvidence[field.name] = {
        sourceHeader: field.sourceHeader,
        rowIndex,
        validation: normalized.valid ? "valid" : "invalid",
        resolutionState
      };
    }
    records.push({ values, fieldEvidence, valid, rowIndex });
  }
  return {
    status: "available",
    tableCount: matches.length,
    headers: [...table.headers],
    records,
    truncated: table.rows.length > recordLimit,
    evidence: [{ documentIndex: table.documentIndex, tableIndex: table.tableIndex, bounds: table.bounds ?? null }]
  };
}
