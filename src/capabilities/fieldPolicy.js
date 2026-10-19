import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_CLASSES = new Set(["public", "personal", "sensitive", "credential"]);
const CREDENTIAL_FIELD = /(?:password|passphrase|secret|token|api[ _-]?key|credential|authorization|cookie|session|csrf|xsrf|private[ _-]?key)/iu;
const PERSONAL_FIELD = /(?:e[ _-]?mail|phone|mobile|telephone|address|street|postal|zip[ _-]?code|birth(?:day|date)?|first[ _-]?name|last[ _-]?name|full[ _-]?name|user(?:name|[ _-]?id)|account[ _-]?(?:id|number)|ssn|social[ _-]?security|patient|medical|salary|payment[ _-]?card)/iu;
const PUBLIC_FIELD_LABELS = new Set([
  "title", "article title", "book title", "product", "product name", "item", "item name",
  "price", "unit price", "cost", "amount", "date", "published", "publication date",
  "author", "category", "brand", "rating", "country", "population", "description", "summary"
]);

function validText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function createExtractionFieldPolicy(entries = [], paginationEntries = [], publicReadEntries = []) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Extraction field policy must be a bounded list.");
  if (!Array.isArray(paginationEntries) || paginationEntries.length > 1000) throw new Error("Extraction pagination policy must be a bounded list.");
  if (!Array.isArray(publicReadEntries) || publicReadEntries.length > 1000) throw new Error("Public observed-read policy must be a bounded list.");
  const policies = new Map();
  for (const entry of entries) {
    const hasHeader = validText(entry?.sourceHeader, 160);
    const hasSourceKey = validText(entry?.sourceKey, 128);
    if (!validText(entry?.environmentId, 128) || !validText(entry?.applicationId, 96)
      || !validText(entry?.origin, 512) || hasHeader === hasSourceKey
      || !DATA_CLASSES.has(entry?.dataClass)
      || typeof entry.allowRead !== "boolean" || typeof entry.allowRelease !== "boolean") {
      throw new Error("Every extraction field policy entry requires exact scope, one sourceHeader or sourceKey, data class, and explicit read/release decisions.");
    }
    const origin = new URL(entry.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== entry.origin) {
      throw new Error("Extraction field policy origins must be exact HTTP(S) origins.");
    }
    const key = policyKey(entry);
    if (policies.has(key)) throw new Error("Extraction field policy contains a duplicate scoped source header.");
    policies.set(key, Object.freeze({ ...entry }));
  }
  const find = value => policies.get(policyKey(value)) ?? null;
  const publicPolicies = new Map();
  for (const entry of publicReadEntries) {
    const hasHeader = validText(entry?.sourceHeader, 160);
    const hasSourceKey = validText(entry?.sourceKey, 128);
    if (!validText(entry?.origin, 512) || hasHeader === hasSourceKey || entry.dataClass !== "public"
      || typeof entry.allowRead !== "boolean" || typeof entry.allowRelease !== "boolean") {
      throw new Error("Public observed-read entries require an exact origin, one source header or key, public classification, and explicit read/release decisions.");
    }
    const origin = new URL(entry.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== entry.origin) {
      throw new Error("Public observed-read origins must be exact HTTP(S) origins.");
    }
    const key = publicPolicyKey(entry);
    if (publicPolicies.has(key)) throw new Error("Public observed-read policy contains a duplicate source at one origin.");
    publicPolicies.set(key, Object.freeze({ ...entry }));
  }
  const findPublic = value => publicPolicies.get(publicPolicyKey(value)) ?? null;
  const paginationPolicies = new Map();
  for (const entry of paginationEntries) {
    const supportedKind = new Set(["rel_next_same_path", "explicit_next_same_path", "page_number_query", "virtualized_list"]).has(entry?.kind);
    if (!validText(entry?.environmentId, 128) || !validText(entry?.applicationId, 96)
      || !validText(entry?.origin, 512) || !validText(entry?.pagePath, 2048)
      || !supportedKind || !Number.isInteger(entry.maxPages)
      || entry.maxPages < 2 || entry.maxPages > 100) {
      throw new Error("Pagination policy entries require exact app scope, page path, strategy, and a bounded page limit.");
    }
    if ((entry.kind === "page_number_query"
      && (typeof entry.queryParameter !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(entry.queryParameter)))
      || (entry.kind !== "page_number_query" && entry.queryParameter !== undefined)) {
      throw new Error("Page-number pagination policy requires one bounded queryParameter and other strategies forbid it.");
    }
    const origin = new URL(entry.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== entry.origin || !entry.pagePath.startsWith("/")) {
      throw new Error("Pagination policy requires an exact HTTP(S) origin and absolute page path.");
    }
    const key = paginationKey(entry);
    if (paginationPolicies.has(key)) throw new Error("Pagination policy contains a duplicate scoped page path.");
    paginationPolicies.set(key, Object.freeze({ ...entry }));
  }
  return Object.freeze({
    classifyField(value) { return find(value)?.dataClass ?? null; },
    authorizeRead(value) {
      const policy = find(value);
      return policy?.allowRead === true && policy.dataClass !== "credential";
    },
    authorizeRelease(value) {
      const policy = find(value);
      return policy?.allowRelease === true && policy.dataClass !== "credential";
    },
    classifyPublicField(value) { return findPublic(value)?.dataClass ?? null; },
    publicFieldPolicy(value) {
      const policy = findPublic(value);
      return policy ? Object.freeze({ dataClass: policy.dataClass, allowRead: policy.allowRead, allowRelease: policy.allowRelease }) : null;
    },
    authorizePublicRead(value) {
      const policy = findPublic(value);
      return policy?.allowRead === true && policy.dataClass === "public";
    },
    authorizePublicRelease(value) {
      const policy = findPublic(value);
      return policy?.allowRelease === true && policy.dataClass === "public";
    },
    authorizePagination(value) {
      const policy = paginationPolicies.get(paginationKey(value));
      return policy?.kind === value?.kind
        && policy?.queryParameter === value?.queryParameter
        && Number.isInteger(value?.maxPages) && value.maxPages <= policy.maxPages;
    }
  });
}

/** Conservative metadata classifier used only to form a human-review proposal. */
export function classifyObservedPublicField(value) {
  const label = String(value?.sourceHeader ?? value?.sourceKey ?? value?.fieldName ?? "")
    .normalize("NFKC").replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  if (!label || CREDENTIAL_FIELD.test(label)) return "credential";
  if (PERSONAL_FIELD.test(label)) return "personal";
  if (PUBLIC_FIELD_LABELS.has(label)) return "public";
  return null;
}

/** Read an operator-authored policy from a private, non-symlink file. */
export async function loadExtractionFieldPolicy(path) {
  if (typeof path !== "string" || !path) return createExtractionFieldPolicy([]);
  const fullPath = resolve(path);
  const stat = await lstat(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (stat.mode & 0o077) !== 0) {
    throw new Error("Extraction field policy must be a private regular file no larger than 256 KiB.");
  }
  const document = JSON.parse(await readFile(fullPath, "utf8"));
  if (document?.version !== 1) throw new Error("Extraction field policy version must be 1.");
  return createExtractionFieldPolicy(document.entries, document.pagination ?? [], document.publicReadEntries ?? []);
}

function policyKey(value) {
  return JSON.stringify([
    value?.environmentId ?? null,
    value?.applicationId ?? null,
    value?.origin ?? null,
    value?.sourceHeader ?? null,
    value?.sourceKey ?? null
  ]);
}

function paginationKey(value) {
  return JSON.stringify([
    value?.environmentId ?? null,
    value?.applicationId ?? null,
    value?.origin ?? null,
    value?.pagePath ?? null,
    value?.kind ?? null,
    value?.queryParameter ?? null
  ]);
}

function publicPolicyKey(value) {
  return JSON.stringify([
    value?.origin ?? null,
    value?.sourceHeader ?? null,
    value?.sourceKey ?? null
  ]);
}
