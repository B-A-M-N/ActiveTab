const FIELD_ALIASES = Object.freeze({
  name: ["name", "title", "product", "item"],
  price: ["price", "cost", "amount"],
  date: ["date", "published"],
  author: ["author", "creator", "writer"],
  rating: ["rating", "score"]
});

function boundedCount(goal) {
  const match = goal.match(/\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu);
  if (!match) return null;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const count = Number(match[1]) || words[match[1].toLowerCase()];
  return Number.isInteger(count) && count >= 1 && count <= 100 ? count : null;
}

function visibleScope(goal) {
  return /\b(?:visible|shown|on this page|currently displayed)\b/iu.test(goal)
    && !/\b(?:all|every|entire|whole|complete|across the site|on the website)\b/iu.test(goal);
}

export function hasSupportedLocalTransformationShape(goal) {
  if (typeof goal !== "string" || goal.length > 4096 || !visibleScope(goal)) return false;
  return /\b(?:cheapest|lowest[- ]priced|least expensive|most expensive|highest[- ]priced|priciest|how many|count|under|below|less than|cheaper than|at most|only|just)\b/iu.test(goal);
}

function sourceField(schema, role) {
  const aliases = FIELD_ALIASES[role] ?? [role];
  return Object.keys(schema ?? {}).find(name => aliases.includes(name.toLowerCase())) ?? null;
}

function numericMode(field) {
  if (field?.type === "number" || field?.type === "integer") return field.type;
  if (field?.type === "string") return "numeric_text";
  return null;
}

/** Deterministic natural-language subset; returns no executable text or code. */
export function parseVisibleRecordTransformation(goal, schema = {}) {
  if (typeof goal !== "string" || goal.length > 4096) return null;
  const sortMatch = /\b(cheapest|lowest[- ]priced|least expensive|most expensive|highest[- ]priced|priciest)\b/iu.exec(goal);
  const countRequest = /\b(?:how many|count)\b/iu.test(goal);
  const filterMatch = /\b(?:under|below|less than|cheaper than|at most)\s+([$€£¥]?\s*\d[\d,.]*)/iu.exec(goal);
  const projectMatch = /\b(?:only|just)\s+(?:the\s+)?(name|names|title|titles|price|prices|author|authors|date|dates|rating|ratings)\b/iu.exec(goal);
  const requested = Boolean(sortMatch || countRequest || filterMatch || projectMatch);
  if (!requested) return null;
  if (!visibleScope(goal)) return Object.freeze({ status: "unresolved", reasonCode: "local_transform_requires_visible_scope" });

  const operations = [];
  const neededFields = new Set();
  if (sortMatch) {
    const field = sourceField(schema, "price");
    const valueType = field ? numericMode(schema[field]) : null;
    if (!field || !valueType) return Object.freeze({ status: "unresolved", reasonCode: "local_sort_field_not_typed" });
    neededFields.add(field);
    operations.push(Object.freeze({
      op: "sort_records", field,
      direction: /\b(?:most expensive|highest[- ]priced|priciest)\b/iu.test(sortMatch[0]) ? "desc" : "asc",
      valueType
    }));
    const count = boundedCount(goal);
    if (count !== null) operations.push(Object.freeze({ op: "select_first_n", count }));
  }
  if (filterMatch) {
    const field = sourceField(schema, "price");
    const valueType = field ? numericMode(schema[field]) : null;
    const valueText = filterMatch[1].replace(/[\s$€£¥,]/gu, "");
    const value = Number(valueText);
    if (!field || !valueType || !Number.isFinite(value)) return Object.freeze({ status: "unresolved", reasonCode: "local_filter_field_not_typed" });
    neededFields.add(field);
    operations.push(Object.freeze({ op: "filter_records", field, operator: /\bat most\b/iu.test(filterMatch[0]) ? "lte" : "lt", value, valueType }));
  }
  if (countRequest) operations.push(Object.freeze({ op: "count_records" }));
  if (projectMatch) {
    const requestedRole = projectMatch[1].toLowerCase().replace(/s$/u, "");
    const field = sourceField(schema, requestedRole);
    if (!field) return Object.freeze({ status: "unresolved", reasonCode: "local_projection_field_unavailable" });
    neededFields.add(field);
    operations.push(Object.freeze({ op: "project_fields", fields: Object.freeze([field]) }));
  }
  if (!operations.length) return Object.freeze({ status: "unresolved", reasonCode: "local_transform_unavailable" });
  return Object.freeze({ status: "resolved", plan: Object.freeze({ version: 1, scope: "visible_records", operations: Object.freeze(operations) }),
    neededFields: Object.freeze([...neededFields]) });
}

export function requestedLocalTransformFields(goal) {
  if (typeof goal !== "string") return [];
  const fields = new Set();
  if (/\b(?:cheapest|lowest[- ]priced|least expensive|most expensive|highest[- ]priced|priciest|under|below|less than|cheaper than|at most)\b/iu.test(goal)) {
    for (const name of ["name", "title", "product", "item", "price", "cost", "amount"]) fields.add(name);
  }
  return [...fields];
}

function compareValue(value, expectedType) {
  if (expectedType === "number" || expectedType === "integer") {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  if (expectedType === "numeric_text" && typeof value === "string") {
    const match = value.trim().match(/^([$€£¥])?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*\1?$/u);
    if (!match) return null;
    const result = Number(match[2].replaceAll(",", ""));
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function assertTransformSchema(output) {
  const fields = output?.schema?.items;
  if (!output || output.completeness !== "observed_partial" || !Array.isArray(output.records)
    || !Array.isArray(output.fieldProvenance) || output.records.length !== output.fieldProvenance.length
    || !fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Local transformation requires verified observed-partial records.");
}

/** Pure, bounded transformations over already verified and released records. */
export function applyVisibleRecordTransformations(output, plan) {
  assertTransformSchema(output);
  if (!plan || plan.version !== 1 || plan.scope !== "visible_records" || !Array.isArray(plan.operations) || plan.operations.length > 6) {
    throw new Error("Local transformation plan is invalid.");
  }
  const schema = { ...output.schema.items };
  let entries = output.records.map((record, index) => ({ record: { ...record }, provenance: structuredClone(output.fieldProvenance[index]) }));
  const summary = {};
  for (const operation of plan.operations) {
    if (!operation || typeof operation !== "object") throw new Error("Local transformation operation is malformed.");
    if (operation.op === "sort_records") {
      const field = schema[operation.field];
      if (!field || !["number", "integer", "string"].includes(field.type)
        || !["asc", "desc"].includes(operation.direction)
        || !["number", "integer", "numeric_text"].includes(operation.valueType)) throw new Error("Local sort does not match the verified field schema.");
      const decorated = entries.map((entry, index) => ({ entry, index, value: compareValue(entry.record[operation.field], operation.valueType) }));
      if (decorated.some(item => item.value === null)) throw new Error("Local sort field contains a value outside its declared numeric representation.");
      if (operation.valueType === "numeric_text") {
        const currencies = new Set(entries.map(entry => String(entry.record[operation.field]).trim().match(/^[$€£¥]/u)?.[0] ?? ""));
        if (currencies.size > 1) throw new Error("Local currency sort refuses mixed or ambiguous units.");
      }
      const direction = operation.direction === "asc" ? 1 : -1;
      decorated.sort((left, right) => direction * (left.value - right.value) || left.index - right.index);
      entries = decorated.map(item => item.entry);
      continue;
    }
    if (operation.op === "filter_records") {
      const field = schema[operation.field];
      if (!field || !["number", "integer", "string"].includes(field.type)
        || !["lt", "lte", "gt", "gte", "eq", "ne"].includes(operation.operator)
        || !Number.isFinite(operation.value)) throw new Error("Local filter does not match the verified field schema.");
      const compare = left => operation.valueType === "numeric_text" ? compareValue(left, "numeric_text")
        : typeof left === "number" && Number.isFinite(left) ? left : null;
      entries = entries.filter(entry => {
        const value = compare(entry.record[operation.field]);
        if (value === null) throw new Error("Local filter field contains an invalid typed value.");
        return operation.operator === "lt" ? value < operation.value
          : operation.operator === "lte" ? value <= operation.value
            : operation.operator === "gt" ? value > operation.value
              : operation.operator === "gte" ? value >= operation.value
                : operation.operator === "eq" ? value === operation.value : value !== operation.value;
      });
      continue;
    }
    if (operation.op === "select_first_n") {
      if (!Number.isInteger(operation.count) || operation.count < 1 || operation.count > 1000) throw new Error("Local selection count is invalid.");
      entries = entries.slice(0, operation.count);
      continue;
    }
    if (operation.op === "count_records") {
      summary.count = entries.length;
      summary.scope = "visible_records";
      continue;
    }
    if (operation.op === "project_fields") {
      if (!Array.isArray(operation.fields) || operation.fields.length < 1 || operation.fields.length > 32
        || operation.fields.some(name => typeof name !== "string" || !Object.hasOwn(schema, name))) throw new Error("Local projection contains an undeclared field.");
      const projected = Object.fromEntries(operation.fields.map(name => [name, schema[name]]));
      for (const entry of entries) {
        entry.record = Object.fromEntries(operation.fields.map(name => [name, entry.record[name]]));
        entry.provenance.fields = Object.fromEntries(operation.fields.map(name => [name, entry.provenance.fields[name]]));
      }
      Object.assign(schema, projected);
      for (const name of Object.keys(schema)) if (!operation.fields.includes(name)) delete schema[name];
      continue;
    }
    throw new Error("Unsupported local record transformation.");
  }
  const records = entries.map(entry => entry.record);
  const fieldProvenance = entries.map((entry, index) => ({ ...entry.provenance, recordIndex: index }));
  const transformed = {
    ...output,
    schema: { ...output.schema, items: { ...schema } },
    records,
    fieldProvenance,
    transformation: { plan, sourceCompleteness: "observed_partial", ...(Object.keys(summary).length ? { summary } : {}) },
    verification: {
      ...output.verification,
      recordCount: records.length,
      uniqueBy: (output.verification.uniqueBy ?? []).filter(name => Object.hasOwn(schema, name))
    }
  };
  if (Object.keys(summary).length) transformed.summary = Object.freeze({ ...summary });
  return Object.freeze(transformed);
}
