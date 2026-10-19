import { launchOwnedChrome } from "../src/browser/ownedChrome.js";

const SITES = Object.freeze([
  {
    id: "open-library-search",
    url: "https://openlibrary.org/search?q=computer+vision",
    goal: "Find computer vision books and their authors"
  },
  {
    id: "nasa-news",
    url: "https://www.nasa.gov/news/",
    goal: "Find the latest Mars mission news story"
  },
  {
    id: "mdn-form-docs",
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form",
    goal: "Find the attributes for an HTML form"
  },
  {
    id: "wikipedia-article",
    url: "https://en.wikipedia.org/wiki/Neural_network",
    goal: "Read the history section about neural networks"
  }
]);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function summarizeObservation(site, observation) {
  const roles = {};
  const interactionMechanics = {};
  const interactionReadiness = {};
  for (const candidate of observation.candidates ?? []) {
    roles[candidate.role] = (roles[candidate.role] ?? 0) + 1;
  }
  const semanticPage = observation.semanticPage;
  for (const control of semanticPage?.controls ?? []) {
    const mechanic = control.interaction?.mechanic ?? "unknown";
    const readiness = control.interaction?.readiness ?? "unknown";
    interactionMechanics[mechanic] = (interactionMechanics[mechanic] ?? 0) + 1;
    interactionReadiness[readiness] = (interactionReadiness[readiness] ?? 0) + 1;
  }
  return {
    siteId: site.id,
    requestedUrl: site.url,
    observedUrl: observation.page?.url ?? null,
    title: observation.page?.title ?? "",
    status: "observed",
    task: site.goal,
    candidateCoverage: {
      pageCandidateCount: observation.candidateCoverage?.pageCandidateCount ?? null,
      returnedCandidateCount: observation.candidateCoverage?.returnedCandidateCount ?? null,
      pageCoverage: observation.candidateCoverage?.pageCoverage ?? "unknown",
      selectionScope: observation.candidateCoverage?.selectionScope ?? "unknown",
      scopeCandidateCount: observation.candidateCoverage?.scopeCandidateCount ?? null,
      returnedScopeCandidateCount: observation.candidateCoverage?.returnedScopeCandidateCount ?? null,
      scopeCoverage: observation.candidateCoverage?.scopeCoverage ?? "unknown"
    },
    captureMetrics: {
      durationMs: observation.captureMetrics?.captureDurationMs ?? null,
      serializedEvidenceBytes: observation.captureMetrics?.serializedEvidenceBytes ?? null,
      domNodeCount: observation.captureMetrics?.domNodeCount ?? null,
      accessibilityNodeCount: observation.captureMetrics?.accessibilityNodeCount ?? null,
      documentIndexBuildCount: observation.captureMetrics?.documentIndexBuildCount ?? null,
      documentIndexBuildMs: observation.captureMetrics?.documentIndexBuildMs ?? null,
      candidateDerivationMs: observation.captureMetrics?.candidateDerivationMs ?? null,
      semanticCompilationMs: observation.captureMetrics?.semanticCompilationMs ?? null,
      heapDeltaBytes: observation.captureMetrics?.heapBeforeBytes != null && observation.captureMetrics?.heapAfterBytes != null
        ? observation.captureMetrics.heapAfterBytes - observation.captureMetrics.heapBeforeBytes : null,
      rssDeltaBytes: observation.captureMetrics?.rssBeforeBytes != null && observation.captureMetrics?.rssAfterBytes != null
        ? observation.captureMetrics.rssAfterBytes - observation.captureMetrics.rssBeforeBytes : null
    },
    candidateRoles: roles,
    semanticSchemaVersion: semanticPage?.schemaVersion ?? null,
    semanticPage: {
      pageType: semanticPage?.page?.pageType ?? null,
      interactionMechanics,
      interactionReadiness,
      controlsLinkedToRecord: (semanticPage?.controls ?? []).filter(control => control.collectionRef && control.recordRef).length,
      regions: (semanticPage?.regions ?? []).map(region => ({
        kind: region.kind,
        label: region.label?.value ?? null,
        controlCount: region.controlRefs?.length ?? 0
      })),
      forms: (semanticPage?.forms ?? []).map(form => ({
        method: form.method,
        controlCount: form.controlRefs?.length ?? 0,
        submitControlCount: form.submitControlRefs?.length ?? 0,
        effect: form.effect
      })),
      collections: (semanticPage?.collections ?? []).map(collection => ({
        kind: collection.kind,
        visibleCount: collection.visibleCount,
        completeness: collection.completeness,
        recordBindingStatus: collection.recordBindingStatus ?? "unknown",
        fields: (collection.fields ?? []).slice(0, 12).map(field => ({
          name: field.name,
          semanticRole: field.semanticRole ?? null,
          semanticRoleStatus: field.semanticRoleStatus ?? "unknown",
          labelStatus: field.label?.status ?? "unknown"
        })),
        sampleRecords: (collection.items ?? []).slice(0, 3).map(record => ({
          fields: (record.fields ?? []).slice(0, 8).map(field => ({
            name: field.name,
            semanticRole: field.semanticRole ?? null,
            value: typeof field.value === "string" ? field.value.slice(0, 120) : "",
            status: field.status
          })),
          controlCount: record.controlRefs?.length ?? 0
        }))
      })),
      warnings: semanticPage?.warnings ?? []
    },
    leadingCandidates: (observation.candidates ?? []).slice(0, 8).map(candidate => ({
      role: candidate.role,
      name: candidate.name,
      contextName: candidate.contextName
    }))
  };
}

async function observeSite(site) {
  let owned;
  try {
    owned = await launchOwnedChrome({
      initialUrl: site.url,
      headed: true,
      displayMode: "current-display",
      preserveProfile: false,
      reuseExisting: false
    });
    await sleep(2_000);
    const observation = await owned.session.observe({ profile: "interaction", selectionGoal: site.goal });
    const initialCoverage = observation.candidateCoverage;
    const shouldExpandScope = initialCoverage?.selectionScope === "task_relevant_region"
      && initialCoverage.scopeCoverage === "incomplete"
      && Number.isInteger(initialCoverage.scopeCandidateCount)
      && initialCoverage.scopeCandidateCount > (initialCoverage.returnedScopeCandidateCount ?? 0)
      && initialCoverage.scopeCandidateCount <= 384;
    if (!shouldExpandScope) {
      const result = summarizeObservation(site, observation);
      if (initialCoverage?.scopeCoverage === "incomplete") result.scopeExpansion = {
        status: "not_attempted",
        reasonCode: initialCoverage.selectionScope === "task_relevant_region"
          ? "task_scope_exceeds_expansion_bound" : "task_scope_not_localized"
      };
      return result;
    }
    try {
      const expanded = await owned.session.observe({ profile: "interaction", selectionGoal: site.goal, candidateLimit: 384 });
      if (expanded.targetId !== observation.targetId || expanded.evidenceId === observation.evidenceId) {
        const result = summarizeObservation(site, observation);
        result.scopeExpansion = { status: "failed", reasonCode: "expanded_observation_identity_invalid" };
        return result;
      }
      const result = summarizeObservation(site, expanded);
      result.scopeExpansion = {
        status: expanded.candidateCoverage?.scopeCoverage === "complete" ? "expanded_complete" : "still_incomplete",
        initialScopeCandidateCount: initialCoverage.scopeCandidateCount,
        initialReturnedScopeCandidateCount: initialCoverage.returnedScopeCandidateCount,
        expandedScopeCandidateCount: expanded.candidateCoverage?.scopeCandidateCount ?? null,
        expandedReturnedScopeCandidateCount: expanded.candidateCoverage?.returnedScopeCandidateCount ?? null
      };
      return result;
    } catch (error) {
      const result = summarizeObservation(site, observation);
      result.scopeExpansion = {
        status: "failed",
        reasonCode: "expanded_observation_unavailable",
        errorName: String(error?.name ?? "Error").slice(0, 64)
      };
      return result;
    }
  } catch (error) {
    return {
      siteId: site.id,
      requestedUrl: site.url,
      status: "failed",
      failure: String(error?.message ?? error).slice(0, 300)
    };
  } finally {
    await owned?.close().catch(() => {});
  }
}

const results = [];
for (const site of SITES) {
  process.stderr.write(`Observing public site: ${site.id}\n`);
  results.push(await observeSite(site));
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  mode: "headed_native_cdp_observation_only",
  inferenceCalls: 0,
  browserActions: 0,
  results
}, null, 2)}\n`);

if (results.some(result => result.status !== "observed")) process.exitCode = 1;
