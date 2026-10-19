import { discoverPageNumberQueryParameters, discoverVirtualizedListScrollTarget, discoverVisibleNextPage, discoverVisibleTableSources, discoverVisibleTables } from "../extraction/recordResolver.js";
import { discoverVisibleRecordGroups } from "../extraction/recordGroupResolver.js";
import { buildDocumentIndex } from "../observe/documentIndex.js";

/** Return structural candidates from one retained, sanitized observation. */
export function discoverTableCapabilities({ observation, domSnapshot, environmentId, applicationId, principalId, documentIndex: suppliedIndex = null } = {}) {
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
  const documentIndex = suppliedIndex ?? buildDocumentIndex(domSnapshot);
  const tables = discoverVisibleTables(domSnapshot, { index: documentIndex });
  const tableSources = discoverVisibleTableSources(domSnapshot, { maxRecords: 0, index: documentIndex });
  const recordGroups = discoverVisibleRecordGroups(domSnapshot, { index: documentIndex });
  const relNext = discoverVisibleNextPage(domSnapshot, observation.page.url, { index: documentIndex, kind: "rel_next_same_path" });
  const explicitNext = discoverVisibleNextPage(domSnapshot, observation.page.url, { index: documentIndex, kind: "explicit_next_same_path" });
  const pageNumberParameters = discoverPageNumberQueryParameters(domSnapshot, observation.page.url, { index: documentIndex });
  const tableCandidates = tables.map(table => {
    const tableBounds = tableSources[table.tableIndex]?.bounds ?? null;
    return ({
    kind: "visible_html_table",
    origin,
    environmentId: environmentId ?? null,
    applicationId: applicationId ?? null,
    pagePath,
    ...(() => {
      const methods = [];
      if (relNext.status === "available") methods.push("rel_next_same_path");
      if (explicitNext.status === "available") methods.push("explicit_next_same_path");
      if (pageNumberParameters.length) methods.push("page_number_query");
      if (discoverVirtualizedListScrollTarget(observation, tableBounds).status === "available") methods.push("virtualized_list");
      return methods.length ? { paginationMethods: methods } : {};
    })(),
    ...(pageNumberParameters.length ? { paginationQueryParameters: pageNumberParameters } : {}),
    ...(principalId ? { principalId } : {}),
    observationId: observation.evidenceId,
    tableIndex: table.tableIndex,
    headers: [...table.headers],
    visibleRowCount: table.visibleRowCount,
    qualificationStatus: "candidate"
  });
  });
  const groupCandidates = recordGroups.map(group => ({
    kind: "visible_record_group",
    origin,
    environmentId: environmentId ?? null,
    applicationId: applicationId ?? null,
    pagePath,
    documentIndex: group.documentIndex,
    frameId: group.frameId,
    frameTargetId: group.frameTargetId,
    parentFrameId: group.parentFrameId,
    ...(() => {
      const methods = [];
      if (relNext.status === "available") methods.push("rel_next_same_path");
      if (explicitNext.status === "available") methods.push("explicit_next_same_path");
      if (pageNumberParameters.length) methods.push("page_number_query");
      return methods.length ? { paginationMethods: methods } : {};
    })(),
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
