export const SEARCH_SUBMIT_OPERATION_ID = "activetab.search.submit";

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

export function searchPhraseFromGoal(goal) {
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

function isNativeSearchField(candidate) {
  return candidate?.tag === "input"
    && String(candidate.type ?? "").toLowerCase() === "search"
    && candidate.visible === true
    && candidate.disabled !== true
    && !candidate.frameTargetId;
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
      if (action === "type") {
        return isNativeSearchField(candidate) && value === query
          ? { allowed: true, category: "caller_search_query" }
          : { allowed: false, reason: "The exact caller query may be entered only in a visible native search field." };
      }
      if (action !== "click" || candidate?.submitsForm !== true || !candidate.formIdentity || candidate.formMethod !== "get") {
        return { allowed: false, reason: "Search submission requires the observed same-origin GET form's submit control." };
      }
      let pageOrigin;
      try { pageOrigin = new URL(observation?.page?.url).origin; }
      catch { return { allowed: false, reason: "Search submission requires a valid current page origin." }; }
      if (!typedFieldIdentity || typedQuery !== query || !typedTargetId || candidate.targetId !== typedTargetId
        || candidate.formActionOrigin !== pageOrigin) {
        return { allowed: false, reason: "The query was not entered into the same target or the search form would leave the current origin." };
      }
      const fields = (observation?.candidates ?? []).filter(isNativeSearchField);
      const field = fields.length === 1 ? fields[0] : null;
      if (!field || field.identity !== typedFieldIdentity || field.targetId !== candidate.targetId || field.formIdentity !== candidate.formIdentity) {
        return { allowed: false, reason: "The selected submit control is not bound to the exact search field used for this request." };
      }
      return { allowed: true, category: "caller_search_query" };
    },
    recordDispatch({ operationId, action, candidate, value, dispatchStatus } = {}) {
      if (operationId !== SEARCH_SUBMIT_OPERATION_ID) return;
      if (action === "type") {
        if (dispatchStatus === "dispatched" && isNativeSearchField(candidate) && value === query) {
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
