/**
 * Read-only Admin dashboard discovery, separate from Cloud Agent task flow.
 * Small primitives are composed by a profile-selected recipe. The scanner
 * never reads response bodies or free-text field values and never submits a
 * form, changes a setting, or queries a database table.
 */

import { executeAuthorizedAction } from "../runtime/authorizedExecutor.js";
import { verifyObservedUrl } from "../environments/model.js";
import { randomUUID } from "node:crypto";
import { withTargetExecutionLease } from "./runState.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const READ_GOAL = "Inspect the visible staging Admin dashboard for read-only diagnostics.";
const DISCLOSURE_GOAL = "Temporarily inspect one visible read-only record disclosure and restore its original state.";

function clean(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[redacted-email]")
    .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
    .replace(/\b(?:token|secret|password|credential|api[_ -]?key)\s*[:=]\s*[^\s,;]+/ig, "[redacted-secret]");
}

function locationOf(value, base) {
  try {
    const parsed = new URL(value, base);
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch { return null; }
}

function exactLink(observation, { labels, origin, pathname = null, pathPrefix = null }) {
  const accepted = new Set((labels ?? []).map(label => clean(label).toLocaleLowerCase()));
  return (observation?.candidates ?? []).find(candidate => {
    if (candidate.visible !== true || candidate.disabled === true || candidate.role !== "link" || !candidate.href) return false;
    if (!accepted.has(clean(candidate.name).toLocaleLowerCase())) return false;
    const destination = locationOf(candidate.href, observation?.page?.url);
    return destination?.origin === origin
      && (!pathname || destination.pathname === pathname)
      && (!pathPrefix || destination.pathname.startsWith(pathPrefix));
  }) ?? null;
}

function exactButton(observation, label) {
  const accepted = clean(label).toLocaleLowerCase();
  return (observation?.candidates ?? []).find(candidate =>
    candidate.visible === true && candidate.disabled !== true && ["button", "tab"].includes(candidate.role)
    && candidate.submitsForm !== true && clean(candidate.name).toLocaleLowerCase() === accepted
  ) ?? null;
}

async function selectionState(session, backendNodeId) {
  if (!Number.isInteger(backendNodeId)) return null;
  let objectId;
  try {
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId });
    objectId = resolved.object?.objectId;
    if (!objectId) return null;
    const result = await session.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){const classes=String(this.className?.baseVal??this.className??'').split(/\\s+/);return {pressed:this.getAttribute('aria-pressed'),selected:this.getAttribute('aria-selected'),current:this.getAttribute('aria-current'),state:this.getAttribute('data-state'),activeClass:classes.some(name=>/^(?:active|selected|current|is-active|is-selected|tab-active|tab-selected)$/i.test(name))}}",
      returnByValue: true,
      awaitPromise: false
    });
    return result.result?.value ?? null;
  } catch { return null; }
  finally {
    if (objectId) await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

function isSelected(state) {
  return state?.pressed === "true" || state?.selected === "true"
    || state?.current === "page" || state?.current === "true"
    || state?.ariaPressed === "true" || state?.ariaSelected === "true"
    || state?.ariaCurrent === "page" || state?.ariaCurrent === "true"
    || ["active", "selected", "current"].includes(String(state?.state ?? state?.dataState ?? "").toLowerCase())
    || state?.activeClass === true;
}

function selectedControlLabel(states, allowedLabels = null) {
  return (states ?? []).find(item =>
    (!allowedLabels || allowedLabels.includes(item.label)) && isSelected(item)
  )?.label ?? null;
}

async function findSelectedCandidate(session, candidates, allowedLabels, roles = ["button", "tab"]) {
  for (const item of candidates ?? []) {
    if (item.visible !== true || item.disabled === true || item.submitsForm === true
      || !roles.includes(item.role) || !allowedLabels.includes(item.name)) continue;
    if (isSelected(await selectionState(session, item.backendNodeId))) return item;
  }
  return null;
}

async function activateVisibleReadOnlyControl({ session, environment, origin, label, purpose, assertExecutionLease = null }) {
  const beforePage = await observeAuthorized(session, environment, origin);
  const candidate = exactButton(beforePage, label);
  if (!candidate) return { dispatched: false, verified: false, reason: "No exact visible non-submitting control was found." };
  const before = await selectionState(session, candidate.backendNodeId);
  const result = await executeAuthorizedAction({
    session, environment, goal: READ_GOAL + " " + purpose, action: "click", candidate, assertExecutionLease
  });
  if (!result.dispatched) return { dispatched: false, verified: false, reason: result.reason ?? "Authorized executor refused the control." };
  await pause(200);
  const afterPage = await observeAuthorized(session, environment, origin);
  const afterCandidate = (afterPage?.candidates ?? []).find(item =>
    item.visible === true && ["button", "tab"].includes(item.role)
    && item.disabled !== true && item.submitsForm !== true
    && clean(item.name).toLocaleLowerCase() === clean(label).toLocaleLowerCase()
  );
  const after = afterCandidate ? await selectionState(session, afterCandidate.backendNodeId) : null;
  return {
    dispatched: true,
    verified: isSelected(after),
    before,
    after,
    evidenceId: afterPage.evidenceId ?? null,
    observation: afterPage
  };
}

async function observeAuthorized(session, environment, expectedOrigin) {
  const observation = await session.observe();
  const identity = verifyObservedUrl(environment, observation?.page?.url);
  if (!identity.ok || identity.origin !== expectedOrigin) {
    throw new Error("Stopped at an unauthorized Admin origin: " + (identity.reason ?? identity.origin));
  }
  return observation;
}

async function observedLocation(session) {
  const response = await session.client.send("Runtime.evaluate", {
    expression: "({origin:location.origin,pathname:location.pathname})",
    returnByValue: true,
    awaitPromise: false
  });
  return response.result?.value ?? null;
}

/** Primitive: follow one exact visible link through the authorized executor. */
export async function followVisibleAdminLink({ session, environment, candidate, purpose = "open a read-only Admin view", assertExecutionLease = null }) {
  if (!candidate || candidate.role !== "link" || candidate.visible !== true || !candidate.href) {
    return { opened: false, reason: "A visible link candidate is required." };
  }
  const destination = locationOf(candidate.href, candidate.documentUrl);
  if (!destination || !environment.authorizedOrigins.includes(destination.origin)) {
    return { opened: false, reason: "The link destination is outside the authorized environment." };
  }
  const dispatched = await executeAuthorizedAction({
    session, environment, goal: READ_GOAL + " " + purpose, action: "click", candidate, assertExecutionLease
  });
  return dispatched.dispatched
    ? { opened: true, destination }
    : { opened: false, reason: dispatched.reason ?? "The authorized executor refused the link." };
}

function metadataExpression(approvedLabels) {
  function inspect(approved) {
    const visible = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    const norm = value => String(value || "").replace(/\s+/g, " ").trim();
    const scrub = value => norm(value).slice(0, 160)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[redacted-email]")
      .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
      .replace(/\b(?:token|secret|password|credential|api[_ -]?key)\s*[:=]\s*[^\s,;]+/ig, "[redacted-secret]");
    const labelFor = element => {
      const id = element.id;
      const linked = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
      const wrapping = element.closest("label");
      return scrub(element.getAttribute("aria-label") || linked?.innerText || wrapping?.innerText || element.title || element.name || "");
    };
    const headings = [...document.querySelectorAll("h1,h2,h3,h4")].filter(visible)
      .map(element => scrub(element.innerText || element.textContent)).filter(Boolean).slice(0, 24);
    const selects = [...document.querySelectorAll("select")].filter(visible).slice(0, 30).map(select => ({
      label: labelFor(select) || "[unlabeled select]",
      options: [...select.options].slice(0, 80).map(option => scrub(option.textContent)).filter(Boolean),
      selectedOption: scrub(select.selectedOptions?.[0]?.textContent || ""),
      optionCount: select.options.length
    }));
    const switches = [...document.querySelectorAll('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="switch"]')]
      .filter(visible).slice(0, 40).map(control => ({
        label: labelFor(control) || "[unlabeled control]",
        type: control.getAttribute("role") || control.type || "control",
        checked: control.getAttribute("aria-checked") === "true" || control.checked === true,
        disabled: control.disabled === true || control.getAttribute("aria-disabled") === "true"
      }));
    const textFields = [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]),textarea')]
      .filter(visible).slice(0, 40).map(field => ({
        label: labelFor(field) || "[unlabeled field]",
        type: field.type || field.tagName.toLowerCase(),
        valueRecorded: false,
        valueWithheld: true,
        disabled: field.disabled === true
      }));
    const tables = [...document.querySelectorAll("table")].slice(0, 8).map(table => ({
      columns: [...table.querySelectorAll("thead th")].map(cell => scrub(cell.innerText || cell.textContent)).filter(Boolean).slice(0, 40),
      rowCount: table.querySelectorAll("tbody tr").length
    }));
    const controls = [...document.querySelectorAll("button,[role=button],[role=tab]")].filter(visible)
      .map(element => scrub(element.getAttribute("aria-label") || element.title || element.innerText || element.textContent))
      .filter(label => approved.includes(label));
    const controlStates = [...document.querySelectorAll("button,[role=button],[role=tab]")].filter(visible).map(element => {
      const label = scrub(element.getAttribute("aria-label") || element.title || element.innerText || element.textContent);
      const classes = String(element.className?.baseVal ?? element.className ?? "").split(/\s+/);
      return {
        label,
        ariaPressed: element.getAttribute("aria-pressed"),
        ariaSelected: element.getAttribute("aria-selected"),
        ariaCurrent: element.getAttribute("aria-current"),
        dataState: element.getAttribute("data-state"),
        activeClass: classes.some(name => /^(?:active|selected|current|is-active|is-selected|tab-active|tab-selected)$/i.test(name))
      };
    }).filter(item => approved.includes(item.label)).slice(0, 100);
    const disclosures = [...document.querySelectorAll('button[aria-expanded],[role="button"][aria-expanded]')].filter(visible);
    return {
      pathname: location.pathname,
      headings,
      controlLabels: [...new Set(controls)].slice(0, 100),
      controlStates,
      selects,
      checkboxesAndSwitches: switches,
      textFields,
      tables,
      rowCount: Math.max(
        document.querySelectorAll("tbody tr,[role=row]").length,
        location.pathname === "/admin/audit" ? document.querySelectorAll("main button[aria-expanded],main [role=button][aria-expanded]").length : 0
      ),
      disclosureCount: disclosures.length,
      expandedDisclosureCount: disclosures.filter(element => element.getAttribute("aria-expanded") === "true").length
    };
  }
  return "(" + inspect.toString() + ")(" + JSON.stringify(approvedLabels) + ")";
}

/** Primitive: read page structure, control options/state, and observed GET route shapes. */
export async function inspectAdminSurface({ session, profile, apiCursor = 0 }) {
  const config = profile.staging_ui_diagnostics;
  const approvedLabels = [
    ...(config.known_controls ?? []), ...(config.known_options ?? []),
    ...(config.admin_link_labels ?? []), ...(config.settings_link_labels ?? []),
    ...(config.surfaces ?? []).flatMap(surface => [
      surface.surface_id, ...(surface.link_labels ?? []), ...(surface.tabs ?? []),
      ...(surface.audit_categories ?? []), ...(surface.expandable_sections ?? [])
    ])
  ];
  const result = await session.client.send("Runtime.evaluate", {
    expression: metadataExpression(approvedLabels), returnByValue: true, awaitPromise: false
  });
  const metadata = result.result?.value ?? {};
  const location = await observedLocation(session);
  const routes = new Map();
  for (const request of (session.activity?.snapshot?.().networkRequests ?? []).slice(apiCursor)) {
    if (request.method !== "GET" || !request.url) continue;
    let url;
    try { url = new URL(request.url); } catch { continue; }
    if (url.origin !== location?.origin || !url.pathname.startsWith(config.api_path_prefix)) continue;
    const path = url.pathname.split("/").map(segment =>
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || /^\d{4,}$/.test(segment) || segment.length > 80 ? ":id" : segment
    ).join("/");
    const key = [request.method, path, request.status ?? "pending", request.mimeType ?? "unknown"].join(" ");
    routes.set(key, (routes.get(key) ?? 0) + 1);
  }
  metadata.observedGetRoutes = [...routes.entries()].slice(0, 80).map(([key, count]) => {
    const [method, path, status, contentType] = key.split(" ");
    return { method, path, status: status === "pending" ? null : Number(status), contentType, count };
  });
  metadata.evidenceId = session.latestEvidenceId ?? null;
  return metadata;
}

async function disclosureState(session, backendNodeId) {
  if (!Number.isInteger(backendNodeId)) return null;
  let objectId;
  try {
    const resolved = await session.client.send("DOM.resolveNode", { backendNodeId });
    objectId = resolved.object?.objectId;
    if (!objectId) return null;
    const state = await session.client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return this.getAttribute('aria-expanded')}",
      returnByValue: true,
      awaitPromise: false
    });
    return state.result?.value ?? null;
  } catch { return null; }
  finally {
    if (objectId) await session.client.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function waitForDisclosureState(session, backendNodeId, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await disclosureState(session, backendNodeId);
    if (state === expected) return state;
    await pause(100);
  }
  return state;
}

/** Primitive: inspect a visible disclosure and restore its original state. */
export async function inspectAndRestoreDisclosure({ session, environment, candidate, onExpanded = null, assertExecutionLease = null }) {
  const initial = await disclosureState(session, candidate?.backendNodeId);
  if (!candidate || candidate.visible !== true || candidate.role !== "button" || candidate.submitsForm === true || !["true", "false"].includes(initial)) {
    return { inspected: false, restored: false, reason: "Requires a fresh, visible, non-submitting disclosure button." };
  }
  if (await disclosureState(session, candidate.backendNodeId) !== initial) {
    return { inspected: false, restored: false, reason: "Disclosure state changed since observation." };
  }
  if (initial === "true") {
    let detail = null;
    if (typeof onExpanded === "function") {
      try { detail = await onExpanded(); }
      catch { detail = { unavailable: true }; }
    }
    const finalState = await disclosureState(session, candidate.backendNodeId);
    return { inspected: true, restored: finalState === initial, initialState: initial, finalState, uiActions: 0, ...(detail ? { detail } : {}) };
  }
  const opened = await executeAuthorizedAction({ session, environment, goal: DISCLOSURE_GOAL, action: "click", candidate, assertExecutionLease });
  if (!opened.dispatched) return { inspected: false, restored: false, uiActions: 0, reason: opened.reason ?? "Disclosure click refused." };
  if (await waitForDisclosureState(session, candidate.backendNodeId, "true") !== "true") {
    return { inspected: false, restored: false, uiActions: 1, reason: "Open state was not independently observed; no second click was sent." };
  }
  let detail = null;
  if (typeof onExpanded === "function") {
    try { detail = await onExpanded(); }
    catch { detail = { unavailable: true }; }
  }
  const fresh = await session.observe();
  const sameControl = fresh.candidates?.find(item =>
    item.backendNodeId === candidate.backendNodeId && item.visible === true && item.role === "button"
    && item.submitsForm !== true
  );
  if (!sameControl) return { inspected: true, restored: false, uiActions: 1, reason: "Opened disclosure could not be safely re-resolved." };
  const closed = await executeAuthorizedAction({ session, environment, goal: DISCLOSURE_GOAL, action: "click", candidate: sameControl, assertExecutionLease });
  if (!closed.dispatched) return { inspected: true, restored: false, uiActions: 1, reason: closed.reason ?? "Could not restore the disclosure." };
  const finalState = await waitForDisclosureState(session, candidate.backendNodeId, "false");
  return { inspected: true, restored: finalState === "false", initialState: initial, finalState, uiActions: 2, ...(detail ? { detail } : {}) };
}

async function firstTableDisclosure(session, observation) {
  try {
    const document = await session.client.send("DOM.getDocument", { depth: 0, pierce: true });
    const selectors = [
      'main button[aria-expanded="false"]',
      'main [role="button"][aria-expanded="false"]',
      'tbody tr button[aria-expanded="false"]',
      '[role="row"] button[aria-expanded="false"]'
    ];
    const seen = new Set();
    for (const selector of selectors) {
      const matches = await session.client.send("DOM.querySelectorAll", { nodeId: document.root.nodeId, selector });
      for (const nodeId of matches.nodeIds ?? []) {
        const description = await session.client.send("DOM.describeNode", { nodeId });
        const backendNodeId = description.node?.backendNodeId;
        if (!Number.isInteger(backendNodeId) || seen.has(backendNodeId)) continue;
        seen.add(backendNodeId);
        const candidate = observation.candidates?.find(item =>
          item.backendNodeId === backendNodeId && item.visible === true
          && item.role === "button" && item.submitsForm !== true
        );
        if (candidate && await disclosureState(session, backendNodeId) === "false") return candidate;
      }
    }
    return null;
  } catch { return null; }
}

async function waitForPath(session, environment, origin, path, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let observation = null;
  while (Date.now() < deadline) {
    observation = await observeAuthorized(session, environment, origin).catch(() => null);
    const location = locationOf(observation?.page?.url);
    if (location?.origin === origin && location.pathname === path) return observation;
    await pause(200);
  }
  return observation;
}

async function openArea({ session, environment, area, target, origin, adminPrefix, assertExecutionLease }) {
  const observation = await observeAuthorized(session, environment, origin);
  const current = locationOf(observation.page?.url);
  if (current?.pathname === target.pathname) return { opened: true, observation, navigated: false };
  const link = exactLink(observation, { labels: target.labels, origin, pathname: target.pathname });
  if (!link) return { opened: false, reason: "No exact visible profile-approved link for " + area + "." };
  const followed = await followVisibleAdminLink({ session, environment, candidate: link, purpose: "open Admin area " + area, assertExecutionLease });
  if (!followed.opened) return { opened: false, reason: followed.reason };
  const arrived = await waitForPath(session, environment, origin, target.pathname);
  const final = locationOf(arrived?.page?.url);
  if (final?.origin !== origin || final.pathname !== target.pathname || !final.pathname.startsWith(adminPrefix)) {
    return { opened: false, reason: "Observed destination did not match the approved Admin path." };
  }
  return { opened: true, observation: arrived, navigated: true };
}

function selectAreas(value, available) {
  const requested = Array.isArray(value) ? value : (!value || value === "all" ? available : String(value).split(",").map(item => item.trim()).filter(Boolean));
  const selected = [...new Set(requested)];
  const unknown = selected.filter(area => area !== "all" && !available.includes(area));
  if (unknown.length) throw new Error("Unknown Admin area(s): " + unknown.join(", ") + ". Available: " + available.join(", ") + ".");
  return selected.includes("all") ? available : selected;
}

/** Admin-only recipe. Cloud Agent execution/history qualification does not call this function. */
export async function discoverAdminDashboard(options = {}) {
  const { session, runStateStore } = options;
  return await withTargetExecutionLease(runStateStore, session, `admin-discovery-${randomUUID()}`, async lease =>
    await discoverAdminDashboardWithLease({ ...options, assertExecutionLease: lease.assertCurrent }));
}

async function discoverAdminDashboardWithLease({ session, environment, profile, areas = "all", onEvent = null, signal = null, assertExecutionLease }) {
  const config = profile?.staging_ui_diagnostics;
  if (!session?.attached || !config || !Array.isArray(config.surfaces)) {
    return { status: "BLOCKED", reason: "A profile and an attached authorized browser session are required." };
  }
  const emit = message => { try { onEvent?.(message); } catch { /* best effort */ } };
  const origin = config.application_origin;
  const adminPrefix = config.admin_path_prefix;
  const surfaces = config.surfaces;
  const available = [...new Set([...surfaces.map(surface => surface.surface_id), "settings"])];
  const selected = selectAreas(areas, available);
  if (!selected.length) return { status: "BLOCKED", reason: "Select at least one Admin area." };
  const maximumAreas = config.policy?.maximumPages ?? 6;
  if (selected.length > maximumAreas) {
    return { status: "BLOCKED", reason: "Recipe exceeds the profile's maximum Admin page count.", selectedAreas: selected };
  }
  const report = {
    workflowId: "freeinference-cloud-agent-admin-discovery",
    recipeId: selected.length === available.length ? "admin-dashboard-inventory" : "admin-dashboard-" + selected.join("-"),
    status: "PARTIAL",
    environmentId: environment.environmentId,
    appOrigin: origin,
    selectedAreas: selected,
    initialPage: null,
    finalPage: null,
    routeHistory: [],
    surfaces: [],
    auditCategories: [],
    limitations: [],
    safety: {
      readOnlyUiActions: 0, formsSubmitted: false, freeTextValuesRecorded: false,
      responseBodiesRead: false, databaseTablesQueried: false, settingsChanged: false,
      viewStateRestored: true
    }
  };
  let actions = 0;
  const first = await observeAuthorized(session, environment, origin).catch(error => ({ discoveryError: error }));
  if (first.discoveryError) return { ...report, status: "BLOCKED", reason: clean(first.discoveryError.message ?? first.discoveryError, 300) };
  const start = locationOf(first.page?.url);
  report.initialPage = start ? start.origin + start.pathname : null;
  if (!start?.pathname.startsWith(adminPrefix)) {
    const adminLink = exactLink(first, { labels: config.admin_link_labels, origin, pathPrefix: adminPrefix });
    if (!adminLink) return { ...report, status: "BLOCKED", reason: "No exact visible Admin link; no Admin URL was guessed." };
    const opened = await followVisibleAdminLink({ session, environment, candidate: adminLink, purpose: "enter the Admin dashboard", assertExecutionLease });
    if (!opened.opened) return { ...report, status: "BLOCKED", reason: opened.reason };
    actions++;
    const destination = locationOf(adminLink.href, first.page?.url);
    const arrived = await waitForPath(session, environment, origin, destination.pathname);
    const location = locationOf(arrived?.page?.url);
    if (location?.origin !== origin || !location.pathname.startsWith(adminPrefix)) {
      return { ...report, status: "BLOCKED", reason: "The visible Admin link did not reach the authorized Admin path." };
    }
    report.routeHistory.push({ origin, pathname: location.pathname, evidenceId: arrived.evidenceId ?? null });
  }

  const onAdmin = await observeAuthorized(session, environment, origin);
  const settingsLink = exactLink(onAdmin, { labels: config.settings_link_labels, origin, pathPrefix: adminPrefix });
  const settingsPath = settingsLink ? locationOf(settingsLink.href, onAdmin.page?.url)?.pathname ?? null : null;
  const paths = new Map(surfaces.map(surface => [surface.surface_id, { pathname: surface.pathname, labels: surface.link_labels ?? [] }]));
  paths.set("settings", { pathname: settingsPath, labels: config.settings_link_labels ?? [] });
  if (selected.includes("settings") && !settingsPath) report.limitations.push("Settings was not exposed as an exact visible Admin link; its route was not guessed.");

  let requestCursor = session.activity?.snapshot?.().networkRequests?.length ?? 0;
  let restorationVerified = true;
  try {
    for (const area of selected) {
      if (signal?.aborted) throw new Error("Admin discovery canceled.");
      const target = paths.get(area);
      if (!target?.pathname) {
        report.surfaces.push({ area, status: "UNAVAILABLE", reason: "No visible profile-approved route." });
        continue;
      }
      const route = await openArea({ session, environment, area, target, origin, adminPrefix, assertExecutionLease });
      if (!route.opened) {
        report.surfaces.push({ area, pathname: target.pathname, status: "UNAVAILABLE", reason: route.reason });
        continue;
      }
      if (route.navigated) actions++;
      await pause(250);
      const metadata = await inspectAdminSurface({ session, profile, apiCursor: requestCursor });
      requestCursor = session.activity?.snapshot?.().networkRequests?.length ?? requestCursor;
      const surface = surfaces.find(item => item.surface_id === area);
      const record = { area, pathname: target.pathname, status: "OBSERVED", ...metadata };
      report.surfaces.push(record);
      report.routeHistory.push({ origin, pathname: target.pathname, evidenceId: route.observation?.evidenceId ?? null });
      emit("Admin discovery: " + area + " at " + target.pathname);

      if (surface?.audit_categories) {
        const initialAuditFilter = selectedControlLabel(metadata.controlStates, surface.audit_categories);
        for (const category of surface.audit_categories) {
          if (signal?.aborted) throw new Error("Admin discovery canceled.");
          const selectedFilter = await activateVisibleReadOnlyControl({
            session, environment, origin, label: category, purpose: "inspect the " + category + " audit filter", assertExecutionLease
          });
          if (!selectedFilter.dispatched || !selectedFilter.verified) {
            report.auditCategories.push({
              category, observed: false, interactionDispatched: selectedFilter.dispatched,
              selectionState: selectedFilter.after ?? null,
              reason: selectedFilter.reason ?? "The selected audit category was not independently identified."
            });
            continue;
          }
          actions++;
          const categoryObservation = selectedFilter.observation;
          const categoryMetadata = await inspectAdminSurface({ session, profile, apiCursor: requestCursor });
          requestCursor = session.activity?.snapshot?.().networkRequests?.length ?? requestCursor;
          const disclosureCandidate = await firstTableDisclosure(session, categoryObservation);
          const disclosure = disclosureCandidate
            ? await inspectAndRestoreDisclosure({
              session, environment, candidate: disclosureCandidate, assertExecutionLease,
              onExpanded: async () => {
                const detail = await inspectAdminSurface({ session, profile, apiCursor: requestCursor });
                requestCursor = session.activity?.snapshot?.().networkRequests?.length ?? requestCursor;
                return {
                  headings: detail.headings,
                  tableColumns: detail.tables?.flatMap(table => table.columns ?? []) ?? [],
                  rowCount: detail.rowCount,
                  expandedDisclosureCount: detail.expandedDisclosureCount,
                  observedGetRoutes: detail.observedGetRoutes,
                  evidenceId: detail.evidenceId
                };
              }
            })
            : { inspected: false, restored: false, reason: "No visible row disclosure found." };
          actions += disclosure.uiActions ?? 0;
          if (disclosure.inspected && !disclosure.restored) report.limitations.push(category + " row disclosure did not return to its original state.");
          report.auditCategories.push({
            category,
            observed: true,
            interactionDispatched: true,
            selectionState: selectedFilter.after,
            rowCount: categoryMetadata.rowCount,
            columns: categoryMetadata.tables?.flatMap(table => table.columns ?? []) ?? [],
            disclosure
          });
        }
        record.auditCategories = report.auditCategories.map(item => ({
          category: item.category, observed: item.observed, rowCount: item.rowCount ?? null,
          disclosure: item.disclosure ?? null
        }));
        const currentAuditPage = await observeAuthorized(session, environment, origin);
        const currentSelected = await findSelectedCandidate(session, currentAuditPage.candidates, surface.audit_categories, ["button"]);
        if (initialAuditFilter) {
          if (currentSelected?.name === initialAuditFilter) record.auditFilterRestored = true;
          else {
            const restored = await activateVisibleReadOnlyControl({
              session, environment, origin, label: initialAuditFilter,
              purpose: "restore the original Audit category filter", assertExecutionLease
            });
            record.auditFilterRestored = restored.dispatched && restored.verified;
          }
          if (!record.auditFilterRestored) {
            report.safety.viewStateRestored = false;
            report.limitations.push("Could not verify restoration of the original Audit category filter.");
          }
        } else {
          record.auditFilterRestored = null;
          report.limitations.push("The original Audit category filter could not be identified for restoration.");
        }
      }

      if (surface?.tabs) {
        const initialTab = selectedControlLabel(metadata.controlStates, surface.tabs);
        record.tabs = [];
        for (const label of surface.tabs) {
          if (signal?.aborted) throw new Error("Admin discovery canceled.");
          const clicked = await activateVisibleReadOnlyControl({
            session, environment, origin, label, purpose: "inspect the " + label + " view", assertExecutionLease
          });
          if (!clicked.dispatched || !clicked.verified) {
            record.tabs.push({ label, observed: false, interactionDispatched: clicked.dispatched, selectionState: clicked.after ?? null, reason: clicked.reason ?? "Tab selection was not independently identified." });
            continue;
          }
          actions++;
          const view = await inspectAdminSurface({ session, profile, apiCursor: requestCursor });
          requestCursor = session.activity?.snapshot?.().networkRequests?.length ?? requestCursor;
          record.tabs.push({ label, observed: true, interactionDispatched: true, selectionState: clicked.after, rowCount: view.rowCount, columns: view.tables?.flatMap(table => table.columns ?? []) ?? [], selects: view.selects, observedGetRoutes: view.observedGetRoutes });
        }
        if (initialTab) {
          const currentPage = await observeAuthorized(session, environment, origin);
          const currentTab = await findSelectedCandidate(session, currentPage.candidates, surface.tabs);
          if (currentTab?.name === initialTab) record.activeTabRestored = true;
          else {
            const restored = await activateVisibleReadOnlyControl({
              session, environment, origin, label: initialTab,
              purpose: "restore the original Activity view", assertExecutionLease
            });
            record.activeTabRestored = restored.dispatched && restored.verified;
          }
          if (!record.activeTabRestored) {
            report.safety.viewStateRestored = false;
            report.limitations.push("Could not verify restoration of the original Activity view.");
          }
        }
      }

      if (surface?.expandable_sections) {
        record.expandableSections = [];
        for (const label of surface.expandable_sections) {
          const fresh = await observeAuthorized(session, environment, origin);
          const disclosure = fresh.candidates?.find(candidate =>
            candidate.visible === true && candidate.role === "button" && candidate.submitsForm !== true
            && candidate.name === label
          );
          if (!disclosure) { record.expandableSections.push({ label, inspected: false, reason: "No exact reversible disclosure found." }); continue; }
          const result = await inspectAndRestoreDisclosure({ session, environment, candidate: disclosure, assertExecutionLease });
          record.expandableSections.push({ label, ...result });
          actions += result.uiActions ?? 0;
          if (result.inspected && !result.restored) report.limitations.push(label + " section did not return to its original state.");
        }
      }
    }
    report.safety.readOnlyUiActions = actions;
    const current = await observedLocation(session);
    if (start?.origin === origin && current?.pathname !== start.pathname) {
      const restored = await executeAuthorizedAction({ session, environment, goal: READ_GOAL, action: "navigate", url: origin + start.pathname, assertExecutionLease });
      const restoredPage = restored.dispatched ? await waitForPath(session, environment, origin, start.pathname) : null;
      restorationVerified = locationOf(restoredPage?.page?.url)?.pathname === start.pathname;
      if (!restorationVerified) report.limitations.push("Could not verify restoration to the exact initially observed path.");
    }
    const final = await observedLocation(session);
    report.finalPage = final ? final.origin + final.pathname : null;
    const nestedComplete = report.surfaces.every(surface =>
      (surface.auditCategories ?? []).every(category => category.observed && category.disclosure?.inspected === true && category.disclosure?.restored === true)
      && surface.auditFilterRestored !== false && surface.auditFilterRestored !== null
      && (surface.tabs ?? []).every(tab => tab.observed)
      && surface.activeTabRestored !== false
      && (surface.expandableSections ?? []).every(section => section.inspected && section.restored)
    );
    report.status = restorationVerified && nestedComplete && report.surfaces.length === selected.length
      && report.surfaces.every(surface => surface.status === "OBSERVED")
      && report.auditCategories.every(category => category.observed)
      ? "COMPLETE"
      : "PARTIAL";
  } catch (error) {
    report.status = signal?.aborted ? "CANCELED" : "PARTIAL";
    report.limitations.push(clean(error?.message ?? error, 300));
    const final = await observedLocation(session).catch(() => null);
    report.finalPage = final ? final.origin + final.pathname : null;
  }
  report.safety.readOnlyUiActions = actions;
  return report;
}
