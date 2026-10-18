/**
 * Read-only inventory for an operator-opened Settings or Config page in the
 * account Admin Console. This module never navigates or dispatches controls.
 */

import { verifyObservedUrl } from "../environments/model.js";
import { isOperatorProhibitedNavigation } from "../runtime/controlRestrictions.js";

function readConfigMetadata() {
  const compact = (value, limit = 180) => {
    let result = "";
    let pendingSpace = false;
    for (const character of String(value ?? "")) {
      if (character.trim() === "") {
        pendingSpace = result.length > 0;
        continue;
      }
      if (pendingSpace && result.length < limit) result += " ";
      pendingSpace = false;
      if (result.length >= limit) break;
      result += character;
    }
    return result;
  };

  const words = value => {
    const result = [];
    let word = "";
    let previousWasLowerOrDigit = false;
    const flush = () => {
      if (word) result.push(word.toLowerCase());
      word = "";
      previousWasLowerOrDigit = false;
    };
    for (const character of String(value ?? "")) {
      const code = character.charCodeAt(0);
      const lower = code >= 97 && code <= 122;
      const upper = code >= 65 && code <= 90;
      const digit = code >= 48 && code <= 57;
      if (!lower && !upper && !digit) {
        flush();
        continue;
      }
      if (upper && word && previousWasLowerOrDigit) flush();
      word += character;
      previousWasLowerOrDigit = lower || digit;
    }
    flush();
    return result;
  };

  const sensitiveLabel = (label, type) => {
    if (type === "password" || type === "email") return true;
    const parts = words(label);
    const direct = new Set([
      "password", "token", "secret", "credential", "credentials",
      "authorization", "bearer", "cookie", "cookies", "apikey",
      "privatekey", "clientsecret", "accesskey", "refreshkey"
    ]);
    if (parts.some(part => direct.has(part))) return true;
    for (let index = 0; index + 1 < parts.length; index++) {
      const pair = `${parts[index]} ${parts[index + 1]}`;
      if (["api key", "private key", "access key", "secret key", "client secret", "access token", "refresh token", "session token"].includes(pair)) return true;
    }
    return false;
  };

  const safeMetadataText = value => {
    const text = compact(value);
    if (!text || text.includes("@") || text.includes("://")) return "";
    let atomLength = 0;
    for (const character of text) {
      const code = character.charCodeAt(0);
      const atomCharacter = (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122) || character === "-" || character === "_" || character === ".";
      atomLength = atomCharacter ? atomLength + 1 : 0;
      if (atomLength > 48) return "";
    }
    return text;
  };

  const whitespaceTokens = value => {
    const result = [];
    let token = "";
    const flush = () => {
      if (token) result.push(token);
      token = "";
    };
    for (const character of String(value ?? "")) {
      if (character.trim() === "") flush();
      else token += character;
    }
    flush();
    return result;
  };

  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none"
      && style.visibility !== "hidden" && Number(style.opacity) > 0;
  };

  const labelFor = element => {
    const labelledBy = whitespaceTokens(element.getAttribute("aria-labelledby") || "")
      .map(id => document.getElementById(id)?.innerText || "").join(" ");
    const labels = [...(element.labels || [])].map(label => label.innerText || "").join(" ");
    return compact(element.getAttribute("aria-label") || element.getAttribute("title")
      || labelledBy || labels || element.getAttribute("placeholder") || element.name || "");
  };

  const excluded = 'table,[role="grid"],[role="row"],tbody';
  const controls = [...document.querySelectorAll('button,input,select,textarea,[role="switch"],[role="checkbox"],[role="radio"]')]
    .filter(element => visible(element) && !element.closest(excluded))
    .map(element => {
      const type = element.type || null;
      const label = labelFor(element);
      const sensitive = sensitiveLabel(label, type);
      const item = {
        tag: element.tagName.toLowerCase(),
        type,
        label: safeMetadataText(label),
        sensitiveControl: sensitive
      };

      if (element.tagName === "SELECT") {
        item.selectedOption = sensitive ? null : safeMetadataText(element.selectedOptions?.[0]?.textContent);
        item.options = sensitive ? [] : [...element.options].slice(0, 80)
          .map(option => safeMetadataText(option.textContent)).filter(Boolean);
      } else if (type === "checkbox" || type === "radio" || element.getAttribute("role") === "switch"
          || element.getAttribute("role") === "checkbox" || element.getAttribute("role") === "radio") {
        item.checked = Boolean(element.checked ?? element.getAttribute("aria-checked") === "true");
      } else if (element.tagName === "BUTTON") {
        item.label = safeMetadataText(label || element.innerText);
      }

      // Do not inspect input.value or textarea.value. Their contents can be
      // credentials, private configuration, or unrelated account data.
      return item;
    });

  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .filter(visible).map(element => safeMetadataText(element.innerText)).filter(Boolean);
  return JSON.stringify({ headings, controls });
}

const CONFIG_METADATA_EXPRESSION = `(${readConfigMetadata.toString()})()`;

function isAdminPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length >= 2 && segments[0] === "dashboard" && segments[1] === "admin";
}

export async function discoverStagingAdminConfig({ session, environment, profile, evidenceSource }) {
  const contract = profile?.settings_config_discovery;
  if (!session || session.attached !== true) {
    return { status: "BLOCKED", reason: "No authorized attached browser session." };
  }
  if (!contract?.surface || contract.capture_control_labels !== true
      || contract.capture_current_non_sensitive_values !== true || contract.redact_sensitive_values !== true
      || contract.allow_mutation !== false || contract.read_only_inventory_allowed !== true) {
    return { status: "BLOCKED", reason: "The profile has no read-only Settings/Config discovery contract." };
  }
  if (!["live_browser", "synthetic_fixture", "operator_screenshot"].includes(evidenceSource)) {
    return { status: "BLOCKED", reason: "An explicit evidence provenance is required before discovery." };
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
  if (!isAdminPath(location.pathname) || isOperatorProhibitedNavigation(observedUrl)) {
    return { status: "BLOCKED", reason: "The attached tab is outside the allowed Settings/Config inventory surface." };
  }

  const identityPage = await session.client.send("Runtime.evaluate", {
    expression: "(()=>{const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0};const clean=value=>{let result='',space=false;for(const character of String(value??'')){if(character.trim()===''){space=result.length>0;continue}if(space)result+=' ';space=false;if(result.length>=180)break;result+=character}return result};return JSON.stringify([...document.querySelectorAll('h1,h2,h3')].filter(visible).map(element=>clean(element.innerText)))})()",
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
    evidence: {
      source: evidenceSource,
      targetId: session.target?.id ?? null,
      observationId: session.latestEvidenceId ?? null
    },
    headings: metadata.headings ?? observedHeadings,
    controls: metadata.controls ?? [],
    privacy: {
      toggleStatesReadOnly: true,
      selectOptionLabelsReadOnly: true,
      freeTextControlValuesRead: false,
      sensitiveControlValuesRead: false,
      rowsRead: false,
      formsSubmitted: false,
      controlsOperated: false,
      responseBodiesRead: false
    }
  };
}
