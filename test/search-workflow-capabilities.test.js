import test from "node:test";
import assert from "node:assert/strict";
import { createObservedSearchWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { searchReadRequestFromGoal } from "../src/navigation/search.js";

const origin = "https://search.example";
const targetId = "search-tab";
const documentGeneration = 4;

function field(overrides = {}) {
  return {
    identity: "query-field",
    backendNodeId: 11,
    targetId,
    documentGeneration,
    tag: "input",
    type: "search",
    role: "searchbox",
    name: "Search",
    formIdentity: "search-form",
    formMethod: "get",
    formActionOrigin: origin,
    formTargetSameContext: true,
    visible: true,
    disabled: false,
    readOnly: false,
    ...overrides
  };
}

function submitter(overrides = {}) {
  return {
    identity: "submit-search",
    backendNodeId: 12,
    targetId,
    documentGeneration,
    tag: "button",
    role: "button",
    name: "Search",
    formIdentity: "search-form",
    formMethod: "get",
    formActionOrigin: origin,
    formTargetSameContext: true,
    submitsForm: true,
    visible: true,
    disabled: false,
    ...overrides
  };
}

function observation({ evidenceId = "before", url = `${origin}/`, candidates = [field(), submitter()], title = "Search" } = {}) {
  return {
    evidenceId,
    targetId,
    documentGeneration,
    page: { url, title },
    headings: [{ level: 1, text: title }],
    candidates
  };
}

function session(overrides = {}) {
  return {
    attached: true,
    target: { id: targetId },
    documentGeneration,
    async verifyControlValue(_target, value) { return { verified: true, matches: value === "graphics cards" }; },
    async verifySearchOutcome(value) { return value === "graphics cards"; },
    ...overrides
  };
}

test("search-read parser preserves the exact bounded caller query and rejects extra operations", () => {
  assert.deepEqual(searchReadRequestFromGoal('Search for "graphics  cards" and return their prices'), {
    query: "graphics  cards",
    resultRequest: "their prices"
  });
  assert.equal(searchReadRequestFromGoal("Search for graphics cards and filter by NVIDIA and return prices"), null);
  assert.equal(searchReadRequestFromGoal("Search for graphics cards and summarize the cheapest results"), null);
  assert.equal(searchReadRequestFromGoal("Search for graphics cards and open the first result"), null);
  assert.equal(searchReadRequestFromGoal("Search for graphics cards and return all prices"), null);
  assert.equal(searchReadRequestFromGoal("Search for graphics cards and return the best prices"), null);
});

test("observed search capabilities require one fresh same-origin GET field and its unique submitter", async () => {
  const before = observation();
  const capabilities = createObservedSearchWorkflowCapabilities({
    observation: before,
    session: session(),
    inputRef: "activetab_search_query",
    query: "graphics cards"
  });

  assert.equal(capabilities.length, 2);
  const [fill, submit] = capabilities;
  assert.equal(fill.requiredInputRef, "activetab_search_query");
  assert.equal(fill.effectClass, "read");
  assert.deepEqual(fill.resolveTarget(before), ["query-field"]);
  assert.deepEqual(submit.resolveTarget(before), ["submit-search"]);
  assert.equal(submit.hasVerifiedSearchSubmission(), false);

  const afterFill = observation({ evidenceId: "after-fill" });
  const fillProof = await fill.verify({
    verificationCode: "exact_search_query_observed",
    beforeObservation: before,
    afterObservation: afterFill,
    target: field(),
    inputValue: "graphics cards"
  });
  assert.equal(fillProof.status, "verified");
  assert.deepEqual(fillProof.evidenceRefs, ["before", "after-fill"]);

  const afterSearch = observation({ evidenceId: "after-search", url: `${origin}/?q=graphics+cards`, title: "Search results" });
  const searchProof = await submit.verify({
    verificationCode: "search_results_observed",
    beforeObservation: before,
    afterObservation: afterSearch,
    target: submitter()
  });
  assert.equal(searchProof.status, "verified");
  assert.deepEqual(searchProof.evidenceRefs, ["before", "after-search"]);
  assert.equal(submit.hasVerifiedSearchSubmission(), true);
});

test("search capability construction fails closed on ambiguity, missing GET binding, and cross-origin forms", () => {
  const create = candidates => createObservedSearchWorkflowCapabilities({
    observation: observation({ candidates }),
    session: session(),
    inputRef: "activetab_search_query",
    query: "graphics cards"
  });

  assert.equal(create([field(), { ...field(), identity: "second-field", backendNodeId: 13 }, submitter()]).length, 0);
  assert.equal(create([field(), submitter(), { ...submitter(), identity: "second-submit", backendNodeId: 14 }]).length, 0);
  assert.equal(create([field({ formMethod: "post" }), submitter({ formMethod: "post" })]).length, 0);
  assert.equal(create([field({ formActionOrigin: "https://other.example" }), submitter({ formActionOrigin: "https://other.example" })]).length, 0);
  assert.equal(create([field(), submitter({ formTargetSameContext: false })]).length, 0);
  assert.equal(create([field({ frameTargetId: "oopif-1" }), submitter({ frameTargetId: "oopif-1" })]).length, 0);
});

test("search capability construction requires the exact fresh target and caller input reference", () => {
  const before = observation();
  const base = { observation: before, session: session(), inputRef: "activetab_search_query", query: "graphics cards" };
  assert.equal(createObservedSearchWorkflowCapabilities({ ...base, inputRef: "Not-A-Ref" }).length, 0);
  assert.equal(createObservedSearchWorkflowCapabilities({ ...base, session: session({ documentGeneration: 3 }) }).length, 0);
  assert.equal(createObservedSearchWorkflowCapabilities({ ...base, session: session({ target: { id: "other-tab" } }) }).length, 0);
  assert.equal(createObservedSearchWorkflowCapabilities({ ...base, observation: observation({ url: "https://user:pass@search.example/" }) }).length, 0);
});
