import { isOperatorProhibitedControl, operatorProhibitedControlReason } from "../runtime/controlRestrictions.js";

/**
 * Structural admission for ordinary browser navigation.
 *
 * Labels and natural-language goals do not classify effects. Form edits,
 * submissions, uploads, toggles, and unknown controls require a trusted,
 * profile-scoped operation authorizer at the central executor.
 */
export function authorizePlannedAction(_goal, candidate, actionType = "click") {
  if (isOperatorProhibitedControl(candidate, actionType)) {
    return { authorized: false, category: "operator_prohibited_control", reason: operatorProhibitedControlReason() };
  }
  if (candidate?.visible !== true || candidate?.disabled === true) {
    return { authorized: false, category: "control_unavailable", reason: "The selected control is not currently visible and enabled." };
  }
  if (actionType === "scroll") {
    return ["container", "viewport"].includes(candidate.kind) && candidate.canScrollDown === true
      ? { authorized: true, category: "navigation_scroll" }
      : { authorized: false, category: "invalid_scroll_target", reason: "Scrolling is limited to a currently visible region identified as scrollable." };
  }
  if (actionType === "type") {
    const isNativeSearch = candidate.tag === "input"
      && String(candidate.type ?? "").toLowerCase() === "search"
      && !candidate.frameTargetId;
    return isNativeSearch
      ? { authorized: true, category: "search_input" }
      : { authorized: false, category: "unsupported_text_entry", reason: "Text entry requires a visible native search field or a trusted typed operation contract." };
  }
  if (actionType !== "click") {
    return { authorized: false, category: "unsupported_action", reason: "This browser operation requires a trusted typed operation contract." };
  }
  if (candidate.submitsForm === true) {
    return { authorized: false, category: "unclassified_form_submission", reason: "Form submission requires a trusted, profile-scoped operation contract." };
  }
  const tag = String(candidate.tag ?? "").toLowerCase();
  const role = String(candidate.role ?? "").toLowerCase();
  if ((tag === "a" || role === "link") && typeof candidate.href === "string" && candidate.href.length > 0) {
    return { authorized: true, category: "passive_navigation" };
  }
  const attributes = candidate.attributes && typeof candidate.attributes === "object" ? candidate.attributes : {};
  const expandedValue = attributes["aria-expanded"];
  const expandsContent = expandedValue === "true" || expandedValue === "false" || attributes["aria-haspopup"] !== undefined;
  if (role === "tab" || expandsContent) {
    return { authorized: true, category: "ui_disclosure" };
  }
  return {
    authorized: false,
    category: "unknown_control_effect",
    reason: "The control's effect is unknown; a trusted typed operation contract is required."
  };
}
