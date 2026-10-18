/** Apply caller-specific field release after extraction validation. */
export function projectExtractionOutput(output, authorizeField = null, context = {}) {
  const fields = output?.schema?.items;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return output;
  const allowed = new Set();
  const omitted = [];
  for (const [name, field] of Object.entries(fields)) {
    const permitted = field?.dataClass !== "credential" && (typeof authorizeField === "function"
      ? authorizeField(Object.freeze({ name, ...field, ...(output.scope ?? {}) }), context) === true
      : field?.dataClass === "public");
    if (permitted) allowed.add(name);
    else omitted.push(name);
  }
  if (omitted.length === 0) return output;
  return {
    ...output,
    schema: {
      ...output.schema,
      items: Object.fromEntries(Object.entries(fields).filter(([name]) => allowed.has(name)))
    },
    records: Array.isArray(output.records)
      ? output.records.map(record => Object.fromEntries(Object.entries(record ?? {}).filter(([name]) => allowed.has(name))))
      : output.records,
    fieldProvenance: Array.isArray(output.fieldProvenance)
      ? output.fieldProvenance.map(record => ({
          ...record,
          fields: Object.fromEntries(Object.entries(record.fields ?? {}).filter(([name]) => allowed.has(name)))
        }))
      : output.fieldProvenance,
    completeness: "incomplete",
    release: { status: "partial", omittedFields: omitted },
    verification: {
      ...output.verification,
      releaseStatus: "partial",
      omittedFields: omitted,
      reason: "Some extracted fields were not authorized for release."
    }
  };
}

export function projectExtractionOutputs(outputs, authorizeField = null, context = {}) {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return {};
  return Object.fromEntries(Object.entries(outputs).map(([name, output]) => [
    name,
    projectExtractionOutput(output, authorizeField, { ...context, outputName: name })
  ]));
}
