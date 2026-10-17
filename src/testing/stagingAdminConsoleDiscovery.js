/**
 * Structural-only inventory of the main FreeInference account Admin Console.
 * It does not navigate to the console. The operator must open the exact
 * profile-declared page first; this module never reads user-row values.
 */

import { verifyObservedUrl } from "../environments/model.js";

const PAGE_METADATA_EXPRESSION = safeButtonLabels => `(()=>{
  const hiddenFromData = 'table,[role="grid"],[role="row"],tbody';
  const clean = value => String(value ?? '').replace(/\\s+/g,' ').trim().slice(0,160)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig,'[redacted-email]')
    .replace(/\\bBearer\\s+[^\\s,;]+/ig,'Bearer [redacted]')
    .replace(/\\b(?:token|secret|password|credential|api[_ -]?key)\\s*[:=]\\s*[^\\s,;]+/ig,'[redacted-secret]');
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  };
  const label = element => clean(element.getAttribute('aria-label') || element.getAttribute('title')
    || element.labels?.[0]?.innerText || element.getAttribute('placeholder') || '');
  const safeButtons = new Set(${JSON.stringify(safeButtonLabels)}.map(value => clean(value).toLowerCase()));
  const tables = [...document.querySelectorAll('table,[role="grid"]')].filter(visible).map(table => ({
    columns: [...table.querySelectorAll('thead th,[role="columnheader"]')].map(cell => clean(cell.innerText)).filter(Boolean)
  }));
  const controls = [...document.querySelectorAll('button,input,select,textarea')]
    .filter(element => visible(element) && !element.closest(hiddenFromData))
    .flatMap(element => {
      if (element.tagName === 'BUTTON') {
        const buttonName = label(element) || clean(element.innerText);
        if (!safeButtons.has(buttonName.toLowerCase())) return [];
        return [{ tag: 'button', type: element.getAttribute('type'), label: buttonName }];
      }
      return [{
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type'),
      label: label(element),
      ...(element.tagName === 'SELECT' ? {
        selectedOption: clean(element.selectedOptions?.[0]?.textContent),
        options: [...element.options].map(option => clean(option.textContent)).filter(Boolean)
      } : {})
    }];
    });
  return JSON.stringify({
    title: clean(document.title),
    headings: [...document.querySelectorAll('h1,h2')].filter(element => visible(element) && !element.closest(hiddenFromData))
      .map(element => clean(element.innerText)).filter(Boolean),
    controls,
    tables
  });
})()`;

/**
 * Read headings, filter schemas, and table column labels on the exact Admin
 * Console page while excluding every table/grid row and all field values.
 */
export async function discoverStagingAdminConsole({ session, environment, profile }) {
  const contract = profile?.admin_console_discovery;
  if (!session || session.attached !== true) {
    return { status: "BLOCKED", reason: "No authorized attached browser session." };
  }
  if (!contract?.origin || !contract?.pathname) {
    return { status: "BLOCKED", reason: "The profile has no Admin Console discovery contract." };
  }

  const identityResult = await session.client.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  const observedUrl = identityResult.result?.value;
  const identity = verifyObservedUrl(environment, observedUrl);
  if (!identity.ok || identity.origin !== contract.origin) {
    return { status: "BLOCKED", reason: identity.reason ?? "The attached tab is outside the Admin Console origin." };
  }
  const location = new URL(observedUrl);
  if (location.pathname !== contract.pathname) {
    return { status: "BLOCKED", reason: "The attached tab is not on the exact profile-declared Admin Console route." };
  }

  const result = await session.client.send("Runtime.evaluate", {
    expression: PAGE_METADATA_EXPRESSION(contract.safe_button_labels ?? []),
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  });
  if (result.exceptionDetails) throw new Error("The Admin Console structural inventory could not be read.");
  let metadata;
  try { metadata = JSON.parse(result.result?.value ?? "{}"); }
  catch { throw new Error("The Admin Console returned invalid structural metadata."); }

  const tableCount = metadata.tables?.length ?? 0;
  const columnCount = (metadata.tables ?? []).reduce((sum, table) => sum + (table.columns?.length ?? 0), 0);
  const complete = (metadata.headings ?? []).includes(contract.heading) && tableCount > 0 && columnCount > 0;
  return {
    status: complete ? "COMPLETE" : "PARTIAL",
    source: { origin: identity.origin, pathname: location.pathname, title: metadata.title },
    headings: metadata.headings ?? [],
    controls: metadata.controls ?? [],
    tables: metadata.tables ?? [],
    privacy: {
      userRowsCaptured: false,
      userSummaryValuesCaptured: false,
      fieldValuesCaptured: false,
      responseBodiesRead: false,
      actionsDispatched: false
    },
    boundary: "Structure only. User data, keys, row values, and account records are excluded; this entrypoint does not change filters or submit forms."
  };
}
