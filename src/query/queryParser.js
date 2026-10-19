const MAX_QUERY_LENGTH = 4_096;
const MAX_QUERY_TOKENS = 256;
const MAX_FIELDS = 32;
const MAX_DEPTH = 4;
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

export class SemanticQuerySyntaxError extends Error {
  constructor(message, code = "unsupported_query_syntax") {
    super(message);
    this.name = "SemanticQuerySyntaxError";
    this.code = code;
  }
}

function tokenize(source) {
  if (typeof source !== "string" || !source.trim() || source.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(source)) {
    throw new SemanticQuerySyntaxError("Query must be non-empty plain text within the 4096-character limit.", "query_size_limit");
  }
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/u.test(source[offset])) { offset++; continue; }
    if ("{}[](),".includes(source[offset])) {
      tokens.push(source[offset++]);
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}/u.exec(source.slice(offset));
      if (!match) throw new SemanticQuerySyntaxError("Query contains unsupported syntax.");
      tokens.push(match[0]);
      offset += match[0].length;
    }
    if (tokens.length > MAX_QUERY_TOKENS) throw new SemanticQuerySyntaxError("Query exceeds the token limit.", "query_token_limit");
  }
  return tokens;
}

function isIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(value);
}

function parseStructured(tokens) {
  let index = 0;
  const take = expected => {
    const value = tokens[index++];
    if (value !== expected) throw new SemanticQuerySyntaxError(`Expected '${expected}' in structured query.`);
    return value;
  };
  const fieldObject = depth => {
    if (depth > MAX_DEPTH) throw new SemanticQuerySyntaxError("Query nesting exceeds the depth limit.", "query_depth_limit");
    take("{");
    const fields = [];
    const names = new Set();
    while (tokens[index] !== "}") {
      if (index >= tokens.length) throw new SemanticQuerySyntaxError("Structured query is missing a closing brace.");
      if (tokens[index] === ",") { index++; continue; }
      const name = tokens[index++];
      if (!isIdentifier(name)) throw new SemanticQuerySyntaxError("Field names must be bounded identifiers.");
      if (names.has(name)) throw new SemanticQuerySyntaxError(`Field '${name}' is duplicated.`, "duplicate_query_field");
      names.add(name);
      let field;
      if (tokens[index] === "[") {
        take("["); take("]");
        field = { name, kind: "collection", fields: fieldObject(depth + 1) };
      } else {
        let type = "string";
        if (tokens[index] === "(") {
          take("(");
          type = tokens[index++];
          take(")");
          if (!SCALAR_TYPES.has(type)) throw new SemanticQuerySyntaxError(`Scalar type '${String(type)}' is unsupported.`, "unsupported_query_type");
        }
        field = { name, kind: "scalar", type };
      }
      fields.push(Object.freeze(field));
      if (fields.length > MAX_FIELDS) throw new SemanticQuerySyntaxError("Query exceeds the per-object field limit.", "query_field_limit");
    }
    take("}");
    if (!fields.length) throw new SemanticQuerySyntaxError("Query objects must request at least one field.");
    return Object.freeze(fields);
  };

  take("{");
  const name = tokens[index++];
  if (!isIdentifier(name)) throw new SemanticQuerySyntaxError("A structured query must begin with a collection name.");
  take("["); take("]");
  const fields = fieldObject(1);
  take("}");
  if (index !== tokens.length) throw new SemanticQuerySyntaxError("Structured query contains trailing tokens.");
  return Object.freeze({ kind: "collection", name, fields });
}

const ELEMENT_ROLES = Object.freeze([
  { role: "searchbox", pattern: /\bsearch\s*(?:box|field|input)\b|\bsearchbox\b/u },
  { role: "combobox", pattern: /\b(?:combo|drop\s*down)\s*box\b|\bcombobox\b/u },
  { role: "textbox", pattern: /\b(?:text|email|phone|number)\s*(?:box|field|input)\b|\btextbox\b/u },
  { role: "checkbox", pattern: /\bcheckbox\b/u },
  { role: "radio", pattern: /\bradio\s*(?:button)?\b/u },
  { role: "button", pattern: /\bbutton\b/u },
  { role: "link", pattern: /\blink\b/u },
  { role: "form", pattern: /\bform\b/u }
]);

function parseElement(source) {
  const match = /^\s*find\s+(.{1,160}?)(?:\s+in\s+(.{1,160}))?\s*$/iu.exec(source);
  if (!match) return null;
  const description = match[1].trim();
  const role = ELEMENT_ROLES.find(item => item.pattern.test(description))?.role;
  if (!role) throw new SemanticQuerySyntaxError("Element queries must name a supported observed control role.", "unsupported_element_role");
  const scope = match[2]?.trim() ?? null;
  if (scope && !/^[\p{L}\p{N}_ -]+$/u.test(scope)) throw new SemanticQuerySyntaxError("Element scope must contain only bounded words.");
  return Object.freeze({ kind: "element", role, description, scope });
}

/** Parse the bounded local collection DSL or a constrained natural-language control query. */
export function parseSemanticQuery(source) {
  if (typeof source !== "string") throw new SemanticQuerySyntaxError("Query must be text.");
  if (!source.trim().startsWith("{")) {
    const element = parseElement(source);
    if (element) return element;
  }
  return parseStructured(tokenize(source));
}
