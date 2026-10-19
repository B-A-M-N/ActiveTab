import { fieldIsPermitted } from "../extraction/extractionContract.js";
import { discoverVirtualizedListScrollTarget, discoverVisibleNextPage, resolveVisibleTableRecords } from "../extraction/recordResolver.js";
import { resolveVisibleRecordGroupRecords } from "../extraction/recordGroupResolver.js";
import { resolveObservedApplication } from "../environments/model.js";
import { createHash } from "node:crypto";

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
  const application = resolveObservedApplication(environment, url.href);
  if (application.status !== "matched") return { status: "blocked", reasonCode: `application_identity_${application.status}`, evidenceId: observation.evidenceId };
  const applicationId = application.applicationId;
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
    pageIdentity: pageIdentity(url.href, resolved.records),
    cursorFingerprint: routeCursorFingerprint(url.href),
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
    pageIdentity: pageIdentity(url.href, resolved.records),
    cursorFingerprint: routeCursorFingerprint(url.href),
    records: resolved.records,
    truncated: resolved.truncated === true,
    evidence: resolved.evidence,
    headers: resolved.headers,
    ...(manifest.extractionContract.pagination
      ? { nextPage: manifest.extractionContract.pagination.kind === "virtualized_list"
          ? discoverVirtualizedListScrollTarget(observation, resolved.evidence?.[0]?.bounds)
          : discoverVisibleNextPage(evidence.domSnapshot, url.href, {
            kind: manifest.extractionContract.pagination.kind,
            queryParameter: manifest.extractionContract.pagination.queryParameter
          }) }
      : { nextPage: { status: "not_configured" } }),
    pageUrl: url.origin + url.pathname
  };
}

function pageIdentity(url, records) {
  const digest = createHash("sha256").update(JSON.stringify((records ?? []).map(record => record.values))).digest("hex");
  return `${url}#records-${digest}`;
}

function routeCursorFingerprint(value) {
  try {
    const url = new URL(value);
    return createHash("sha256").update(JSON.stringify([url.origin, url.pathname, url.search])).digest("hex");
  } catch { return null; }
}
