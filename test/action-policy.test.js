import test from "node:test";
import assert from "node:assert/strict";
import { authorizePlannedAction } from "../src/navigation/actionPolicy.js";
import { clickObservedElement } from "../src/navigation/observedAction.js";

const fixtureLease = async () => {};

test("natural-language goals and control labels never classify effects", () => {
  const button = { name: "Place order", role: "button", tag: "button", visible: true };
  for (const goal of ["Open checkout", "Buy the headphones", "Delete my account"]) {
    const decision = authorizePlannedAction(goal, button);
    assert.equal(decision.authorized, false);
    assert.equal(decision.category, "unknown_control_effect");
  }

  const submit = { ...button, submitsForm: true };
  for (const goal of ["Search for blue shoes", "Open checkout", "Submit the application"]) {
    const decision = authorizePlannedAction(goal, submit);
    assert.equal(decision.authorized, false);
    assert.equal(decision.category, "unclassified_form_submission");
  }
});

test("passive links and observed disclosure controls have structural, bounded admission", () => {
  assert.deepEqual(authorizePlannedAction("arbitrary caller text", {
    name: "Billing history", role: "link", tag: "a", href: "/billing/history", visible: true
  }), { authorized: true, category: "passive_navigation" });
  assert.deepEqual(authorizePlannedAction("arbitrary caller text", {
    name: "Open menu", role: "button", tag: "button", visible: true,
    attributes: { "aria-expanded": "false" }
  }), { authorized: true, category: "ui_disclosure" });
  assert.equal(authorizePlannedAction("Open dashboard", {
    name: "Send money", role: "button", tag: "button", visible: true
  }).authorized, false);
});

test("text entry is limited to a visible native search input without relying on goal wording", () => {
  const searchField = { tag: "input", type: "search", role: "searchbox", visible: true };
  assert.equal(authorizePlannedAction("Open the dashboard", searchField, "type").authorized, true);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, type: "password" }, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, visible: false }, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, frameTargetId: "child" }, "type").authorized, false);
  assert.equal(authorizePlannedAction("Search for blue shoes", { ...searchField, disabled: true }, "type").authorized, false);
});

test("scrolling is limited to visible regions reported as scrollable by the current observation", () => {
  const target = { kind: "container", visible: true, canScrollDown: true };
  assert.deepEqual(authorizePlannedAction("Open invoice 24 page", target, "scroll"), { authorized: true, category: "navigation_scroll" });
  assert.equal(authorizePlannedAction("Open invoice 24 page", { ...target, canScrollDown: false }, "scroll").authorized, false);
  assert.equal(authorizePlannedAction("Open invoice 24 page", { ...target, visible: false }, "scroll").authorized, false);
});

test("external visual selection clicks only an identity still present in fresh authorized evidence", async () => {
  const selected = { identity: "current-target", name: "Open billing history", role: "link", tag: "a", href: "/billing/history", visible: true, targetId: "tab-1", backendNodeId: 4, documentGeneration: 2 };
  const session = {
    target: { id: "tab-1", url: "https://shop.example.test/" },
    attached: true,
    clicks: 0,
    observer: {
      getEvidence(evidenceId, options) {
        if (evidenceId === "visual-evidence") {
          assert.deepEqual(options, { facets: ["selectedElement"], backendNodeId: 4, frameTargetId: null });
          return { status: "available", selectedElement: selected };
        }
        if (evidenceId === "fresh-observation") {
          assert.deepEqual(options, { facets: ["page"], includeSensitiveUrlData: true });
          return { status: "available", page: { url: "https://shop.example.test/" } };
        }
        return { status: "expired" };
      }
    },
    async observe() { return { evidenceId: "fresh-observation", targetId: "tab-1", page: { url: "https://shop.example.test/", title: "Invoices" }, headings: [], candidates: [selected] }; },
    async click(target) { this.clicks++; assert.equal(target.identity, selected.identity); }
  };
  const result = await clickObservedElement(session, { goal: "Open the billing history page", evidenceId: "visual-evidence", backendNodeId: 4, assertExecutionLease: fixtureLease });
  assert.equal(result.status, "action_dispatched");
  assert.equal(result.verificationRequired, true);
  assert.equal(session.clicks, 1);
});

test("external visual selection rejects stale identities and never authorizes a form submission from goal text", async () => {
  const selected = { identity: "old-identity", name: "Place order", role: "button", tag: "button", visible: true, targetId: "tab-1", backendNodeId: 4, documentGeneration: 2, submitsForm: true };
  const session = {
    target: { id: "tab-1", url: "https://shop.example.test/checkout" },
    attached: true,
    clicks: 0,
    observer: { getEvidence: () => ({ status: "available", selectedElement: selected }) },
    async observe() { return { evidenceId: "fresh-observation", targetId: "tab-1", page: { url: "https://shop.example.test/checkout", title: "Checkout" }, headings: [], candidates: [{ ...selected, identity: "new-identity" }] }; },
    async click() { this.clicks++; }
  };
  const stale = await clickObservedElement(session, { goal: "Buy the item", evidenceId: "old-evidence", backendNodeId: 4, assertExecutionLease: fixtureLease });
  assert.equal(stale.status, "stale_target");
  assert.equal(session.clicks, 0);

  session.observe = async () => ({ evidenceId: "fresh-checkout", targetId: "tab-1", page: { url: "https://shop.example.test/checkout", title: "Checkout" }, headings: [], candidates: [{ ...selected }] });
  const blocked = await clickObservedElement(session, { goal: "Submit the approved order", evidenceId: "old-evidence", backendNodeId: 4, assertExecutionLease: fixtureLease });
  assert.equal(blocked.status, "needs_human");
  assert.equal(blocked.category, "unclassified_form_submission");
  assert.equal(session.clicks, 0);
});
