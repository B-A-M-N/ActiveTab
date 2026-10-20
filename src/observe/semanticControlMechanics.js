const SAFE_TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number"]);
const SENSITIVE_CONTROL_LABEL = /pass(word|code)?|secret|token|api.?key|credential|authorization|cookie|session|private.?key|client.?secret|csrf|xsrf/iu;

export function controlKind(candidate) {
  const role = String(candidate?.role ?? "").toLowerCase();
  const tag = String(candidate?.tag ?? "").toLowerCase();
  const type = String(candidate?.type ?? "").toLowerCase();
  if (tag === "select") return "select";
  if (tag === "textarea") return "text_entry";
  if (tag === "input") {
    if (["submit", "button", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "search") return "searchbox";
    return "input";
  }
  if (["button", "link", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "spinbutton", "slider"].includes(role)) return role;
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  return "unknown";
}

function interactionMechanic(candidate, attributes, pageUrl) {
  const tag = String(candidate?.tag ?? "").toLowerCase();
  const role = String(candidate?.role ?? "").toLowerCase();
  const type = String(candidate?.type ?? attributes?.type ?? "").toLowerCase();
  const name = [candidate?.name, candidate?.label, candidate?.ariaLabel, candidate?.contextName]
    .filter(value => typeof value === "string").join(" ");

  if (candidate?.submitsForm === true || ["submit", "image"].includes(type)) return "submit_form";
  if (tag === "a" && role === "link") {
    const href = attributes?.href ?? candidate?.href;
    try {
      const destination = new URL(href, pageUrl);
      if (["http:", "https:"].includes(destination.protocol) && !destination.username && !destination.password) return "follow_link";
    } catch { /* An invalid or absent href is not a navigation operation. */ }
    return "unknown";
  }
  if ((tag === "input" && type === "password") || SENSITIVE_CONTROL_LABEL.test(name)) return "unknown";
  if (tag === "textarea" || (tag === "input" && SAFE_TEXT_INPUT_TYPES.has(type))
    || candidate?.contentEditable === true && ["textbox", "searchbox"].includes(role)) return "enter_text";
  if (tag === "select" || role === "combobox") return "choose_option";
  if (["checkbox", "radio", "switch"].includes(role)
    || tag === "input" && ["checkbox", "radio"].includes(type)) return "toggle_control";
  if (["button", "tab", "menuitem"].includes(role) || tag === "button"
    || tag === "input" && ["button", "reset"].includes(type)) return "activate_control";
  return "unknown";
}

export function controlInteraction(candidate, attributes, pageUrl) {
  const mechanic = interactionMechanic(candidate, attributes, pageUrl);
  let readiness = "unknown";
  if (candidate?.visible === false) readiness = "not_visible";
  else if (candidate?.disabled === true || Object.hasOwn(attributes ?? {}, "disabled")) readiness = "disabled";
  else if (candidate?.visible === true && candidate?.disabled === false && mechanic !== "unknown") readiness = "visible_enabled";
  return Object.freeze({
    mechanic,
    readiness,
    evidence: mechanic === "unknown" ? null : "native_dom_accessibility_semantics"
  });
}
