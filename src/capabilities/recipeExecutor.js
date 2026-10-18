import { fieldIsPermitted } from "../extraction/extractionContract.js";
import { discoverVisibleNextPage, resolveVisibleTableRecords } from "../extraction/recordResolver.js";
import { resolveVisibleRecordGroupRecords } from "../extraction/recordGroupResolver.js";

function applicationIdFor(environment, origin) {
  return environment?.applications?.find(application => application.origin === origin)?.applicationId ?? null;
}

/** Read a registered recipe from one fresh observation; never dispatches effects. */
export async function executeExtractionCapability({ capabilityId, capabilityVersion = 1, registry, session, environment, principalId, authorizeField } = {}) {
  if (!session || typeof session.observe !== "function" || typeof session.observer?.getEvidence !== "function") {
    return { status: "unavailable", reasonCode: "browser_observation_unavailable" };
  }
  const observation = await session.observe();
  if (!observation?.evidenceId || observation.documentGeneration !== session.documentGeneration) {
    return { status: "uncertain", reasonCode: "fresh_observation_unavailable", evidenceId: observation?.evidenceId ?? null };
  }
  let url;
  try { url = new URL(observation.page.url); }
  catch { return { status: "blocked", reasonCode: "page_origin_unavailable", evidenceId: observation.evidenceId };
  }
  const environmentId = environment?.environmentId ?? environment?.id ?? null;
  const applicationId = applicationIdFor(environment, url.origin);
  const manifest = registry?.resolve?.(capabilityId, { capabilityVersion, origin: url.origin, environmentId, applicationId, principalId });
  if (!manifest) return { status: "blocked", reasonCode: "capability_not_registered_for_current_scope", evidenceId: observation.evidenceId };
  if (url.pathname !== manifest.pagePath) return { status: "blocked", reasonCode: "capability_route_mismatch", evidenceId: observation.evidenceId };
  const fieldScope = {
    origin: manifest.origin,
    environmentId: manifest.environmentId,
    applicationId: manifest.applicationId
  };
  const deniedFields = manifest.extractionContract.fields.filter(field => !fieldIsPermitted({ ...field, ...fieldScope }, authorizeField));
  if (deniedFields.length) return { status: "blocked", reasonCode: "field_release_policy_denied", evidenceId: observation.evidenceId };
  const evidence = session.observer.getEvidence(observation.evidenceId, { facets: ["domSnapshot"] });
  if (evidence?.status !== "available" || !evidence.domSnapshot) {
    return { status: "uncertain", reasonCode: "retained_dom_evidence_unavailable", evidenceId: observation.evidenceId };
  }
  const resolved = manifest.kind === "visible_record_group"
    ? resolveVisibleRecordGroupRecords(evidence.domSnapshot, manifest.extractionContract)
    : resolveVisibleTableRecords(evidence.domSnapshot, manifest.extractionContract);
  if (resolved.status !== "available") return {
    status: resolved.status === "ambiguous" ? "blocked" : "incomplete",
    reasonCode: `${manifest.kind === "visible_record_group" ? "visible_record_group" : "visible_table"}_${resolved.status}`,
    evidenceId: observation.evidenceId,
    capabilityId: manifest.capabilityId,
    capabilityVersion: manifest.capabilityVersion,
    contract: manifest.extractionContract,
    observation,
    pageIdentity: url.href,
    pageUrl: url.origin + url.pathname,
    records: [],
    evidence: []
  };
  return {
    status: "available",
    capabilityId: manifest.capabilityId,
    capabilityVersion: manifest.capabilityVersion,
    contract: manifest.extractionContract,
    observation,
    pageIdentity: url.href,
    records: resolved.records,
    truncated: resolved.truncated === true,
    evidence: resolved.evidence,
    headers: resolved.headers,
    ...(manifest.extractionContract.pagination
      ? { nextPage: discoverVisibleNextPage(evidence.domSnapshot, url.href) }
      : { nextPage: { status: "not_configured" } }),
    pageUrl: url.origin + url.pathname
  };
}
