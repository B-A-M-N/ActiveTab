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
  if (!new Set(["visible_html_table", "visible_record_group"]).has(manifest.kind)) errors.push("Capability kind must be a supported visible DOM extraction source.");
  if (typeof manifest.applicationId !== "string" || !manifest.applicationId || manifest.applicationId.length > 96) errors.push("applicationId must be a bounded identifier.");
  if (typeof manifest.environmentId !== "string" || !manifest.environmentId || manifest.environmentId.length > 128) errors.push("environmentId must be a bounded identifier.");
  try {
    const origin = new URL(manifest.origin);
    if (!new Set(["http:", "https:"]).has(origin.protocol) || origin.origin !== manifest.origin) errors.push("origin must be an exact HTTP(S) origin.");
  } catch { errors.push("origin must be an exact HTTP(S) origin."); }
  if (typeof manifest.principalId !== "string" || !manifest.principalId || manifest.principalId.length > 128) errors.push("principalId must bind the capability to a verified principal.");
  const contract = manifest.extractionContract;
  if (contract?.scopeKind !== undefined) errors.push("Ephemeral observed-read contracts cannot be persisted as site capabilities.");
  const validation = validateExtractionContract(contract);
  if (!validation.valid) errors.push(...validation.errors.map(error => `extractionContract: ${error}`));
  if (manifest.kind === "visible_html_table" && (contract?.recordGroup !== undefined || contract?.fields?.some(field => typeof field?.sourceHeader !== "string"))) {
    errors.push("visible_html_table capabilities require table header fields and cannot include a recordGroup.");
  }
  if (manifest.kind === "visible_record_group" && (!contract?.recordGroup || contract?.fields?.some(field => typeof field?.sourceKey !== "string"))) {
    errors.push("visible_record_group capabilities require an exact recordGroup and sourceKey fields.");
  }
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
      if (!new Set(["resolver", "integration", "outcome", "live"]).has(qualification.level)) errors.push("Qualified capabilities require an explicit qualification level.");
      if (qualification.level !== "resolver") errors.push("Visible extraction manifests support resolver-level qualification only; application outcomes require a separate benchmark receipt.");
      for (const field of ["providerId", "providerIdentity", "sourceRevision", "oracleReference"]) {
        if (typeof qualification[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(qualification[field])) {
          errors.push(`Qualified capabilities require a bounded ${field}.`);
        }
      }
      if (!Number.isSafeInteger(qualification.scenarioSeed) || qualification.scenarioSeed < 0) errors.push("Qualified capabilities require a non-negative scenario seed.");
      const cleanup = qualification.cleanupResult;
      if (!cleanup || typeof cleanup !== "object" || !new Set(["verified", "unverified", "not_applicable"]).has(cleanup.status)) {
        errors.push("Qualified capabilities require a cleanup result.");
      } else {
        if (Object.keys(cleanup).some(key => !["status", "reasonCode"].includes(key))) errors.push("Qualification cleanup result contains unsupported fields.");
        if (cleanup.status === "not_applicable" && (typeof cleanup.reasonCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(cleanup.reasonCode))) {
          errors.push("Not-applicable cleanup requires a structural reason code.");
        }
      }
      if (typeof qualification.independentApplicationOutcome !== "boolean") errors.push("Qualified capabilities must state whether an independent application outcome was checked.");
      if ((qualification.level === "resolver" || qualification.level === "integration") && qualification.independentApplicationOutcome !== false) {
        errors.push("Resolver and integration qualifications cannot claim an independent application outcome.");
      }
      if ((qualification.level === "outcome" || qualification.level === "live") && qualification.independentApplicationOutcome !== true) {
        errors.push("Outcome and live qualifications require an independent application outcome.");
      }
      if (qualification.level === "live" && (typeof qualification.liveAuthorizationRef !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(qualification.liveAuthorizationRef))) {
        errors.push("Live qualification requires a scoped authorization reference.");
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function cloneCapabilityManifest(manifest) {
  return Object.freeze(structuredClone(manifest));
}
