import { searchPhraseFromGoal } from "./search.js";

const SENSITIVE_ACTIONS = [
  { name: "purchase", pattern: /\b(?:buy|purchase|pay|payment|checkout|place\s+order|complete\s+order|subscribe)\b/i },
  { name: "destructive", pattern: /\b(?:delete|erase|destroy|remove|unsubscribe|cancel\s+(?:my\s+|the\s+)?(?:account|subscription|order|booking))\b/i },
  { name: "external_communication", pattern: /\b(?:send|email|message|publish|post|share|reply)\b/i },
  { name: "security_change", pattern: /\b(?:change|reset|disable|enable)\s+(?:my\s+)?(?:password|email|two.factor|2fa|mfa|security)\b/i }
];

const FORM_INTENTS = [
  ...SENSITIVE_ACTIONS,
  { name: "search", pattern: /\b(?:search|find|filter|query)\b/i },
  { name: "authentication", pattern: /\b(?:sign\s*in|log\s*in|login|authenticate)\b/i },
  { name: "submit", pattern: /\bsubmit\b/i }
];

const NAVIGATION_ONLY = /^(?:please\s+)?(?:open|go\s+to|navigate(?:\s+to)?|find|search\s+for|locate|view|show|inspect|look\s+at)\b/i;

function userGoalHasIntent(goal, pattern, { allowSearchQuery = false } = {}) {
  return String(goal ?? "")
    .split(/\b(?:and\s+then|then|and)\b|[,;]+/i)
    .some(clause => {
      const trimmed = clause.trim();
      const isSearchQuery = allowSearchQuery && /^(?:please\s+)?search\s+for\b/i.test(trimmed);
      return (!NAVIGATION_ONLY.test(trimmed) || isSearchQuery) && pattern.test(trimmed);
    });
}

function actionCategory(candidate, categories) {
  const text = `${candidate.name ?? ""} ${candidate.role ?? ""} ${candidate.type ?? ""}`;
  return categories.find(category => category.pattern.test(text));
}

export function authorizePlannedAction(goal, candidate, actionType = "click") {
  if (actionType === "scroll") {
    return candidate?.visible === true && ["container", "viewport"].includes(candidate.kind) && candidate.canScrollDown === true
      ? { authorized: true, category: "navigation_scroll" }
      : { authorized: false, category: "invalid_scroll_target", reason: "Scrolling is limited to a currently visible region that the latest observation identified as scrollable." };
  }
  if (actionType === "type") {
    const authorizedSearchField = searchPhraseFromGoal(goal)
      && candidate.tag === "input"
      && String(candidate.type ?? "").toLowerCase() === "search"
      && !candidate.frameTargetId
      && candidate.visible === true
      && candidate.disabled !== true;
    return authorizedSearchField
      ? { authorized: true, category: "search_input" }
      : { authorized: false, category: "unclassified_form_input", reason: "Text entry is limited to a unique visible native search field with a caller-provided search phrase." };
  }
  if (actionType !== "click") return { authorized: false, category: "unsupported_action", reason: "The selected browser action is not supported." };
  const sensitive = actionCategory(candidate, SENSITIVE_ACTIONS);
  if (sensitive) {
    if (userGoalHasIntent(goal, sensitive.pattern)) return { authorized: true, category: sensitive.name };
    return {
      authorized: false,
      category: sensitive.name,
      reason: `The selected control appears to perform a ${sensitive.name.replaceAll("_", " ")} action, which the caller's goal did not request.`
    };
  }

  if (candidate.submitsForm === true) {
    const intent = actionCategory(candidate, FORM_INTENTS);
    if (intent && userGoalHasIntent(goal, intent.pattern, { allowSearchQuery: intent.name === "search" })) return { authorized: true, category: intent.name };
    return {
      authorized: false,
      category: "unclassified_form_submission",
      reason: "The selected control submits a form, but the caller's goal does not explicitly authorize this submission."
    };
  }

  return { authorized: true, category: "navigation" };
}
