/**
 * Read-only inventory for an operator-opened Settings or Config page in the
 * account Admin Console. This module never navigates or dispatches controls.
 */

import { verifyObservedUrl } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "../runtime/controlRestrictions.js";

const CONFIG_METADATA_EXPRESSION = `(()=>{
  const normalize = value => String(value ?? '').replace(/\\s+/g,' ').trim().slice(0,180);
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  };
  const labelFor = element => {
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.innerText || '').join(' ');
    return normalize(element.getAttribute('aria-label') || element.getAttribute('title')
      || labelledBy || [...(element.labels || [])].map(label => label.innerText).join(' ')
      || element.getAttribute('placeholder') || element.name || '');
  };
  const redact = value => normalize(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig,'[redacted-email]')
    .replace(/\\bBearer\\s+[^\\s,;]+/ig,'Bearer [redacted]')
    .replace(/\\b(?:sk|pk|ghp|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\\b/ig,'[redacted-token]')
    .replace(/\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b/g,'[redacted-token]')
    .replace(/(https?:\\/\\/)\\S+@/ig,'$1[redacted]@')
    .replace(/([?&](?:token|key|secret|password|auth|signature)=)[^&\\s]+/ig,'$1[redacted]')
    .replace(/\\b(?:token|secret|password|credential|api[_ -]?key)\\s*[:=]\\s*[^\\s,;]+/ig,'[redacted-secret]')
    .slice(0,180);
  const secretLabel = label => /secret|token|password|credential|api[ _-]?key|private[ _-]?key|authorization|bearer|cookie/i.test(label);
  const excluded = 'table,[role="grid"],[role="row"],tbody';
  const controls = [...document.querySelectorAll('button,input,select,textarea,[role="switch"],[role="checkbox"],[role="radio"]')]
    .filter(element => visible(element) && !element.closest(excluded))
    .map(element => {
      const label = labelFor(element), sensitive = secretLabel(label) || element.type === 'password' || element.type === 'email';
      const item = { tag: element.tagName.toLowerCase(), type: element.type || null, label: redact(label) };
      if (element.tagName === 'SELECT') {
        item.selectedOption = sensitive ? '[redacted]' : redact(element.selectedOptions?.[0]?.textContent);
        item.options = sensitive ? [] : [...element.options].slice(0,80).map(option => redact(option.textContent)).filter(Boolean);
      } else if (element.type === 'checkbox' || element.type === 'radio' || element.getAttribute('role') === 'switch'
          || element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'radio') {
        item.checked = Boolean(element.checked ?? element.getAttribute('aria-checked') === 'true');
      } else if (element.tagName === 'BUTTON') {
        item.label = redact(label || element.innerText);
      } else if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        item.currentValue = sensitive ? '[redacted]' : redact(element.value);
      }
      return item;
    });
  return JSON.stringify({
    title: redact(document.title),
    headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(element => redact(element.innerText)).filter(Boolean),
    controls
  });
})()`;

export async function discoverStagingAdminConfig({ session, environment, profile }) {
  const contract = profile?.settings_config_discovery;
  if (!session || session.attached !== true) {
    return { status: "BLOCKED", reason: "No authorized attached browser session." };
  }
  if (!contract?.surface || contract.allow_mutation !== false || contract.read_only_inventory_allowed !== true) {
    return { status: "BLOCKED", reason: "The profile has no read-only Settings/Config discovery contract." };
  }

  const identityResult = await session.client.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  const observedUrl = identityResult.result?.value;
  const identity = verifyObservedUrl(environment, observedUrl);
  if (!identity.ok || identity.origin !== "https://staging.freeinference.org") {
    return { status: "BLOCKED", reason: identity.reason ?? "The attached tab is outside the staging account Admin Console." };
  }
  const location = new URL(observedUrl);
  if (!/^\/dashboard\/admin(?:\/|$)/.test(location.pathname) || isOperatorProhibitedNavigation(observedUrl)) {
    return { status: "BLOCKED", reason: "The attached tab is outside the allowed Settings/Config inventory surface." };
  }

  const identityPage = await session.client.send("Runtime.evaluate", {
    expression: "(()=>{const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0};return JSON.stringify([...document.querySelectorAll('h1,h2,h3')].filter(visible).map(element=>String(element.innerText??'').replace(/\\s+/g,' ').trim().slice(0,180))})()",
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  let observedHeadings;
  try { observedHeadings = JSON.parse(identityPage.result?.value ?? "[]"); }
  catch { return { status: "BLOCKED", reason: "The current Admin page identity could not be established; no controls were read." }; }
  const expectedHeadings = (contract.accepted_headings ?? ["Settings", "Config"]).map(value => String(value).toLowerCase());
  const observedRoute = (contract.observed_pages ?? []).find(page => page.pathname === location.pathname);
  const matchedHeading = observedHeadings.find(heading => expectedHeadings.includes(String(heading).toLowerCase()))
    ?? observedRoute?.surface
    ?? null;
  if (!matchedHeading) {
    return { status: "BLOCKED", reason: "The operator-opened Admin page is not identified as Settings or Config; no controls were read." };
  }

  const result = await session.client.send("Runtime.evaluate", {
    expression: CONFIG_METADATA_EXPRESSION,
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  if (result.exceptionDetails) throw new Error("The read-only Settings/Config inventory could not be read.");
  let metadata;
  try { metadata = JSON.parse(result.result?.value ?? "{}"); }
  catch { throw new Error("The Settings/Config page returned invalid structural metadata."); }

  return {
    status: "COMPLETE",
    surface: matchedHeading,
    route: location.pathname,
    headings: observedHeadings,
    controls: metadata.controls ?? [],
    privacy: {
      controlValuesReadOnly: true,
      sensitiveValuesRedacted: true,
      rowsRead: false,
      formsSubmitted: false,
      controlsOperated: false,
      responseBodiesRead: false
    }
  };
}
