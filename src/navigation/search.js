const SEARCH_FOR = /\bsearch\s+for\s+/i;

export function searchPhraseFromGoal(goal) {
  const text = String(goal ?? "");
  const marker = SEARCH_FOR.exec(text);
  if (!marker) return undefined;
  let phrase = text.slice(marker.index + marker[0].length).replace(/\s+/g, " ").trim();
  if (phrase.length >= 2 && ((phrase.startsWith('"') && phrase.endsWith('"')) || (phrase.startsWith("'") && phrase.endsWith("'")))) {
    phrase = phrase.slice(1, -1).trim();
  }
  return phrase || undefined;
}

