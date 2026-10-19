import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVisibleRecordTransformations, parseVisibleRecordTransformation } from "../src/extraction/recordTransformations.js";
import { resolveTaskIntent } from "../src/navigation/taskIntentResolver.js";
import { verifyObservedPartialExtractionResult } from "../src/extraction/extractionVerifier.js";

function partialOutput() {
  const records = [
    { name: "Widget C", price: "$8.00" },
    { name: "Widget A", price: "$12.00" },
    { name: "Widget B", price: "$7.00" }
  ];
  const fields = {
    name: { type: "string", required: true, dataClass: "public", sourceHeader: "Name" },
    price: { type: "string", required: true, dataClass: "public", sourceHeader: "Price" }
  };
  const fieldProvenance = records.map((_, recordIndex) => ({
    recordIndex,
    fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, {
      pageUrl: "https://catalog.example/products", observationId: `observation-${recordIndex}`,
      sourceHeader: field.sourceHeader, method: "visible_html_table_cell", validation: "valid"
    }]))
  }));
  return {
    scope: { origin: "https://catalog.example", pagePath: "/products" },
    schema: { type: "array", items: fields },
    records, fieldProvenance, completeness: "observed_partial",
    verification: {
      recordCount: records.length, expectedRecords: null, completionPolicy: "observed_only",
      completenessStatus: "observed_partial", completenessClaimed: false, pageCount: 1,
      maxRecords: 100, invalidRows: 0, duplicateKeys: 0, invalidUniqueKeys: 0,
      overflow: false, failures: [], uniqueBy: [], evidenceIds: ["observation-0"]
    }
  };
}

test("visible cheapest request resolves to a typed local sort and selection plan", () => {
  const capability = {
    id: "observed_read_catalog",
    action: "extract", effectClass: "read", targetRole: "observed_records",
    purposeCodes: ["extract_records"], postconditionCodes: ["observed_records_returned"],
    outputSchema: [{ name: "name", type: "string", required: true }, { name: "price", type: "string", required: true }]
  };
  const resolution = resolveTaskIntent({
    goal: "Give me the three cheapest visible products",
    capabilities: [capability], observedReadCapabilityIds: [capability.id]
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.source, "deterministic_visible_record_transformation");
  assert.deepEqual(resolution.intent.localTransform.operations.map(operation => operation.op), ["sort_records", "select_first_n"]);
  assert.equal(resolveTaskIntent({
    goal: "Give me the three cheapest products across the whole site",
    capabilities: [capability], observedReadCapabilityIds: [capability.id]
  }).status, "unresolved", "visible records cannot prove a site-wide cheapest result");
});

test("local sort and select preserve typed output provenance and partial completeness", () => {
  const source = partialOutput();
  const parsed = parseVisibleRecordTransformation("Give me the two cheapest visible products", source.schema.items);
  assert.equal(parsed.status, "resolved");
  const result = applyVisibleRecordTransformations(source, parsed.plan);
  assert.deepEqual(result.records.map(record => record.name), ["Widget B", "Widget C"]);
  assert.deepEqual(result.fieldProvenance.map(item => item.recordIndex), [0, 1]);
  assert.equal(result.completeness, "observed_partial");
  assert.equal(result.transformation.sourceCompleteness, "observed_partial");
  assert.equal(verifyObservedPartialExtractionResult(result).status, "valid_observed_partial");
  assert.equal(source.records[0].name, "Widget C", "the transformation leaves its input untouched");
});

test("local currency sort refuses mixed units and count reports visible scope", () => {
  const source = partialOutput();
  source.records[1].price = "€2.00";
  const parsed = parseVisibleRecordTransformation("Show the cheapest visible products", source.schema.items);
  assert.throws(() => applyVisibleRecordTransformations(source, parsed.plan), /mixed or ambiguous units/);
  const counted = parseVisibleRecordTransformation("How many visible products are shown", partialOutput().schema.items);
  assert.deepEqual(counted.plan.operations, [{ op: "count_records" }]);
  const result = applyVisibleRecordTransformations(partialOutput(), counted.plan);
  assert.deepEqual(result.summary, { count: 3, scope: "visible_records" });
  assert.equal(result.completeness, "observed_partial");
});
