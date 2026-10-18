import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_CLASSES = new Set(["public", "personal", "sensitive", "credential"]);

function validText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function createExtractionFieldPolicy(entries = [], paginationEntries = []) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Extraction field policy must be a bounded list.");
  if (!Array.isArray(paginationEntries) || paginationEntries.length > 1000) throw new Error("Extraction pagination policy must be a bounded list.");
  const policies = new Map();
  for (const entry of entries) {
    if (!validText(entry?.environmentId, 128) || !validText(entry?.applicationId, 96)
      || !validText(entry?.origin, 512) || !validText(entry?.sourceHeader, 160)
      || !DATA_CLASSES.has(entry?.dataClass)
      || typeof entry.allowRead !== "boolean" || typeof entry.allowRelease !== "boolean") {
      throw new Error("Every extraction field policy entry requires exact scope, data class, and explicit read/release decisions.");
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
  const paginationPolicies = new Map();
  for (const entry of paginationEntries) {
    if (!validText(entry?.environmentId, 128) || !validText(entry?.applicationId, 96)
      || !validText(entry?.origin, 512) || !validText(entry?.pagePath, 2048)
      || entry?.kind !== "rel_next_same_path" || !Number.isInteger(entry.maxPages)
      || entry.maxPages < 2 || entry.maxPages > 100) {
      throw new Error("Pagination policy entries require exact app scope, page path, strategy, and a bounded page limit.");
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
    authorizePagination(value) {
      const policy = paginationPolicies.get(paginationKey(value));
      return policy?.kind === value?.kind && Number.isInteger(value?.maxPages) && value.maxPages <= policy.maxPages;
    }
  });
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
  return createExtractionFieldPolicy(document.entries, document.pagination ?? []);
}

function policyKey(value) {
  return JSON.stringify([
    value?.environmentId ?? null,
    value?.applicationId ?? null,
    value?.origin ?? null,
    value?.sourceHeader ?? null
  ]);
}

function paginationKey(value) {
  return JSON.stringify([
    value?.environmentId ?? null,
    value?.applicationId ?? null,
    value?.origin ?? null,
    value?.pagePath ?? null,
    value?.kind ?? null
  ]);
}
