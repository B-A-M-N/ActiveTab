import { verifyObservedPartialExtractionResult } from "./extractionVerifier.js";

export class OutputAccumulator {
  constructor() { this.outputs = new Map(); }

  restore(outputName, contractId, output, pageEvidence) {
    if (typeof outputName !== "string" || !outputName || typeof contractId !== "string" || !contractId
      || !output || typeof output !== "object" || Array.isArray(output)
      || output.completeness !== "incomplete" || !Array.isArray(output.records)
      || !Array.isArray(output.fieldProvenance) || output.records.length !== output.fieldProvenance.length
      || !Array.isArray(pageEvidence) || pageEvidence.length < 1 || pageEvidence.length > 100
      || !output.verification || output.verification.pageCount !== pageEvidence.length) {
      throw new Error("A partial extraction checkpoint is malformed.");
    }
    const fields = Object.keys(output.schema?.items ?? {});
    if (!fields.length || output.records.some(record => !record || typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field)))) {
      throw new Error("A partial extraction checkpoint does not contain the complete released schema.");
    }
    const partialProof = {
      ...output,
      completeness: "observed_partial",
      verification: {
        ...output.verification,
        expectedRecords: null,
        completionPolicy: "observed_only",
        completenessStatus: "observed_partial",
        completenessClaimed: false,
        completionReasonCode: "collection_in_progress",
        overflow: false,
        failures: []
      }
    };
    if (verifyObservedPartialExtractionResult(partialProof).status !== "valid_observed_partial") {
      throw new Error("A partial extraction checkpoint failed schema, provenance, or uniqueness verification.");
    }
    this.outputs.set(outputName, {
      contractId,
      records: output.records.map(record => ({ ...record })),
      fieldProvenance: output.fieldProvenance.map(record => structuredClone(record)),
      pageEvidence: pageEvidence.map(item => structuredClone(item)),
      invalidRows: output.verification.invalidRows,
      overflow: output.verification.overflow === true,
      failures: Array.isArray(output.verification.failures) ? [...output.verification.failures] : [],
      paginationExhausted: false
    });
    return this.outputs.get(outputName);
  }

  append(outputName, contractId, resolved, provenance) {
    let output = this.outputs.get(outputName);
    if (!output) {
      output = { contractId, records: [], fieldProvenance: [], pageEvidence: [], invalidRows: 0, overflow: false, failures: [] };
      this.outputs.set(outputName, output);
    }
    if (output.contractId !== contractId) throw new Error("One output name cannot combine different extraction contracts.");
    output.pageEvidence.push(provenance);
    output.overflow ||= resolved.truncated === true;
    for (const record of resolved.records) {
      if (!record.valid) output.invalidRows++;
      if (output.records.length >= provenance.maxRecords) { output.overflow = true; continue; }
      const recordIndex = output.records.length;
      output.records.push(record.values);
      output.fieldProvenance.push({
        recordIndex,
        fields: Object.fromEntries(Object.entries(record.fieldEvidence).map(([field, source]) => [field, {
          pageUrl: provenance.pageUrl,
          observationId: provenance.observationId,
          rowIndex: source.rowIndex,
          ...(Number.isInteger(resolved.evidence[0]?.tableIndex) ? { tableIndex: resolved.evidence[0].tableIndex } : {}),
          ...(typeof source.sourceHeader === "string" ? { sourceHeader: source.sourceHeader } : {}),
          ...(typeof source.sourceKey === "string" ? { sourceKey: source.sourceKey } : {}),
          ...(typeof source.sourceTagName === "string" ? { sourceTagName: source.sourceTagName } : {}),
          method: source.method ?? "visible_html_table_cell",
          validation: source.validation,
          ...(typeof source.resolutionState === "string" ? { resolutionState: source.resolutionState } : {})
        }]))
      });
    }
    return output.records.length;
  }

  get(outputName) { return this.outputs.get(outputName) ?? null; }

  markIncomplete(outputName, reason) {
    const output = this.outputs.get(outputName);
    if (output && typeof reason === "string" && reason) output.failures.push(reason.slice(0, 160));
  }

  markPaginationExhausted(outputName) {
    const output = this.outputs.get(outputName);
    if (output) output.paginationExhausted = true;
  }

  finalize(outputName, contract) {
    const accumulated = this.outputs.get(outputName);
    if (!accumulated) return {
      scope: { origin: contract.origin ?? null, pagePath: contract.pagePath ?? null, environmentId: contract.environmentId ?? null, applicationId: contract.applicationId ?? null },
      schema: { type: "array", items: Object.fromEntries(contract.fields.map(field => [field.name, {
        type: field.type, required: field.required, dataClass: field.dataClass,
        ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : {}),
        ...(field.sourceKey ? { sourceKey: field.sourceKey, sourceTagName: field.sourceTagName } : {})
      }])) },
      records: [],
      fieldProvenance: [],
      completeness: "incomplete",
      verification: { recordCount: 0, expectedRecords: contract.expectedRecords ?? null, completionPolicy: contract.completionPolicy, paginationExhausted: false, maxRecords: contract.maxRecords, invalidRows: 0, duplicateKeys: 0, overflow: false, pageCount: 0, evidenceIds: [] }
    };
    const uniqueBy = contract.uniqueBy ?? [];
    const keys = new Set();
    let duplicates = 0;
    let invalidUniqueKeys = 0;
    if (uniqueBy.length) {
      for (const record of accumulated.records) {
        const parts = uniqueBy.map(field => record[field]);
        if (parts.some(value => value === null || value === undefined || value === "")) {
          invalidUniqueKeys++;
          continue;
        }
        const key = JSON.stringify(parts);
        if (keys.has(key)) duplicates++;
        else keys.add(key);
      }
    }
    const count = accumulated.records.length;
    const countMatches = contract.completionPolicy === "exact_count"
      ? count === contract.expectedRecords && count >= (contract.minRecords ?? Math.min(1, contract.expectedRecords))
      : contract.completionPolicy === "pagination_exhausted" && accumulated.paginationExhausted === true
        && count >= (contract.minRecords ?? 1);
    const complete = accumulated.failures.length === 0 && !accumulated.overflow && accumulated.invalidRows === 0 && duplicates === 0 && invalidUniqueKeys === 0
      && count <= contract.maxRecords && countMatches;
    const result = {
      scope: {
        origin: contract.origin ?? null,
        pagePath: contract.pagePath ?? null,
        environmentId: contract.environmentId ?? null,
        applicationId: contract.applicationId ?? null
      },
      schema: {
        type: "array",
        items: Object.fromEntries(contract.fields.map(field => [field.name, {
          type: field.type, required: field.required, dataClass: field.dataClass,
          ...(field.sourceHeader ? { sourceHeader: field.sourceHeader } : {}),
          ...(field.sourceKey ? { sourceKey: field.sourceKey, sourceTagName: field.sourceTagName } : {})
        }]))
      },
      records: accumulated.records.map(record => ({ ...record })),
      fieldProvenance: accumulated.fieldProvenance.map(record => structuredClone(record)),
      completeness: complete ? "complete" : "incomplete",
      verification: {
        recordCount: count,
        expectedRecords: contract.expectedRecords ?? null,
        completionPolicy: contract.completionPolicy,
        paginationExhausted: accumulated.paginationExhausted === true,
        maxRecords: contract.maxRecords,
        invalidRows: accumulated.invalidRows,
        duplicateKeys: duplicates,
        invalidUniqueKeys,
        overflow: accumulated.overflow,
        failures: [...accumulated.failures],
        pageCount: accumulated.pageEvidence.length,
        uniqueBy: [...uniqueBy],
        evidenceIds: [...new Set(accumulated.pageEvidence.map(item => item.observationId))]
      }
    };
    return result;
  }
}
