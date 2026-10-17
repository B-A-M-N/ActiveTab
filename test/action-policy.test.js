import test from "node:test";
import assert from "node:assert/strict";
import { authorizePlannedAction } from "../src/navigation/actionPolicy.js";
import { clickObservedElement } from "../src/navigation/observedAction.js";

test("sensitive controls require matching intent in the caller goal", () => {
  const order = { name: "Place order", role: "button" };
  assert.equal(authorizePlannedAction("Open checkout page", order).authorized, false);
  assert.equal(authorizePlannedAction("Buy the headphones", order).authorized, true);
  assert.equal(authorizePlannedAction("Find the delete account control", { name: "Delete account" }).authorized, false);
  assert.equal(authorizePlannedAction("Delete my account", { name: "Delete account" }).authorized, true);
  assert.equal(authorizePlannedAction("Open dashboard", { name: "Send money", role: "button" }).authorized, false);
});

test("form submission requires an explicit matching caller intent", () => {
  assert.equal(authorizePlannedAction("Search for blue shoes", { name: "Search", submitsForm: true }).authorized, true);
  assert.equal(authorizePlannedAction("Open checkout page", { name: "Continue", submitsForm: true }).authorized, false);
  assert.equal(authorizePlannedAction("Submit the application", { name: "Submit", submitsForm: true }).authorized, true);
});

test("text entry is restricted to an explicit caller search phrase in a visible native search input", () => {
  const searchField = { tag: "input", type: "search", role: "searchbox", visible: true };
  assert.equal(authorizePlannedAction("Search for blue shoes", searchField, "type").authorized, true);
  assert.equal(authorizePlannedAction("Open the dashboard", searchField, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, type: "password" }, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, visible: false }, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, frameTargetId: "child" }, "type").authorized, false);
});

test("scrolling is limited to visible regions reported as scrollable by the current observation", () => {
  const target = { kind: "container", visible: true, canScrollDown: true };
  assert.deepEqual(authorizePlannedAction("Open invoice 24 page", target, "scroll"), { authorized: true, category: "navigation_scroll" });
  assert.equal(authorizePlannedAction("Open invoice 24 page", { ...target, canScrollDown: false }, "scroll").authorized, false);
  assert.equal(authorizePlannedAction("Open invoice 24 page", { ...target, visible: false }, "scroll").authorized, false);
});


test("external visual selection clicks only an identity still present in fresh authorized evidence", async () => {
  const selected = { identity: "current-target", name: "Open billing history", role: "button", tag: "button", visible: true, targetId: "tab-1", backendNodeId: 4, documentGeneration: 2 };
  const session = {
    clicks: 0,
    observer: {
      getEvidence(evidenceId, options) {
        assert.equal(evidenceId, "visual-evidence");
        assert.deepEqual(options, { facets: ["selectedElement"], backendNodeId: 4, frameTargetId: null });
        return { status: "available", selectedElement: selected };
      }
    },
    async observe() { return { evidenceId: "fresh-observation", page: { url: "https://shop.example.test/", title: "Invoices" }, headings: [], candidates: [selected] }; },
    async click(target) { this.clicks++; assert.equal(target.identity, selected.identity); }
  };
  const result = await clickObservedElement(session, { goal: "Open the billing history page", evidenceId: "visual-evidence", backendNodeId: 4 });
  assert.equal(result.status, "action_dispatched");
  assert.equal(result.verificationRequired, true);
  assert.equal(session.clicks, 1);
});

test("external visual selection rejects stale identities and sensitive actions before click", async () => {
  const selected = { identity: "old-identity", name: "Place order", role: "button", tag: "button", visible: true, targetId: "tab-1", backendNodeId: 4, documentGeneration: 2, submitsForm: true };
  const session = {
    clicks: 0,
    observer: { getEvidence: () => ({ status: "available", selectedElement: selected }) },
    async observe() { return { evidenceId: "fresh-observation", page: { url: "https://shop.example.test/checkout", title: "Checkout" }, headings: [], candidates: [{ ...selected, identity: "new-identity" }] }; },
    async click() { this.clicks++; }
  };
  const stale = await clickObservedElement(session, { goal: "Buy the item", evidenceId: "old-evidence", backendNodeId: 4 });
  assert.equal(stale.status, "stale_target");
  assert.equal(session.clicks, 0);

  session.observe = async () => ({ evidenceId: "fresh-checkout", page: { url: "https://shop.example.test/checkout", title: "Checkout" }, headings: [], candidates: [{ ...selected }] });
  const blocked = await clickObservedElement(session, { goal: "Open the checkout page", evidenceId: "old-evidence", backendNodeId: 4 });
  assert.equal(blocked.status, "needs_human");
  assert.equal(blocked.category, "purchase");
  assert.equal(session.clicks, 0);
});
