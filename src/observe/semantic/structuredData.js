const MAX_JSONLD_SCRIPTS = 8;
const MAX_JSONLD_SCRIPT_BYTES = 16 * 1024;
const MAX_JSONLD_TOTAL_BYTES = 64 * 1024;
const MAX_JSONLD_HINTS = 64;

function boundedMetadataValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text && text.length <= 240 ? text : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["name", "url", "@id"]) {
      const nested = boundedMetadataValue(value[key]);
      if (nested) return nested;
    }
  }
  return null;
}

function jsonLdObjects(value, output, depth = 0, budget = { nodes: 0 }) {
  if (depth > 6 || budget.nodes >= 512 || value === null || typeof value !== "object") return;
  budget.nodes++;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 64)) jsonLdObjects(child, output, depth + 1, budget);
    return;
  }
  const typeValue = value["@type"];
  const types = (Array.isArray(typeValue) ? typeValue : [typeValue])
    .filter(type => typeof type === "string" && type.length <= 120)
    .map(type => type.split(/[\/#]/u).at(-1));
  if (types.length && output.length < MAX_JSONLD_HINTS) {
    const properties = [];
    const add = (path, property) => {
      const text = boundedMetadataValue(property);
      if (text && properties.length < 16) properties.push(Object.freeze({ path, value: text }));
    };
    for (const key of ["name", "description", "sku", "productID", "url", "image", "availability", "datePublished", "author", "headline", "price", "priceCurrency"]) {
      if (Object.hasOwn(value, key)) add(key, value[key]);
    }
    const offers = Array.isArray(value.offers) ? value.offers[0] : value.offers;
    if (offers && typeof offers === "object") {
      for (const key of ["price", "priceCurrency", "availability"]) if (Object.hasOwn(offers, key)) add(`offers.${key}`, offers[key]);
    }
    if (properties.length) output.push(Object.freeze({
      types: Object.freeze(types.slice(0, 4)),
      properties: Object.freeze(properties)
    }));
  }
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    if (Object.hasOwn(value, key)) jsonLdObjects(value[key], output, depth + 1, budget);
  }
}

/** Parse bounded JSON-LD as local metadata hints; never merge it into visible collection values. */
export function compileStructuredDataHints(indexes, { nodeText, evidenceRef }) {
  if (!Array.isArray(indexes) || typeof nodeText !== "function" || typeof evidenceRef !== "function") {
    throw new Error("Structured data compilation requires indexed documents and evidence-bound text helpers.");
  }
  const hints = [];
  let scriptCount = 0;
  let inspectedBytes = 0;
  let truncated = false;
  for (const index of indexes) {
    for (let nodeIndex = 0; nodeIndex < index.tags.length; nodeIndex++) {
      if (index.tags[nodeIndex] !== "SCRIPT"
        || String(index.attributes[nodeIndex]?.type ?? "").trim().toLowerCase() !== "application/ld+json") continue;
      if (scriptCount >= MAX_JSONLD_SCRIPTS || hints.length >= MAX_JSONLD_HINTS) { truncated = true; break; }
      scriptCount++;
      const source = nodeText(nodeIndex, index, MAX_JSONLD_SCRIPT_BYTES + 1);
      const bytes = Buffer.byteLength(source);
      if (bytes === 0 || bytes > MAX_JSONLD_SCRIPT_BYTES || inspectedBytes + bytes > MAX_JSONLD_TOTAL_BYTES) {
        truncated = true;
        continue;
      }
      inspectedBytes += bytes;
      let parsed;
      try { parsed = JSON.parse(source); } catch { continue; }
      const blocks = [];
      jsonLdObjects(parsed, blocks);
      for (const block of blocks) {
        if (hints.length >= MAX_JSONLD_HINTS) { truncated = true; break; }
        hints.push(Object.freeze({
          source: "json_ld_script",
          status: "metadata_only",
          scriptRef: evidenceRef(index, index.backendNodeIds[nodeIndex]),
          types: block.types,
          properties: block.properties
        }));
      }
    }
    if (scriptCount >= MAX_JSONLD_SCRIPTS || hints.length >= MAX_JSONLD_HINTS) break;
  }
  return Object.freeze({
    status: hints.length ? "available" : scriptCount ? "unavailable" : "not_observed",
    scriptCount,
    inspectedBytes,
    truncated,
    hints: Object.freeze(hints)
  });
}
