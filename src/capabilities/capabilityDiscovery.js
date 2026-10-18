import { discoverVisibleNextPage, discoverVisibleTables } from "../extraction/recordResolver.js";
import { discoverVisibleRecordGroups } from "../extraction/recordGroupResolver.js";

/** Return structural candidates from one retained, sanitized observation. */
export function discoverTableCapabilities({ observation, domSnapshot, environmentId, applicationId, principalId } = {}) {
  if (!observation?.evidenceId || typeof observation.page?.url !== "string") {
    return { status: "unavailable", candidates: [], reasonCode: "fresh_observation_required" };
  }
  let origin;
  let pagePath;
  try {
    const pageUrl = new URL(observation.page.url);
    origin = pageUrl.origin;
    pagePath = pageUrl.pathname;
  }
  catch { return { status: "unavailable", candidates: [], reasonCode: "page_origin_unavailable" }; }
  const tables = discoverVisibleTables(domSnapshot);
  const recordGroups = discoverVisibleRecordGroups(domSnapshot);
  const pagination = discoverVisibleNextPage(domSnapshot, observation.page.url);
  const tableCandidates = tables.map(table => ({
    kind: "visible_html_table",
    origin,
    environmentId: environmentId ?? null,
    applicationId: applicationId ?? null,
    pagePath,
    ...(pagination.status === "available" ? { paginationMethods: ["rel_next_same_path"] } : {}),
    ...(principalId ? { principalId } : {}),
    observationId: observation.evidenceId,
    tableIndex: table.tableIndex,
    headers: [...table.headers],
    visibleRowCount: table.visibleRowCount,
    qualificationStatus: "candidate"
  }));
  const groupCandidates = recordGroups.map(group => ({
    kind: "visible_record_group",
    origin,
    environmentId: environmentId ?? null,
    applicationId: applicationId ?? null,
    pagePath,
    ...(pagination.status === "available" ? { paginationMethods: ["rel_next_same_path"] } : {}),
    ...(principalId ? { principalId } : {}),
    observationId: observation.evidenceId,
    recordGroup: group.recordGroup,
    fields: group.fields.map(field => ({ ...field })),
    visibleRowCount: group.visibleRecordCount,
    truncated: group.truncated,
    qualificationStatus: "candidate"
  }));
  const candidates = [...tableCandidates, ...groupCandidates];
  return {
    status: candidates.length ? "candidate" : "empty",
    candidates
  };
}
