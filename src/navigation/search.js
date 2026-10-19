export const SEARCH_SUBMIT_OPERATION_ID = "activetab_search_submit";

function isWordCharacter(character) {
  if (!character) return false;
  const code = character.codePointAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || character === "_";
}

function normalizeWhitespace(value) {
  let result = "";
  let pendingSpace = false;
  for (const character of String(value ?? "")) {
    if (character.trim() === "") {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += " ";
    result += character;
    pendingSpace = false;
  }
  return result;
}

/** Extract the exact query from the supported read-only search-and-read shape. */
export function searchReadRequestFromGoal(goal) {
  if (typeof goal !== "string" || goal.length > 4096) return null;
  const prefix = /^\s*search\s+for\s+/iu.exec(goal);
  if (!prefix) return null;
  const remainder = goal.slice(prefix[0].length);
  let quote = null;
  for (let index = 0; index < remainder.length; index++) {
    const character = remainder[index];
    if ((character === "'" || character === '"') && (index === 0 || remainder[index - 1] !== "\\")) {
      quote = quote === character ? null : quote === null ? character : quote;
      continue;
    }
    if (quote !== null || !/\s/u.test(character)) continue;
    const clause = /^\s+and\s+(return|list|show|get|give\s+me|extract|read|collect|retrieve)\b/iu.exec(remainder.slice(index));
    if (!clause) continue;
    let query = remainder.slice(0, index).trim();
    if (query.length >= 2 && ((query.startsWith('"') && query.endsWith('"')) || (query.startsWith("'") && query.endsWith("'")))) {
      query = query.slice(1, -1).trim();
    }
    const resultRequest = normalizeWhitespace(remainder.slice(index + clause[0].length)).trim();
    if (!query || query.length > 500 || !resultRequest
      || /\band\s+(?:then|filter\s+(?:by|to)|sort(?:\s+by)?|rank|compare|summari[sz]e|average|aggregate|total|open|click|navigate|visit|follow|submit|send|delete|remove|purchase|buy|pay|publish|upload|download|change|update|save|configure|approve)\b/iu.test(query)
      || /\b(?:and\s+then|after\s+that|open|click|navigate|visit|follow|filter|sort|rank|compare|summari[sz]e|average|aggregate|total|best|cheapest|lowest|highest|top\s+\d+|all|every|entire|complete|full|exhaustive)\b/iu.test(resultRequest)) return null;
    return Object.freeze({ query, resultRequest });
  }
  return null;
}

export function searchPhraseFromGoal(goal) {
  const readRequest = searchReadRequestFromGoal(goal);
  if (readRequest) return readRequest.query;
  const text = String(goal ?? "");
  const lowered = text.toLocaleLowerCase();
  for (let start = 0; start < lowered.length; start++) {
    if (!lowered.startsWith("search", start)) continue;
    if (isWordCharacter(lowered[start - 1]) || isWordCharacter(lowered[start + 6])) continue;
    let cursor = start + 6;
    while (lowered[cursor]?.trim() === "") cursor++;
    if (!lowered.startsWith("for", cursor) || isWordCharacter(lowered[cursor + 3])) continue;
    cursor += 3;
    while (text[cursor]?.trim() === "") cursor++;
    let phrase = normalizeWhitespace(text.slice(cursor)).trim();
    if (phrase.length >= 2 && ((phrase.startsWith('"') && phrase.endsWith('"')) || (phrase.startsWith("'") && phrase.endsWith("'")))) {
      phrase = phrase.slice(1, -1).trim();
    }
    return phrase || undefined;
  }
  return undefined;
}

export function isSearchFieldCandidate(candidate, observation = null) {
  if (candidate?.tag !== "input" || candidate.visible !== true || candidate.disabled === true || candidate.frameTargetId) return false;
  const type = String(candidate.type ?? "").toLowerCase();
  if (type === "search") return true;
  // Many public search pages expose their query field as type=text, name=q.
  // Accept that shape only when it belongs to a same-origin GET form.
  if (type !== "text" || candidate.queryField !== true || candidate.formMethod !== "get") return false;
  try {
    const pageOrigin = new URL(observation?.page?.url ?? candidate.documentUrl).origin;
    return candidate.formActionOrigin === pageOrigin;
  } catch { return false; }
}

/**
 * A process-local capability for submitting one caller-provided search query.
 * It binds the typed phrase to the exact visible search field and a same-origin
 * GET form observed to own the submit control. It cannot authorize other forms.
 */
export function createSearchSubmitAuthorizer(query) {
  if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("Search submission requires the caller's exact bounded query.");
  let typedFieldIdentity = null;
  let typedTargetId = null;
  let typedQuery = null;
  let terminal = false;

  return Object.freeze({
    authorize({ operationId, action, candidate, value, observation } = {}) {
      if (operationId !== SEARCH_SUBMIT_OPERATION_ID || terminal) return { allowed: false, reason: "The search operation is outside its single-use caller request." };
      if (action === "type" || action === "fill") {
        return isSearchFieldCandidate(candidate, observation) && value === query
          ? { allowed: true, category: "caller_search_query" }
          : { allowed: false, reason: "The exact caller query may be entered only in a visible native search field or same-origin GET query field." };
      }
      if (action !== "click" || candidate?.submitsForm !== true || !candidate.formIdentity
        || candidate.formMethod !== "get" || candidate.formTargetSameContext !== true) {
        return { allowed: false, reason: "Search submission requires the observed same-origin GET form's submit control." };
      }
      let pageOrigin;
      try { pageOrigin = new URL(observation?.page?.url).origin; }
      catch { return { allowed: false, reason: "Search submission requires a valid current page origin." }; }
      if (!typedFieldIdentity || typedQuery !== query || !typedTargetId || candidate.targetId !== typedTargetId
        || candidate.formActionOrigin !== pageOrigin) {
        return { allowed: false, reason: "The query was not entered into the same target or the search form would leave the current origin." };
      }
      const fields = (observation?.candidates ?? []).filter(field => isSearchFieldCandidate(field, observation));
      const field = fields.length === 1 ? fields[0] : null;
      if (!field || field.identity !== typedFieldIdentity || field.targetId !== candidate.targetId || field.formIdentity !== candidate.formIdentity) {
        return { allowed: false, reason: "The selected submit control is not bound to the exact search field used for this request." };
      }
      return { allowed: true, category: "caller_search_query" };
    },
    recordDispatch({ operationId, action, candidate, value, observation, dispatchStatus } = {}) {
      if (operationId !== SEARCH_SUBMIT_OPERATION_ID) return;
      if (action === "type" || action === "fill") {
        if (dispatchStatus === "dispatched" && isSearchFieldCandidate(candidate, observation) && value === query) {
          typedFieldIdentity = candidate.identity;
          typedTargetId = candidate.targetId;
          typedQuery = value;
        } else {
          terminal = dispatchStatus === "uncertain";
        }
        return;
      }
      if (action === "click" && (dispatchStatus === "dispatched" || dispatchStatus === "uncertain")) terminal = true;
    }
  });
}
