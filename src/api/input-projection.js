/**
 * Redacted input projection for status/detail responses and exports.
 * Fields whose names suggest credentials or secrets are omitted entirely;
 * other string values become placeholders so the structural shape (types,
 * counts, nesting) remains inspectable without disclosing task specifics.
 */
const SENSITIVE_INPUT_KEY = /pass(word)?|secret|token|api[-_]?key|credential|session|cookie|auth/i;
const INPUT_PLACEHOLDER = "[redacted]";

export function projectInput(input, schema) {
  if (input === null || input === undefined) return input ?? null;
  if (Array.isArray(input)) return input.map(item => projectInput(item, schema?.items));
  if (typeof input !== "object") {
    return typeof input === "number" || typeof input === "boolean" ? input : INPUT_PLACEHOLDER;
  }
  const props = schema?.properties ?? {};
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_INPUT_KEY.test(key)) continue;
    if (schema && schema.additionalProperties !== true && !Object.hasOwn(props, key)) continue;
    const spec = props[key];
    if (spec?.type === "integer" || spec?.type === "number" || spec?.type === "boolean" ||
        typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (spec?.type === "array" && Array.isArray(value)) {
      result[key] = value.map(item => projectInput(item, spec.items));
    } else {
      result[key] = projectInput(value, spec);
    }
  }
  return result;
}
