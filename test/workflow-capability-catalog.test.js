import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowCapabilityCatalog } from "../src/navigation/workflowCapabilityCatalog.js";

const navigationCapability = overrides => ({
  id: "open_record_details",
  action: "click",
  effectClass: "navigation",
  intentBinding: "generic_navigation",
  targetRole: "record_details_link",
  purposeCodes: ["open_record"],
  preconditionCodes: ["observed_authorized_target"],
  postconditionCodes: ["details_page"],
  observedRoles: ["link"],
  verificationCodes: ["details_route_observed"],
  ...overrides
});

test("workflow capability catalog keeps trusted handlers local and returns a model-safe projection", () => {
  const resolveTarget = () => ["candidate_details"];
  const verify = () => ({ status: "verified" });
  const catalog = compileWorkflowCapabilityCatalog([navigationCapability({ resolveTarget, verify })]);
  const normalized = catalog.byId.get("open_record_details");

  assert.equal(normalized.resolveTarget, resolveTarget);
  assert.equal(normalized.verify, verify);
  assert.equal(catalog.projection[0].dynamicResolution, true);
  assert.equal("resolveTarget" in catalog.projection[0], false);
  assert.equal("verify" in catalog.projection[0], false);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(catalog.projection[0].purposeCodes));
});

test("workflow capability catalog rejects duplicate IDs and mutating capabilities without trusted operation IDs", () => {
  const capability = navigationCapability();
  assert.throws(() => compileWorkflowCapabilityCatalog([capability, capability]), /duplicated/);
  assert.throws(() => compileWorkflowCapabilityCatalog([navigationCapability({
    action: "click",
    effectClass: "shared_mutation",
    intentBinding: "caller_required",
    observedRoles: ["button"]
  })]), /requires a trusted operation id/);
});

test("workflow capability catalog validates extraction schema and bounded catalog size", () => {
  const extraction = navigationCapability({
    id: "read_products",
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "product_collection",
    observedRoles: [],
    observedTags: [],
    resolveTarget: undefined,
    execute() {},
    outputSchema: [{ name: "price", type: "string", required: true }]
  });
  const compiled = compileWorkflowCapabilityCatalog([extraction]);
  assert.deepEqual(compiled.byId.get("read_products").outputSchema, [{ name: "price", type: "string", required: true }]);
  assert.throws(() => compileWorkflowCapabilityCatalog([navigationCapability(), ...Array(64).fill(navigationCapability())]), /bounded trusted capability catalog/);
  assert.throws(() => compileWorkflowCapabilityCatalog([navigationCapability({
    id: "read_products",
    action: "extract",
    effectClass: "read",
    intentBinding: "caller_required",
    targetRole: "product_collection",
    observedRoles: [],
    observedTags: [],
    resolveTarget: undefined,
    execute() {},
    outputSchema: [{ name: "Bad field", type: "string", required: true }]
  })]), /invalid output schema/);
});
