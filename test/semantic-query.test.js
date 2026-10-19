import test from "node:test";
import assert from "node:assert/strict";
import { parseSemanticQuery } from "../src/query/queryParser.js";
import { resolveSemanticQuery } from "../src/navigation/semanticAnalyzer.js";

function semanticPage() {
  return {
    schemaVersion: 3,
    evidence: { observationId: "obs-1", targetId: "tab-1", documentGeneration: 7 },
    page: { origin: "https://catalog.example" },
    regions: [{ ref: "region-main", kind: "main", tag: "main", label: { value: "Catalog" } }],
    forms: [{ ref: "form-search", method: "get", controlRefs: ["control-search"] }],
    controls: [{
      targetRef: "control-search", frameId: "frame-1", role: "searchbox", tag: "input",
      identityEvidence: "fresh_dom_accessibility_candidate", label: { value: "Search products" },
      regionRef: "region-main", formRef: "form-search"
    }],
    collections: [{
      ref: "products", kind: "microdata_product", completeness: "unknown", itemsTruncated: false,
      fields: [
        { name: "name", semanticRole: "name", semanticRoleStatus: "observed", sourceKey: "name", status: "observed" },
        { name: "price", semanticRole: "price", semanticRoleStatus: "observed", sourceKey: "price", status: "observed" }
      ],
      items: [
        { ref: "record-1", fields: [
          { name: "name", semanticRole: "name", sourceKey: "name", sourceTag: "span", value: "Widget A", status: "observed", valueRef: "obs-1:node-11" },
          { name: "price", semanticRole: "price", sourceKey: "price", sourceTag: "span", value: "10.50", status: "observed", valueRef: "obs-1:node-12" }
        ] },
        { ref: "record-2", fields: [
          { name: "name", semanticRole: "name", sourceKey: "name", sourceTag: "span", value: "Widget B", status: "observed", valueRef: "obs-1:node-21" },
          { name: "price", semanticRole: "price", sourceKey: "price", sourceTag: "span", value: "20.00", status: "observed", valueRef: "obs-1:node-22" }
        ] }
      ]
    }]
  };
}

const policy = { authorizeField: () => true, authorizeRelease: () => true };

test("bounded structured semantic queries parse scalar fields and reject unsupported syntax", () => {
  assert.deepEqual(parseSemanticQuery("{ products[] { name price(number) availability } }"), {
    kind: "collection", name: "products", fields: [
      { name: "name", kind: "scalar", type: "string" },
      { name: "price", kind: "scalar", type: "number" },
      { name: "availability", kind: "scalar", type: "string" }
    ]
  });
  assert.throws(() => parseSemanticQuery("{ products[] { name price(object) } }"), /unsupported/u);
  assert.throws(() => parseSemanticQuery("{ products[] { name name } }"), /duplicated/u);
  assert.throws(() => parseSemanticQuery("{ products[] { name; window } }"), /unsupported syntax/u);
});

test("local semantic data queries return typed values and evidence references after trusted policy checks", () => {
  const result = resolveSemanticQuery(semanticPage(), "{ products[] { name price(number) } }", policy);
  assert.equal(result.status, "available");
  assert.equal(result.completeness, "observed_partial");
  assert.deepEqual(result.records.map(record => record.values), [
    { name: "Widget A", price: 10.5 },
    { name: "Widget B", price: 20 }
  ]);
  assert.equal(result.records[0].provenance.price.observationId, "obs-1");
  assert.equal(result.records[0].provenance.price.resolutionState, "normalized");
  assert.equal(Object.hasOwn(result.records[0].provenance.price, "raw"), false);
});

test("semantic data queries fail closed on missing policy, denied fields, stale evidence, and invalid types", () => {
  const page = semanticPage();
  assert.equal(resolveSemanticQuery(page, "{ products[] { name } }").reasonCode, "trusted_field_read_and_release_policy_required");
  assert.equal(resolveSemanticQuery(page, "{ products[] { name } }", {
    authorizeField: () => true, authorizeRelease: () => false
  }).reasonCode, "field_read_or_release_denied");
  assert.equal(resolveSemanticQuery(page, "{ products[] { name } }", {
    ...policy,
    expectedEvidence: { observationId: "old", targetId: "tab-1", documentGeneration: 7 }
  }).status, "stale_or_unavailable");
  page.collections[0].items[0].fields[1].value = "$10.50";
  const invalid = resolveSemanticQuery(page, "{ products[] { price(number) } }", policy);
  assert.equal(invalid.status, "incomplete");
  assert.equal(invalid.records[0].values.price, null);
  assert.equal(invalid.records[0].provenance.price.resolutionState, "invalid");

  const duplicate = semanticPage();
  duplicate.collections[0].fields.push({
    name: "salePrice", semanticRole: "price", semanticRoleStatus: "inferred", sourceKey: "sale_price", status: "observed"
  });
  assert.equal(resolveSemanticQuery(duplicate, "{ products[] { price(number) } }", policy).reasonCode,
    "ambiguous_field_association");
  const forgedAst = { ...parseSemanticQuery("{ products[] { name } }"), targetRef: "page-invented-target" };
  assert.equal(resolveSemanticQuery(page, forgedAst, policy).reasonCode, "query_ast_invalid");
});

test("element queries return fresh target references without granting action authority", () => {
  const page = semanticPage();
  assert.deepEqual(parseSemanticQuery("find the search box in the main search form"), {
    kind: "element", role: "searchbox", description: "the search box", scope: "the main search form"
  });
  const result = resolveSemanticQuery(page, "find the search box in the main search form");
  assert.equal(result.status, "unique");
  assert.equal(result.target.targetRef, "control-search");
  assert.equal(result.actionAuthorized, false);
  page.controls.push({ ...page.controls[0], targetRef: "control-search-2" });
  assert.equal(resolveSemanticQuery(page, "find the search box in the main search form").status, "ambiguous");
});
