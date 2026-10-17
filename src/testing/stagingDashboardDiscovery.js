/**
 * Read-only inventory of the authenticated FreeInference account dashboard.
 * This is separate from both Cloud Agent task execution and Cloud Agent Admin
 * discovery. It records the visible model catalog and the exact visible
 * navigation links that lead to the other staging surfaces.
 */

import { verifyObservedUrl } from "../environments/model.js";

const MODEL_LABEL = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function cleanLabel(value, max = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[redacted-email]")
    .replace(/\bBearer\s+[^\s,;]+/ig, "Bearer [redacted]")
    .replace(/\b(?:token|secret|password|credential|api[_ -]?key)\s*[:=]\s*[^\s,;]+/ig, "[redacted-secret]");
}

function safeLocation(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return null;
  }
}

function exactVisibleLink(candidates, { labels, origin, pathname = null }) {
  const acceptedLabels = new Set((labels ?? []).map(label => cleanLabel(label).toLowerCase()));
  return (candidates ?? []).flatMap(candidate => {
    if (candidate.visible !== true || candidate.disabled === true || candidate.role !== "link" || !candidate.href) return [];
    const label = cleanLabel(candidate.name);
    if (!acceptedLabels.has(label.toLowerCase())) return [];
    const location = safeLocation(candidate.href, candidate.documentUrl);
    if (!location || location.origin !== origin || (pathname && location.pathname !== pathname)) return [];
    return [{ label, ...location }];
  })[0] ?? null;
}

/**
 * Inspect the already-open dashboard. This function never navigates, clicks,
 * expands, selects, fills, submits, or reads form values.
 */
export async function discoverStagingDashboard({ session, environment, profile }) {
  const contract = profile?.dashboard_discovery;
  if (!session || session.attached !== true) {
    return { status: "BLOCKED", reason: "No authorized attached browser session." };
  }
  if (!contract?.origin || !contract?.pathname || !contract?.models_heading) {
    return { status: "BLOCKED", reason: "The profile has no account dashboard discovery contract." };
  }

  const observation = await session.observe();
  const observedUrl = observation?.page?.url;
  const identity = verifyObservedUrl(environment, observedUrl);
  if (!identity.ok || identity.origin !== contract.origin) {
    return { status: "BLOCKED", reason: identity.reason ?? "The attached tab is not on the profile's account dashboard origin." };
  }
  const location = safeLocation(observedUrl, observedUrl);
  if (location?.pathname !== contract.pathname) {
    return { status: "BLOCKED", reason: "The attached tab is not on the exact account dashboard route." };
  }

  const headings = (observation.headings ?? []).map(item => ({
    level: Number(item.level) || null,
    text: cleanLabel(item.text, 160)
  }));
  const hasDashboardHeading = headings.some(item => item.level === 1 && item.text === contract.dashboard_heading);
  const hasModelsHeading = headings.some(item => item.level === 2 && item.text === contract.models_heading);
  const modelNames = [...new Set((observation.candidates ?? [])
    .filter(candidate => candidate.visible === true && candidate.disabled !== true
      && candidate.role === "button" && MODEL_LABEL.test(cleanLabel(candidate.name, 128)))
    .map(candidate => cleanLabel(candidate.name, 128)))]
    .sort((a, b) => a.localeCompare(b));

  const agentsLink = exactVisibleLink(observation.candidates, {
    labels: contract.agents_link_labels,
    origin: contract.agents_origin
  });
  const settingsLink = exactVisibleLink(observation.candidates, {
    labels: contract.settings_link_labels,
    origin: contract.origin,
    pathname: contract.settings_pathname
  });
  const adminConsoleLink = exactVisibleLink(observation.candidates, {
    labels: contract.admin_console_link_labels,
    origin: contract.origin,
    pathname: contract.admin_console_pathname
  });

  const complete = hasDashboardHeading && hasModelsHeading && modelNames.length > 0;
  return {
    status: complete ? "COMPLETE" : "PARTIAL",
    source: {
      origin: identity.origin,
      pathname: location.pathname,
      title: cleanLabel(observation.page?.title, 160),
      evidenceId: observation.evidenceId ?? null
    },
    headings,
    modelCatalog: {
      heading: contract.models_heading,
      source: "visible accessible button labels",
      count: modelNames.length,
      models: modelNames
    },
    navigation: {
      agentsLink,
      settingsLink,
      adminConsoleLink: adminConsoleLink ? { ...adminConsoleLink, action: "not opened" } : null
    },
    privilegedBoundary: "This dashboard recipe records the Admin Console link only; its contents require a separate, operator-directed walkthrough.",
    limitations: [
      "This is a live UI inventory, not an API or backend model-availability check.",
      "Cloud Agent task-level model choices are a separate list and must be inventoried independently."
    ]
  };
}
