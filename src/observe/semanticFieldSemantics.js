const SEMANTIC_FIELD_ROLE_ALIASES = new Map([
  ["name", "name"], ["title", "name"], ["productname", "name"], ["itemname", "name"], ["producttitle", "name"], ["itemtitle", "name"],
  ["product", "name"], ["item", "name"], ["price", "price"], ["cost", "price"], ["amount", "price"], ["saleprice", "price"], ["listprice", "price"], ["retailprice", "price"],
  ["description", "description"], ["summary", "description"], ["sku", "sku"], ["productid", "sku"], ["itemid", "sku"],
  ["rating", "rating"], ["stars", "rating"], ["ratingvalue", "rating"], ["reviewscore", "rating"],
  ["date", "date"], ["published", "date"], ["publishedtime", "date"], ["datepublished", "date"], ["updated", "date"],
  ["author", "author"], ["creator", "author"], ["writer", "author"], ["category", "category"], ["genre", "category"], ["location", "location"], ["address", "location"],
  ["count", "count"], ["quantity", "count"], ["stock", "count"], ["inventory", "count"], ["url", "url"], ["href", "url"], ["website", "url"],
  ["image", "image"], ["photo", "image"], ["thumbnail", "image"], ["picture", "image"], ["brand", "brand"], ["manufacturer", "brand"], ["availability", "availability"],
  ["country", "country"], ["nation", "country"], ["countryname", "country"], ["territory", "country"],
  ["population", "population"], ["populationvalue", "population"], ["populationestimate", "population"]
]);

const SEMANTIC_FIELD_ROLE_LABELS = Object.freeze({
  name: "Name", price: "Price", description: "Description", sku: "SKU", rating: "Rating", date: "Date",
  author: "Author", category: "Category", location: "Location", count: "Count", url: "URL", image: "Image",
  brand: "Brand", availability: "Availability", country: "Country", population: "Population"
});

export function semanticRoleFromText(value) {
  const normalized = String(value ?? "").normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const roles = new Set(tokens.map(token => SEMANTIC_FIELD_ROLE_ALIASES.get(token)).filter(Boolean));
  if (roles.size > 1 && tokens.some(token => ["product", "item", "country", "nation"].includes(token))) roles.delete("name");
  return roles.size === 1 ? [...roles][0] : null;
}

function associatedFieldLabel(nodeIndex, index, nodeText) {
  const attributes = index.attributes[nodeIndex] ?? {};
  const labelledBy = String(attributes["aria-labelledby"] ?? "").trim().split(/\s+/u).filter(Boolean);
  if (labelledBy.length) {
    const labelNodes = labelledBy.map(id => {
      const matches = index.elementIndexesById?.get(id) ?? [];
      return matches.length === 1 ? matches[0] : null;
    });
    if (labelNodes.every(Number.isInteger)) {
      const value = labelNodes.map(labelNode => nodeText(labelNode, index, 120)).filter(Boolean).join(" ").slice(0, 180);
      if (value) return { value, status: "observed", source: "aria_labelledby" };
    }
  }

  const id = attributes.id;
  const explicitLabels = typeof id === "string" && id ? index.labelIndexesByFor?.get(id) ?? [] : [];
  if (explicitLabels.length === 1) {
    const value = nodeText(explicitLabels[0], index, 180);
    if (value) return { value, status: "observed", source: "html_label_for" };
  }

  if (index.tags[nodeIndex] === "DD") {
    const parent = index.parents[nodeIndex];
    const siblings = index.children.get(parent) ?? [];
    const position = siblings.indexOf(nodeIndex);
    for (let cursor = position - 1; cursor >= 0; cursor--) {
      const sibling = siblings[cursor];
      if (index.tags[sibling] === "DT") {
        const value = nodeText(sibling, index, 180);
        if (value) return { value, status: "observed", source: "description_term" };
        break;
      }
      if (!index.tags[sibling]?.startsWith("#")) break;
    }
  }
  return null;
}

/** Infer a bounded field role and label from explicit or stable structural evidence. */
export function resolveFieldSemantics(nodeIndex, index, source = null, nodeText) {
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0) return {
    semanticRole: null, semanticRoleStatus: "unknown", label: Object.freeze({ value: null, status: "unknown", source: null })
  };
  const attributes = index.attributes[nodeIndex] ?? {};
  const itemprop = String(attributes.itemprop ?? attributes.property ?? "").trim();
  const dataRoleAttribute = Object.keys(attributes).find(attribute => /^data-(?:product-|item-)?[a-z][a-z0-9-]*$/u.test(attribute)
    && semanticRoleFromText(attribute.slice(5)) !== null);
  const explicitLabel = [
    ["aria-label", "aria_label"], ["data-label", "data_label"], ["title", "title"]
  ].find(([attribute]) => typeof attributes[attribute] === "string" && attributes[attribute].trim());
  const associatedLabel = associatedFieldLabel(nodeIndex, index, nodeText);
  const tag = String(index.tags[nodeIndex] ?? "").toUpperCase();
  const classRole = semanticRoleFromText(source?.sourceKey ?? attributes.class);
  const observedRole = itemprop ? semanticRoleFromText(itemprop) : null;
  const dataRole = dataRoleAttribute ? semanticRoleFromText(dataRoleAttribute.slice(5)) : null;
  const observedLabel = explicitLabel
    ? { value: attributes[explicitLabel[0]].trim().slice(0, 180), status: "observed", source: explicitLabel[1] }
    : associatedLabel
      ? associatedLabel
    : itemprop && observedRole
      ? { value: itemprop.slice(0, 180), status: "observed", source: "itemprop" }
      : null;
  const labelRole = observedLabel ? semanticRoleFromText(observedLabel.value) : null;
  const semanticRole = observedRole ?? dataRole ?? (tag === "TIME" ? "date" : tag === "ADDRESS" ? "location" : null) ?? labelRole ?? classRole;
  const semanticRoleStatus = !semanticRole ? "unknown" : observedRole ? "observed" : "inferred";
  const label = observedLabel ?? (semanticRole
    ? {
      value: SEMANTIC_FIELD_ROLE_LABELS[semanticRole] ?? semanticRole,
      status: "inferred",
      source: dataRole ? "data_attribute_name" : tag === "TIME" || tag === "ADDRESS" ? "element_semantics" : "class_token"
    }
    : { value: null, status: "unknown", source: null });
  return {
    semanticRole,
    semanticRoleStatus,
    label: Object.freeze(label)
  };
}
