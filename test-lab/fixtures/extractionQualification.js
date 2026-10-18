import { OutputAccumulator } from "../../src/extraction/outputAccumulator.js";
import { verifyExtractionResult } from "../../src/extraction/extractionVerifier.js";
import { projectExtractionOutput } from "../../src/extraction/outputRelease.js";
import { discoverVisibleNextPage, resolveVisibleTableRecords } from "../../src/extraction/recordResolver.js";
import { resolveVisibleRecordGroupRecords } from "../../src/extraction/recordGroupResolver.js";

const MAX_VARIANT_CELLS = 100_000;

function fixtureValue(field, rowIndex) {
  if (field.type === "number") return rowIndex + 0.25;
  if (field.type === "integer") return rowIndex + 1;
  if (field.type === "boolean") return rowIndex % 2 === 0;
  return `${field.name}-fixture-${rowIndex}`;
}

function visibleTableSnapshot(contract, { rowCount, rowOffset = 0, seed, driftHeader = false, duplicateKey = false, nextHref = null } = {}) {
  const strings = [];
  const intern = value => { strings.push(value); return strings.length - 1; };
  const nodeName = [];
  const nodeValue = [];
  const textValue = [];
  const parentIndex = [];
  const attributes = [];
  const layoutIndexes = [];
  const add = (tag, parent, text = null, attrs = []) => {
    const index = nodeName.length;
    nodeName.push(intern(tag));
    nodeValue.push(-1);
    textValue.push(text === null ? -1 : intern(text));
    parentIndex.push(parent);
    attributes.push(attrs.flatMap(([name, value]) => [intern(name), intern(value)]));
    if (tag !== "#text") layoutIndexes.push(index);
    return index;
  };
  const html = add("HTML", -1);
  const body = add("BODY", html);
  const wrapper = add(seed % 2 ? "MAIN" : "DIV", body);
  const table = add("TABLE", wrapper);
  const thead = add("THEAD", table);
  const headerRow = add("TR", thead);
  const fields = seed % 2 ? [...contract.fields].reverse() : [...contract.fields];
  const headers = fields.map(field => field.sourceHeader);
  if (driftHeader && headers.length) headers[0] = `${headers[0]} changed`;
  for (const header of headers) {
    const cell = add("TH", headerRow);
    add("#text", cell, header);
  }
  const tbody = add("TBODY", table);
  const truth = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const globalRowIndex = rowOffset + rowIndex;
    const row = add("TR", tbody);
    const record = {};
    for (const field of fields) {
      const value = duplicateKey && globalRowIndex === (contract.expectedRecords ?? rowCount) - 1 && contract.uniqueBy.includes(field.name)
        ? fixtureValue(field, 0)
        : fixtureValue(field, globalRowIndex);
      record[field.name] = value;
      const cell = add("TD", row);
      if ((seed + globalRowIndex) % 3 === 0) {
        const span = add("SPAN", cell);
        add("#text", span, String(value));
      } else add("#text", cell, String(value));
    }
    truth.push(record);
  }
  if (nextHref) add("A", body, "Next", [["rel", "next"], ["href", nextHref]]);
  return {
    snapshot: {
      strings,
      documents: [{
          documentURL: intern(`${contract.origin ?? "https://fixture.invalid"}${contract.pagePath ?? "/catalog"}?variant=${seed}`),
        nodes: { nodeName, nodeValue, textValue, parentIndex, attributes },
        layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
      }]
    },
    truth
  };
}

function visibleRecordGroupSnapshot(contract, { rowCount, rowOffset = 0, seed, driftHeader = false, duplicateKey = false, nextHref = null } = {}) {
  const strings = [];
  const intern = value => { strings.push(value); return strings.length - 1; };
  const nodeName = [];
  const nodeValue = [];
  const textValue = [];
  const parentIndex = [];
  const attributes = [];
  const layoutIndexes = [];
  const add = (tag, parent, text = null, attrs = []) => {
    const index = nodeName.length;
    nodeName.push(intern(tag));
    nodeValue.push(-1);
    textValue.push(text === null ? -1 : intern(text));
    parentIndex.push(parent);
    attributes.push(attrs.flatMap(([name, value]) => [intern(name), intern(value)]));
    if (tag !== "#text") layoutIndexes.push(index);
    return index;
  };
  const html = add("HTML", -1);
  const body = add("BODY", html);
  const wrapper = add(seed % 2 ? "MAIN" : "DIV", body);
  const container = contract.recordGroup;
  const list = add(container.containerTagName, wrapper, null, [["class", container.containerClassToken]]);
  const fields = seed % 2 ? [...contract.fields].reverse() : [...contract.fields];
  const truth = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const globalRowIndex = rowOffset + rowIndex;
    const row = add(container.itemTagName, list, null, [["class", `${container.itemClassToken}${seed % 2 ? " fixture-layout" : ""}`]]);
    const record = {};
    for (const field of fields) {
      const sourceKey = driftHeader && globalRowIndex === rowOffset ? `${field.sourceKey}-changed` : field.sourceKey;
      const value = duplicateKey && globalRowIndex === (contract.expectedRecords ?? rowCount) - 1 && contract.uniqueBy.includes(field.name)
        ? fixtureValue(field, 0)
        : fixtureValue(field, globalRowIndex);
      record[field.name] = value;
      const source = add(field.sourceTagName, row, null, [["class", sourceKey]]);
      if ((seed + globalRowIndex) % 3 === 0) {
        const span = add("SPAN", source);
        add("#text", span, String(value));
      } else add("#text", source, String(value));
    }
    truth.push(record);
  }
  if (nextHref) add("A", body, "Next", [["rel", "next"], ["href", nextHref]]);
  return {
    snapshot: {
      strings,
      documents: [{
        documentURL: intern(`${contract.origin ?? "https://fixture.invalid"}${contract.pagePath ?? "/catalog"}?variant=${seed}`),
        nodes: { nodeName, nodeValue, textValue, parentIndex, attributes },
        layout: { nodeIndex: layoutIndexes, bounds: layoutIndexes.map(() => [0, 0, 100, 20]) }
      }]
    },
    truth
  };
}

function executeFixtureVariant(manifest, seed, { rowCount, driftHeader = false, duplicateKey = false, omitNextAt = -1 } = {}) {
  const contract = manifest.extractionContract;
  const totalRows = rowCount ?? contract.expectedRecords ?? Math.max(1, Math.min(7, contract.maxRecords));
  const targetPages = contract.pagination ? Math.min(5, contract.pagination.maxPages) : 1;
  const pageSize = contract.pagination ? Math.max(1, Math.ceil(totalRows / targetPages)) : Math.max(1, totalRows);
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const accumulator = new OutputAccumulator();
  const truth = Array.from({ length: totalRows }, (_, rowIndex) => Object.fromEntries(
    contract.fields.map(field => [field.name, fixtureValue(field, rowIndex)])
  ));
  const resolvedPages = [];
  let reachedTerminal = false;
  for (let page = 0; page < pageCount; page++) {
    const offset = page * pageSize;
    const count = Math.max(0, Math.min(pageSize, totalRows - offset));
    const hasNext = page + 1 < pageCount && page !== omitNextAt;
    const pageUrl = `${contract.origin ?? "https://fixture.invalid"}${contract.pagePath ?? "/catalog"}`;
    const fixture = manifest.kind === "visible_record_group"
      ? visibleRecordGroupSnapshot(contract, {
          seed: seed + page,
          rowCount: count,
          rowOffset: offset,
          driftHeader: driftHeader && page === 0,
          duplicateKey,
          ...(hasNext ? { nextHref: `?page=${page + 2}` } : {})
        })
      : visibleTableSnapshot(contract, {
      seed: seed + page,
      rowCount: count,
      rowOffset: offset,
      driftHeader: driftHeader && page === 0,
      duplicateKey,
      ...(hasNext ? { nextHref: `?page=${page + 2}` } : {})
      });
    const resolved = manifest.kind === "visible_record_group"
      ? resolveVisibleRecordGroupRecords(fixture.snapshot, contract)
      : resolveVisibleTableRecords(fixture.snapshot, contract);
    resolvedPages.push(resolved);
    accumulator.append("records", `${manifest.capabilityId}@${manifest.capabilityVersion}`, {
      records: resolved.records ?? [],
      truncated: resolved.truncated === true,
      evidence: resolved.evidence ?? []
    }, {
      observationId: `fixture-observation-${seed}-${page}`,
      pageUrl,
      maxRecords: contract.maxRecords
    });
    if (resolved.status !== "available") break;
    if (contract.pagination) {
      const next = discoverVisibleNextPage(fixture.snapshot, `${pageUrl}?page=${page + 1}`);
      if (next.status === "not_found") { reachedTerminal = true; break; }
      if (next.status !== "available") break;
    } else break;
  }
  if (contract.pagination && reachedTerminal) accumulator.markPaginationExhausted("records");
  const lastResolved = resolvedPages.at(-1) ?? { status: "not_found" };
  return {
    resolved: lastResolved,
    output: accumulator.finalize("records", contract),
    truth
  };
}

function equalRecords(left, right) {
  const canonical = value => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  return canonical(left) === canonical(right);
}

/**
 * Independently qualify a recipe against deterministic structural variants
 * and controlled negative cases. Fixture truth never enters ActiveTab's
 * planner or execution input.
 */
export async function qualifyExtractionManifest({ manifest, variants = 30, signal } = {}) {
  if (!Number.isInteger(variants) || variants < 3 || variants > 1000) throw new Error("Extraction fixture qualification requires 3 to 1000 variants.");
  const contract = manifest?.extractionContract;
  const fixtureCount = contract?.expectedRecords ?? Math.max(1, Math.min(7, contract?.maxRecords ?? 0));
  if (!contract || fixtureCount * variants > MAX_VARIANT_CELLS) {
    throw new Error("Extraction fixture qualification exceeds its bounded row budget.");
  }
  const reports = [];
  for (let seed = 0; seed < variants; seed++) {
    if (signal?.aborted) throw Object.assign(new Error("Fixture qualification canceled."), { name: "AbortError" });
    const positive = executeFixtureVariant(manifest, seed);
    const validation = verifyExtractionResult(positive.output);
    const schemaMatch = equalRecords(positive.output.records, positive.truth);
    const withheld = positive.output
      ? projectExtractionOutput(positive.output, () => false)
      : null;
    const releasableFields = [];
    const withheldFields = contract.fields.map(field => field.name);
    const privacyBoundaryPassed = Boolean(withheld)
      && equalRecords(Object.keys(withheld.schema?.items ?? {}).sort(), releasableFields)
      && withheld.records.every(record => equalRecords(Object.keys(record).sort(), releasableFields))
      && withheld.fieldProvenance.every(record => equalRecords(Object.keys(record.fields ?? {}).sort(), releasableFields))
      && (withheldFields.length === 0
        ? withheld.completeness === positive.output.completeness
        : withheld.completeness === "incomplete"
          && withheld.verification.releaseStatus === "partial"
          && withheldFields.every(name => !Object.hasOwn(withheld.schema?.items ?? {}, name)
            && withheld.records.every(record => !Object.hasOwn(record, name))
            && withheld.fieldProvenance.every(record => !Object.hasOwn(record.fields ?? {}, name))));
    const missingPage = executeFixtureVariant(manifest, seed, { rowCount: Math.max(0, fixtureCount - 1) });
    const duplicateRows = executeFixtureVariant(manifest, seed, { rowCount: fixtureCount, duplicateKey: fixtureCount > 1 });
    const drift = executeFixtureVariant(manifest, seed, { rowCount: fixtureCount, driftHeader: true });
    const earlyTerminal = contract.pagination
      ? executeFixtureVariant(manifest, seed, { rowCount: fixtureCount, omitNextAt: 0 })
      : null;
    const faultDetection = (!missingPage.output || missingPage.output.completeness !== "complete" || !equalRecords(missingPage.output.records, missingPage.truth))
      && (fixtureCount < 2 || duplicateRows.output.completeness !== "complete" || !equalRecords(duplicateRows.output.records, duplicateRows.truth))
      && (drift.resolved.status !== "available" || drift.output.completeness !== "complete");
    const paginationTested = !contract.pagination
      || (positive.output.verification.pageCount > 1 && positive.output.verification.paginationExhausted === true
        && earlyTerminal && !equalRecords(earlyTerminal.output.records, earlyTerminal.truth));
    const positiveComplete = validation.status === "complete"
      && (contract.expectedRecords === undefined || positive.output.verification.recordCount === contract.expectedRecords);
    reports.push({
      scenarioId: `extraction-${manifest.kind}-variant-${seed}`,
      evidenceRef: `fixture-extraction:${manifest.capabilityId}:${seed}`,
      status: positiveComplete && schemaMatch && faultDetection && paginationTested && privacyBoundaryPassed ? "complete" : "incomplete",
      schemaMatch,
      paginationTested,
      completenessVerified: positiveComplete && faultDetection && paginationTested,
      privacyBoundaryPassed
    });
  }
  return { oracleIndependent: true, variants: reports };
}

export { visibleTableSnapshot };
