import { normalizeHeader } from "../extraction/extractionContract.js";
import { requestedLocalTransformFields } from "../extraction/recordTransformations.js";

export function fieldMatchesCandidate(field, candidate) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return false;
  if (candidate.kind === "visible_html_table") {
    return typeof field.sourceHeader === "string"
      && candidate.headers.some(header => normalizeHeader(header) === normalizeHeader(field.sourceHeader));
  }
  return candidate.kind === "visible_record_group"
    && typeof field.sourceKey === "string"
    && Array.isArray(candidate.fields)
    && candidate.fields.some(source => source.sourceKey === field.sourceKey);
}

export function sameCandidateSource(left, right) {
  if (!left || !right || left.kind !== right.kind || left.origin !== right.origin
    || left.environmentId !== right.environmentId || left.applicationId !== right.applicationId
    || left.pagePath !== right.pagePath) return false;
  if (left.kind === "visible_html_table") {
    return left.tableIndex === right.tableIndex
      && JSON.stringify(left.headers) === JSON.stringify(right.headers);
  }
  return left.kind === "visible_record_group"
    && JSON.stringify(left.recordGroup) === JSON.stringify(right.recordGroup)
    && JSON.stringify(left.fields) === JSON.stringify(right.fields);
}

export function candidateSourceProjection(candidate) {
  return candidate?.kind === "visible_html_table" ? {
    kind: candidate.kind,
    origin: candidate.origin,
    pagePath: candidate.pagePath,
    tableIndex: candidate.tableIndex,
    headers: candidate.headers
  } : {
    kind: candidate?.kind,
    origin: candidate?.origin,
    pagePath: candidate?.pagePath,
    documentIndex: candidate?.documentIndex,
    frameId: candidate?.frameId,
    frameTargetId: candidate?.frameTargetId,
    parentFrameId: candidate?.parentFrameId,
    recordGroup: candidate?.recordGroup,
    fields: candidate?.fields
  };
}

export function environmentKey(environment, origin) {
  return environment?.environmentId ?? environment?.id ?? `public:${origin}`;
}

export function isPublicObservedReadScope(candidate, environment) {
  if (candidate?.environmentId == null && candidate?.applicationId == null) return true;
  return environment?.ephemeral === true
    && environment.scopeKind === "current_origin"
    && typeof environment.environmentId === "string"
    && candidate?.environmentId === environment.environmentId
    && candidate?.applicationId === "ephemeral_public_site"
    && Array.isArray(environment.authorizedOrigins)
    && environment.authorizedOrigins.length === 1
    && environment.authorizedOrigins[0] === candidate?.origin;
}

const FIELD_MATCH_STOP_WORDS = new Set([
  "the", "and", "for", "from", "into", "with", "that", "this", "then", "please",
  "return", "list", "show", "get", "find", "read", "extract", "collect", "retrieve",
  "summarize", "summarise", "compare", "products", "product", "records", "rows", "items", "visible"
]);

const REQUESTED_FIELD_ROLE_ALIASES = new Map([
  ["name", "name"], ["title", "name"], ["product", "name"], ["item", "name"],
  ["price", "price"], ["cost", "price"], ["amount", "price"],
  ["author", "author"], ["creator", "author"], ["writer", "author"],
  ["description", "description"], ["summary", "description"],
  ["date", "date"], ["published", "date"], ["rating", "rating"],
  ["category", "category"], ["brand", "brand"], ["location", "location"],
  ["country", "country"], ["nation", "country"], ["population", "population"]
]);

export function fieldTerms(value) {
  return String(value ?? "").normalize("NFKC").replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.map(term =>
    term.length > 4 && term.endsWith("ies") ? `${term.slice(0, -3)}y`
      : term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term
  ).filter(term => !FIELD_MATCH_STOP_WORDS.has(term)) ?? [];
}

function fieldCode(value) {
  const code = normalizeHeader(value).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : null;
}

function semanticRolesFromTerms(terms) {
  const roles = new Set([...terms].map(term => REQUESTED_FIELD_ROLE_ALIASES.get(term)).filter(Boolean));
  // "Country names" names one country field; it does not request a second
  // generic name field from the same record.
  if (roles.has("country") && roles.has("name")) roles.delete("name");
  return roles;
}

export function semanticFieldCode(value) {
  const roles = semanticRolesFromTerms(fieldTerms(value));
  return roles.size === 1 ? [...roles][0] : fieldCode(value);
}

export function semanticCollectionMatchesCandidate(collection, candidate) {
  if (candidate?.kind !== "visible_record_group" || collection?.kind !== "repeated_dom_structure"
    || collection.recordBindingStatus !== "unique" || collection.fieldsTruncated === true
    || !Array.isArray(collection.fields) || !Array.isArray(candidate.fields)
    || collection.fields.length !== candidate.fields.length
    || collection.visibleCount !== candidate.visibleRowCount
    || collection.documentIndex !== candidate.documentIndex
    || collection.frameId !== (candidate.frameId ?? null)
    || collection.frameTargetId !== (candidate.frameTargetId ?? null)
    || collection.parentFrameId !== (candidate.parentFrameId ?? null)
    || JSON.stringify(collection.sourceGroup) !== JSON.stringify(candidate.recordGroup)) return false;
  if (!Number.isInteger(candidate.documentIndex)) return false;
  return collection.fields.every((field, index) => {
    const source = candidate.fields[index];
    return field.sourceKey === source.sourceKey
      && field.sourceTag === String(source.sourceTagName ?? "").toLowerCase();
  });
}

export function requestedSemanticRecordFields(goal, collection, candidate) {
  const goalTerms = [...fieldTerms(goal), ...requestedLocalTransformFields(goal)];
  const requestedTerms = new Set(goalTerms);
  const requestedRoleOrder = [...semanticRolesFromTerms(goalTerms)];
  const descriptors = collection.fields.map((semanticField, index) => {
    const source = candidate.fields[index];
    const roleStatus = ["observed", "inferred"].includes(semanticField.semanticRoleStatus)
      ? semanticField.semanticRoleStatus : null;
    const sourceTerms = new Set([
      ...fieldTerms(semanticField.label?.value),
      ...fieldTerms(source?.sourceKey)
    ]);
    const inferredRoles = semanticRolesFromTerms(sourceTerms);
    return {
      semanticField,
      source,
      role: roleStatus ? semanticField.semanticRole : inferredRoles.size === 1 ? [...inferredRoles][0] : null,
      sourceTerms
    };
  });

  let selected;
  if (requestedRoleOrder.length) {
    selected = [];
    for (const role of requestedRoleOrder) {
      const matchingRole = descriptors.filter(item => item.role === role);
      const exactTerms = goalTerms.filter(term => REQUESTED_FIELD_ROLE_ALIASES.get(term) === role);
      const sourceSpecific = matchingRole.filter(item => exactTerms.some(term => item.sourceTerms.has(term)));
      const resolved = sourceSpecific.length ? sourceSpecific : matchingRole;
      if (resolved.length !== 1) return [];
      const name = fieldCode(role);
      if (!name) return [];
      selected.push({
        name,
        sourceKey: resolved[0].source.sourceKey,
        type: "string",
        required: true
      });
    }
  } else {
    selected = [];
    const names = new Set();
    for (const item of descriptors) {
      if (![...item.sourceTerms].some(term => requestedTerms.has(term))) continue;
      const name = fieldCode(item.semanticField.semanticRole ?? (item.semanticField.label?.value || item.source.sourceKey));
      if (!name || names.has(name)) return [];
      names.add(name);
      selected.push({ name, sourceKey: item.source.sourceKey, type: "string", required: true });
    }
  }
  return selected;
}

export function requestedSemanticFieldNames(goal) {
  return [...semanticRolesFromTerms(fieldTerms(goal))]
    .map(fieldCode).filter(Boolean);
}

export function observedReadFailure(reasonCode, message) {
  return Object.assign(new Error(message), { reasonCode });
}

export function retainedRouteUrl(session, observation) {
  const retainedPage = session?.observer?.getEvidence?.(observation?.evidenceId, {
    facets: ["page"],
    includeSensitiveUrlData: true
  });
  return retainedPage?.status === "available" && typeof retainedPage.page?.url === "string"
    ? retainedPage.page.url
    : observation?.page?.url;
}
