export const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster"]);

export function sanitizeUrl(value, { includeSensitiveUrlData = false, base } = {}) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!includeSensitiveUrlData) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch { return ""; }
}

export function sanitizeUrlAttribute(name, value, base, options) {
  return URL_ATTRIBUTES.has(String(name).toLowerCase())
    ? sanitizeUrl(value, { ...options, base })
    : value;
}
