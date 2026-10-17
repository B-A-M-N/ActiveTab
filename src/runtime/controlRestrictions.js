/**
 * Operator-defined control restrictions. A hard-denied label or scoped
 * contextual restriction cannot be overridden by caller goals.
 */
const NEVER_ALLOWED_CONTROL_LABELS = new Set(["clear last hours"]);
const NEVER_ALLOWED_PROVIDER_LABELS = new Set(["manage", "edit", "add", "delete keys"]);
const AUTH_GATED_ADMIN_LABELS = new Set(["settings", "config"]);

/**
 * The account Admin Console's Audit Log is an operator-designated no-touch
 * surface. Keep this check separate from the Cloud Agent Admin's Audit page,
 * which is a different application and has its own operator-directed recipe.
 */
export function isOperatorProhibitedNavigation(destination) {
  let url;
  try { url = new URL(destination); }
  catch { return false; }
  if (url.origin !== "https://staging.freeinference.org"
      || !/^\/dashboard\/admin(?:\/|$)/.test(url.pathname)) return false;
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  return segments.some(segment => ["audit", "audit-log", "auditlog"].includes(segment));
}

export function isOperatorProhibitedControl(candidate, actionType = "click") {
  const label = [candidate?.name, candidate?.label, candidate?.ariaLabel, candidate?.text]
    .filter(value => typeof value === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if ([...NEVER_ALLOWED_CONTROL_LABELS].some(prohibited => label.includes(prohibited))) return true;

  let url;
  try { url = new URL(candidate?.documentUrl); }
  catch { return false; }
  const isStagingDashboard = url.origin === "https://staging.freeinference.org"
    && /^\/dashboard(?:\/|$)/.test(url.pathname);
  const isStagingAdmin = url.origin === "https://staging.freeinference.org"
    && /^\/dashboard\/admin(?:\/|$)/.test(url.pathname);
  const context = String(candidate?.contextName ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const pathSegments = url.pathname.split("/").map(part => part.toLowerCase());
  if (isStagingAdmin && actionType === "click") {
    try {
      const destination = new URL(candidate?.href, url.origin);
      if (isOperatorProhibitedNavigation(destination.href)) return true;
    } catch { /* non-link controls are checked by their label and context */ }
  }
  const isSettingsOrConfigArea = isStagingDashboard && (
    pathSegments.some(part => AUTH_GATED_ADMIN_LABELS.has(part))
    || [...AUTH_GATED_ADMIN_LABELS].some(name => context.includes(name))
  );
  if (isSettingsOrConfigArea) {
    const destination = (() => {
      try { return new URL(candidate?.href, url.origin); }
      catch { return null; }
    })();
    const destinationSegments = destination?.pathname.split("/").map(part => part.toLowerCase()) ?? [];
    const isSettingsNavigationLink = actionType === "click"
      && (candidate?.role === "link" || String(candidate?.tag).toLowerCase() === "a")
      && destination?.origin === url.origin
      && destinationSegments.some(part => AUTH_GATED_ADMIN_LABELS.has(part))
      && !pathSegments.some(part => AUTH_GATED_ADMIN_LABELS.has(part));
    if (isSettingsNavigationLink) return false;
    if (actionType === "scroll") return false;
    return ["click", "type", "fill", "select", "upload"].includes(actionType);
  }
  const isAuditLogSurface = isStagingAdmin && (
    label.includes("audit log")
    || (context.includes("audit") && context.includes("log"))
    || isOperatorProhibitedNavigation(url.href)
  );
  if (isAuditLogSurface) return true;
  const isProvidersArea = context.includes("providers") || pathSegments.includes("providers");
  return isStagingAdmin && isProvidersArea && NEVER_ALLOWED_PROVIDER_LABELS.has(label);
}

export function operatorProhibitedControlReason() {
  return "This control is prohibited by the active operator safety policy and cannot be dispatched.";
}
