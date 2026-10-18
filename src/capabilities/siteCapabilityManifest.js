import { validateExtractionContract } from "../extraction/extractionContract.js";

function isDigest(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) return false;
  }
  return true;
}

/** Validate a serialized, reviewable capability definition. */
export function validateSiteCapabilityManifest(manifest, { requireQualified = false } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { valid: false, errors: ["Capability manifest must be an object."] };
  if (manifest.version !== 1) errors.push("Capability manifest version must be 1.");
  if (typeof manifest.capabilityId !== "string" || !manifest.capabilityId || manifest.capabilityId.length > 96) errors.push("capabilityId must be a bounded identifier.");
  if (!Number.isInteger(manifest.capabilityVersion) || manifest.capabilityVersion < 1 || manifest.capabilityVersion > 1000) errors.push("capabilityVersion must be from 1 to 1000.");
  if (manifest.kind !== "visible_html_table") errors.push("Only the registered visible_html_table capability is supported.");
  if (typeof manifest.applicationId !== "string" || !manifest.applicationId || manifest.applicationId.length > 96) errors.push("applicationId must be a bounded identifier.");
  if (typeof manifest.environmentId !== "string" || !manifest.environmentId || manifest.environmentId.length > 128) errors.push("environmentId must be a bounded identifier.");
  try {
    const origin = new URL(manifest.origin);
    if (!new Set(["http:", "https:"]).has(origin.protocol) || origin.origin !== manifest.origin) errors.push("origin must be an exact HTTP(S) origin.");
  } catch { errors.push("origin must be an exact HTTP(S) origin."); }
  if (typeof manifest.principalId !== "string" || !manifest.principalId || manifest.principalId.length > 128) errors.push("principalId must bind the capability to a verified principal.");
  const contract = manifest.extractionContract;
  const validation = validateExtractionContract(contract);
  if (!validation.valid) errors.push(...validation.errors.map(error => `extractionContract: ${error}`));
  if (contract && (contract.id !== manifest.capabilityId || contract.origin !== manifest.origin || contract.environmentId !== manifest.environmentId
    || contract.applicationId !== manifest.applicationId || contract.pagePath !== manifest.pagePath
    || contract.principalId !== manifest.principalId)) {
    errors.push("Extraction contract scope must exactly match the capability scope.");
  }
  if (typeof manifest.pagePath !== "string" || !manifest.pagePath.startsWith("/")) errors.push("pagePath must bind the capability to an exact application route.");
  const qualification = manifest.qualification;
  if (!qualification || typeof qualification !== "object") errors.push("qualification evidence is required.");
  else {
    if (requireQualified && qualification.status !== "qualified") errors.push("Only fixture-qualified capabilities can be registered for execution.");
    if (qualification.status === "qualified") {
      if (!isDigest(qualification.evidenceDigest)) errors.push("Qualified capabilities require an evidence digest.");
      if (!Number.isInteger(qualification.variantCount) || qualification.variantCount < 3 || qualification.variantCount > 1000) errors.push("Qualified capabilities require at least three bounded fixture variants.");
      if (!Array.isArray(qualification.evidenceRefs) || qualification.evidenceRefs.length < 1 || qualification.evidenceRefs.length > 32) errors.push("Qualified capabilities require bounded evidence references.");
    }
  }
  return { valid: errors.length === 0, errors };
}

export function cloneCapabilityManifest(manifest) {
  return Object.freeze(structuredClone(manifest));
}
