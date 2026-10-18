import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverStagingAdminConsole } from "../src/testing/stagingAdminConsoleDiscovery.js";
import { discoverStagingAdminConfig } from "../src/testing/stagingAdminConfigDiscovery.js";
import { inspectAdminSurface, inspectAndRestoreDisclosure } from "../src/testing/adminDashboardDiscovery.js";
import { isOperatorProhibitedNavigation, isOperatorProhibitedControl } from "../src/runtime/controlRestrictions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [accountProfile, cloudProfile] = await Promise.all([
  readFile(join(root, "profiles/freeinference-staging.json"), "utf8").then(JSON.parse),
  readFile(join(root, "profiles/cloud-agent-staging.json"), "utf8").then(JSON.parse)
]);

const environment = {
  environmentId: "freeinference-staging",
  authorizedOrigins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"]
};

function element(tagName, properties = {}) {
  const attrs = properties.attrs ?? {};
  return {
    tagName: tagName.toUpperCase(),
    type: properties.type ?? "",
    name: properties.name ?? "",
    get value() {
      if (properties.onValueRead) return properties.onValueRead();
      return properties.value ?? "";
    },
    checked: properties.checked ?? false,
    disabled: properties.disabled ?? false,
    innerText: properties.text ?? "",
    textContent: properties.text ?? "",
    title: properties.title ?? "",
    className: properties.className ?? "",
    labels: properties.labels ?? [],
    options: properties.options ?? [],
    selectedOptions: properties.selectedOptions ?? [],
    getAttribute(name) { return attrs[name] ?? null; },
    getBoundingClientRect() { return { width: 100, height: 24 }; },
    closest(selector) { return properties.insideTable ? {} : null; },
    querySelectorAll(selector) { return (properties.queries ?? {})[selector] ?? []; }
  };
}

function fixtureDocument(queryMap, { title = "Admin" } = {}) {
  return {
    title,
    querySelectorAll(selector) { return queryMap[selector] ?? []; },
    getElementById() { return null; }
  };
}

function runtimeSession({ url, document, location = new URL(url), networkRequests = [] }) {
  const calls = [];
  const client = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method !== "Runtime.evaluate") throw new Error(`Unexpected CDP method ${method}`);
      const expression = params.expression;
      if (expression === "location.href") return { result: { value: url } };
      if (expression === "({origin:location.origin,pathname:location.pathname})") {
        return { result: { value: { origin: location.origin, pathname: location.pathname } } };
      }
      const value = runInNewContext(expression, {
        document,
        location: { origin: location.origin, pathname: location.pathname },
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
      });
      return { result: { value } };
    }
  };
  return {
    attached: true,
    client,
    calls,
    latestEvidenceId: "fixture-evidence",
    activity: { snapshot: () => ({ networkRequests }) }
  };
}

const plain = value => JSON.parse(JSON.stringify(value));

test("account Admin Console inventory reads only the exact Users route structure", async () => {
  const headers = ["User", "Status", "Today", "Month", "All-time", "Requests", "Tokens"]
    .map(text => element("th", { text }));
  const table = element("table", { queries: { 'thead th,[role="columnheader"]': headers } });
  const safeButtons = accountProfile.admin_console_discovery.safe_button_labels
    .map(text => element("button", { text }));
  safeButtons.push(element("button", { text: "Clear Last Hours" }));
  const controls = [
    ...safeButtons,
    element("input", { type: "search", attrs: { placeholder: "Search email, key prefix, id..." } }),
    element("input", { type: "text", value: "private-user@example.test", insideTable: true })
  ];
  const document = fixtureDocument({
    'table,[role="grid"]': [table],
    "button,input,select,textarea": controls,
    "h1,h2": [element("h1", { text: "Admin" })]
  });
  const session = runtimeSession({ url: "https://staging.freeinference.org/dashboard/admin/users", document });

  const report = await discoverStagingAdminConsole({ session, environment, profile: accountProfile });

  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(report.tables[0].columns, ["User", "Status", "Today", "Month", "All-time", "Requests", "Tokens"]);
  assert.equal(report.controls.some(control => control.label === "Clear Last Hours"), false);
  assert.equal(JSON.stringify(report).includes("private-user@example.test"), false);
  assert.equal(report.privacy.userRowsCaptured, false);
  assert.equal(report.privacy.actionsDispatched, false);
  assert.deepEqual(session.calls.map(call => call.method), ["Runtime.evaluate", "Runtime.evaluate"]);
});

test("account Admin Console Audit Log is refused before page metadata is read", async () => {
  const session = runtimeSession({
    url: "https://staging.freeinference.org/dashboard/admin/audit-log",
    document: fixtureDocument({})
  });

  const report = await discoverStagingAdminConsole({ session, environment, profile: accountProfile });

  assert.equal(report.status, "BLOCKED");
  assert.match(report.reason, /exact profile-declared Admin Console route/);
  assert.equal(session.calls.length, 1);
  assert.equal(isOperatorProhibitedNavigation("https://staging.freeinference.org/dashboard/admin/audit-log"), true);
  assert.equal(isOperatorProhibitedNavigation("https://agents-staging.freeinference.org/admin/audit"), false);
});

test("account Settings inventory never reads field values or operates controls", async () => {
  const toggle = element("input", {
    type: "checkbox", checked: true, attrs: { type: "checkbox", "aria-label": "User Auth Enabled" }
  });
  const token = element("input", {
    type: "password", onValueRead() { throw new Error("password field value was read"); }, attrs: { type: "password", "aria-label": "Admin API token" }
  });
  const field = element("input", {
    type: "text", onValueRead() { throw new Error("text field value was read"); }, attrs: { type: "text", "aria-label": "Contact email" }
  });
  const document = fixtureDocument({
    'h1,h2,h3': [element("h1", { text: "Settings" })],
    'button,input,select,textarea,[role="switch"],[role="checkbox"],[role="radio"]': [toggle, token, field]
  });
  const session = runtimeSession({ url: "https://staging.freeinference.org/dashboard/admin/settings", document });

  const report = await discoverStagingAdminConfig({ session, environment, profile: accountProfile, evidenceSource: "synthetic_fixture" });

  assert.equal(report.status, "COMPLETE");
  assert.equal(report.evidence.source, "synthetic_fixture");
  assert.equal(report.surface, "Settings");
  assert.deepEqual(report.controls.map(control => control.label), ["User Auth Enabled", "Admin API token", "Contact email"]);
  assert.equal(report.controls[0].checked, true);
  assert.equal(Object.hasOwn(report.controls[1], "currentValue"), false);
  assert.equal(Object.hasOwn(report.controls[2], "currentValue"), false);
  assert.equal(report.controls[1].sensitiveControl, true);
  assert.equal(report.privacy.freeTextControlValuesRead, false);
  assert.equal(report.privacy.sensitiveControlValuesRead, false);
  assert.equal(report.privacy.controlsOperated, false);
  assert.deepEqual(session.calls.map(call => call.method), ["Runtime.evaluate", "Runtime.evaluate", "Runtime.evaluate"]);
});

test("Settings inventory refuses the account Audit Log before reading controls", async () => {
  const session = runtimeSession({
    url: "https://staging.freeinference.org/dashboard/admin/audit",
    document: fixtureDocument({})
  });

  const report = await discoverStagingAdminConfig({ session, environment, profile: accountProfile, evidenceSource: "synthetic_fixture" });

  assert.equal(report.status, "BLOCKED");
  assert.equal(session.calls.length, 1);
});

test("Settings inventory refuses to produce a report without evidence provenance", async () => {
  const session = runtimeSession({
    url: "https://staging.freeinference.org/dashboard/admin/settings",
    document: fixtureDocument({ 'h1,h2,h3': [element("h1", { text: "Settings" })] })
  });

  const report = await discoverStagingAdminConfig({ session, environment, profile: accountProfile });

  assert.equal(report.status, "BLOCKED");
  assert.equal(session.calls.length, 0);
});

test("Cloud Agent Admin inventory records dropdown schemas and scoped GET route shapes", async () => {
  const options = ["All Operations", "Sandbox Startup", "Terminal Opening", "File Listing", "File Opening"]
    .map(text => element("option", { text }));
  const select = element("select", {
    attrs: { "aria-label": "Operation" }, options, selectedOptions: [options[0]]
  });
  const tableHeaders = ["Operation", "Server", "Duration"].map(text => element("th", { text }));
  const table = element("table", { queries: { "thead th": tableHeaders } });
  const document = fixtureDocument({
    "h1,h2,h3,h4": [element("h1", { text: "Measurements" })],
    "select": [select],
    'input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="switch"]': [],
    'input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea': [],
    "table": [table],
    "button,[role=button],[role=tab]": []
  });
  const requests = [
    { method: "GET", url: "https://agents-staging.freeinference.org/api/admin/agent/measurements/12345", status: 200, mimeType: "application/json" },
    { method: "GET", url: "https://agents-staging.freeinference.org/api/admin/agent/measurements/12345?token=secret", status: 200, mimeType: "application/json" },
    { method: "POST", url: "https://agents-staging.freeinference.org/api/admin/agent/measurements", status: 201 },
    { method: "GET", url: "https://agents-staging.freeinference.org/api/admin/agent/other", status: 200 },
    { method: "GET", url: "https://untrusted.example/api/admin/agent/measurements", status: 200 }
  ];
  const session = runtimeSession({
    url: "https://agents-staging.freeinference.org/admin/measurements",
    document,
    networkRequests: requests
  });

  const metadata = await inspectAdminSurface({ session, profile: cloudProfile, apiCursor: 0 });

  assert.deepEqual(plain(metadata.headings), ["Measurements"]);
  assert.deepEqual(plain(metadata.selects[0].options), ["All Operations", "Sandbox Startup", "Terminal Opening", "File Listing", "File Opening"]);
  assert.deepEqual(plain(metadata.tables[0].columns), ["Operation", "Server", "Duration"]);
  assert.deepEqual(plain(metadata.observedGetRoutes), [{
    method: "GET", path: "/api/admin/agent/measurements/:id", status: 200, contentType: "application/json", count: 2
  }, {
    method: "GET", path: "/api/admin/agent/other", status: 200, contentType: "unknown", count: 1
  }]);
  assert.equal(session.calls.filter(call => call.method !== "Runtime.evaluate").length, 0);
});

test("Cloud Agent Audit disclosure opens for inspection and restores its original collapsed state", async () => {
  let expanded = "false";
  const clicks = [];
  const candidate = {
    name: "View row details", role: "button", visible: true, disabled: false,
    submitsForm: false, backendNodeId: 44, tag: "button",
    get attributes() { return { "aria-expanded": expanded }; },
    documentUrl: "https://agents-staging.freeinference.org/admin/audit"
  };
  const session = {
    attached: true,
    async observe() {
      return { page: { url: candidate.documentUrl }, candidates: [{ ...candidate, attributes: candidate.attributes }] };
    },
    async click(target) {
      clicks.push(target.backendNodeId);
      expanded = expanded === "true" ? "false" : "true";
      return { dispatched: true };
    },
    client: {
      async send(method) {
        if (method === "DOM.resolveNode") return { object: { objectId: "fixture-node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: expanded } };
        if (method === "Runtime.releaseObject") return {};
        throw new Error(`Unexpected CDP method ${method}`);
      }
    }
  };
  let inspectedWhileOpen = false;

  const result = await inspectAndRestoreDisclosure({
    session,
    environment,
    candidate,
    onExpanded: async () => {
      inspectedWhileOpen = expanded === "true";
      return { columns: ["Event", "Timestamp"], observedGetRoutes: ["/api/admin/agent/audit/:id"] };
    }
  });

  assert.equal(result.inspected, true);
  assert.equal(result.restored, true);
  assert.deepEqual(clicks, [44, 44]);
  assert.equal(inspectedWhileOpen, true);
  assert.equal(expanded, "false");
  assert.deepEqual(result.detail.columns, ["Event", "Timestamp"]);
});

test("operator hard denials remain scoped to account controls and never authorize destructive buttons", () => {
  assert.equal(isOperatorProhibitedControl({ name: "Clear Last Hours", documentUrl: "https://staging.freeinference.org/dashboard/admin/requests" }), true);
  for (const name of ["Manage", "Edit", "Add", "Delete Keys"]) {
    assert.equal(isOperatorProhibitedControl({ name, contextName: "Providers", documentUrl: "https://staging.freeinference.org/dashboard/admin/providers" }), true);
  }
  assert.equal(isOperatorProhibitedNavigation("https://agents-staging.freeinference.org/admin/audit"), false);
});
