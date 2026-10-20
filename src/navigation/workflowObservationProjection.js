function safeOrigin(value) {
  try { return new URL(value).origin; }
  catch { return "unknown"; }
}

export function workflowTargetSignature(candidate) {
  return Object.freeze({
    tag: String(candidate?.tag ?? candidate?.kind ?? "unknown").slice(0, 32),
    role: String(candidate?.role ?? candidate?.kind ?? "unknown").slice(0, 48),
    name: String(candidate?.name ?? "").slice(0, 240),
    contextName: String(candidate?.contextName ?? "").slice(0, 120),
    href: String(candidate?.href ?? "").slice(0, 256),
    type: String(candidate?.type ?? "").slice(0, 32),
    pointerInteraction: candidate?.pointerInteraction === true
  });
}

const TASK_TERM_STOPWORDS = new Set(["the", "and", "for", "from", "into", "with", "that", "this", "then", "open", "click", "find", "get", "show", "please", "page", "site", "browser", "use", "complete", "workflow", "task", "section", "sections", "step", "steps", "next", "all", "every", "link", "button", "input", "control", "controls", "element", "field", "target", "candidate"]);
const ORDINAL_ALIASES = Object.freeze({
  first: ["one"],
  second: ["two"],
  third: ["three"],
  fourth: ["four"]
});

function taskRelevanceTerms(selectionGoal, taskIntent) {
  const sources = [selectionGoal, taskIntent?.purposeCode, taskIntent?.outcomeCode,
    ...(taskIntent?.targetRoles ?? []), ...(taskIntent?.constraints ?? [])];
  const terms = new Set();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    for (const term of source.slice(0, 2048).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
      if (!TASK_TERM_STOPWORDS.has(term)) {
        terms.add(term);
        for (const alias of ORDINAL_ALIASES[term] ?? []) terms.add(alias);
      }
      if (terms.size >= 48) return terms;
    }
  }
  return terms;
}

function matchesTaskTerms(candidate, terms) {
  if (!terms.size) return false;
  const haystack = [candidate?.name, candidate?.contextName, candidate?.role, candidate?.tag,
    candidate?.type, candidate?.label, candidate?.ariaLabel, candidate?.semanticRecordContext]
    .filter(value => typeof value === "string").join(" ").normalize("NFKC").toLowerCase();
  const observedTerms = new Set(haystack.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  for (const term of terms) if (observedTerms.has(term)) return true;
  return false;
}

function semanticRecordTaskScore(record, terms) {
  if (!terms.size || !Array.isArray(record?.fields)) return 0;
  const fieldText = record.fields.map(field => field?.value).filter(value => typeof value === "string").join(" ")
    .normalize("NFKC").toLowerCase();
  const fieldTerms = new Set(fieldText.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  let score = 0;
  for (const term of terms) if (fieldTerms.has(term)) score++;
  return score;
}

export function compileWorkflowObservation(observation, { includeLabels = false, maxCandidates = 160, selectionGoal = "", taskIntent = null } = {}) {
  if (!observation?.evidenceId || !observation?.page?.url) throw new Error("Workflow synthesis requires one fresh browser observation.");
  const candidates = [];
  const bindings = new Map();
  const allCandidates = Array.isArray(observation.candidates) ? observation.candidates.slice(0, 10_000) : [];
  const allScrollTargets = Array.isArray(observation.scrollTargets) ? observation.scrollTargets.slice(0, 10_000) : [];
  const semanticPage = observation.semanticPage && [1, 2, 3].includes(observation.semanticPage.schemaVersion) ? observation.semanticPage : null;
  const semanticMechanicValues = new Set(["follow_link", "enter_text", "choose_option", "toggle_control", "activate_control", "submit_form", "unknown"]);
  const semanticReadinessValues = new Set(["visible_enabled", "disabled", "not_visible", "unknown"]);
  const semanticInteractionProjection = value => ({
    mechanic: semanticMechanicValues.has(value?.mechanic) ? value.mechanic : "unknown",
    readiness: semanticReadinessValues.has(value?.readiness) ? value.readiness : "unknown",
    evidence: value?.mechanic && value.mechanic !== "unknown" ? "native_dom_accessibility_semantics" : null
  });
  const semanticControls = new Map((semanticPage?.controls ?? []).map(control => [control.targetRef, control]));
  const semanticRegions = new Map((semanticPage?.regions ?? []).map(region => [region.ref, region]));
  const semanticRecords = new Map((semanticPage?.collections ?? []).flatMap(collection => (collection.items ?? []).map(item => [item.ref, item])));
  const semanticCandidate = candidate => {
    const control = semanticControls.get(candidate.identity);
    const region = control?.regionRef ? semanticRegions.get(control.regionRef) : null;
    const record = control?.recordRef ? semanticRecords.get(control.recordRef) : null;
    return {
      ...candidate,
      label: region?.label?.value ?? "",
      semanticKind: control?.classification?.value ?? "",
      semanticInteraction: semanticInteractionProjection(control?.interaction),
      semanticRegionKind: region?.kind ?? "",
      semanticFormRef: control?.formRef ?? "",
      semanticCollectionRef: control?.collectionRef ?? "",
      semanticRecordContext: (record?.fields ?? []).map(field => field.value).filter(value => typeof value === "string").join(" ").slice(0, 1_024)
    };
  };
  const pageCandidateCount = semanticPage?.candidateCoverage?.pageCandidateCount ?? allCandidates.length;
  const pageScrollTargetCount = allScrollTargets.length;
  const relevanceTerms = taskRelevanceTerms(selectionGoal, taskIntent);
  const recordScores = (semanticPage?.collections ?? []).flatMap(collection => (collection.items ?? []).map(record => ({
    ref: record.ref,
    score: semanticRecordTaskScore(record, relevanceTerms)
  })));
  const bestRecordScore = Math.max(0, ...recordScores.map(item => item.score));
  const taskMatchedRecordRefs = new Set(bestRecordScore > 0
    ? recordScores.filter(item => item.score === bestRecordScore).map(item => item.ref)
    : []);
  const relevantCandidates = allCandidates.filter(candidate => {
    const control = semanticControls.get(candidate.identity);
    if (taskMatchedRecordRefs.size && control?.recordRef && !taskMatchedRecordRefs.has(control.recordRef)) return false;
    return matchesTaskTerms(semanticCandidate(candidate), relevanceTerms);
  });
  const relevantScrollTargets = allScrollTargets.filter(target => matchesTaskTerms(target, relevanceTerms));
  const relevantRegions = new Set(relevantCandidates.map(candidate =>
    String(candidate?.contextName ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()).filter(Boolean));
  const relevantSemanticRegions = new Set(relevantCandidates.map(candidate => semanticControls.get(candidate.identity)?.regionRef)
    .filter(ref => {
      const kind = semanticRegions.get(ref)?.kind;
      return ["article", "section", "form", "fieldset", "table"].includes(kind);
    }));
  const relevantCollections = new Set(relevantCandidates.map(candidate => semanticControls.get(candidate.identity)?.collectionRef).filter(Boolean));
  const relevantForms = new Set(relevantCandidates.map(candidate => semanticControls.get(candidate.identity)?.formRef).filter(Boolean));
  const relevantRecords = new Set(relevantCandidates.map(candidate => semanticControls.get(candidate.identity)?.recordRef).filter(Boolean));
  const hasRecordScopedMatch = relevantRecords.size > 0;
  const relevantKinds = new Set(!semanticPage
    ? relevantCandidates.filter(candidate => !candidate?.contextName).map(candidate => `${candidate?.role ?? ""}\u001f${candidate?.tag ?? ""}`)
    : []);
  const scopedCandidates = relevantCandidates.length
    ? allCandidates.filter(candidate => relevantCandidates.includes(candidate)
      || (hasRecordScopedMatch && relevantRecords.has(semanticControls.get(candidate.identity)?.recordRef))
      || (relevantCollections.has(semanticControls.get(candidate.identity)?.collectionRef)
        && (!hasRecordScopedMatch || !semanticControls.get(candidate.identity)?.recordRef))
      || (!hasRecordScopedMatch && relevantSemanticRegions.has(semanticControls.get(candidate.identity)?.regionRef))
      || (!hasRecordScopedMatch && relevantForms.has(semanticControls.get(candidate.identity)?.formRef))
      || (!hasRecordScopedMatch && relevantRegions.has(String(semanticCandidate(candidate)?.contextName ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()))
      || (!semanticPage && !candidate?.contextName && relevantKinds.has(`${candidate?.role ?? ""}\u001f${candidate?.tag ?? ""}`)))
    : relevantCandidates;
  const taskScoped = (relevantCandidates.length > 0 || relevantScrollTargets.length > 0)
    && (scopedCandidates.length < pageCandidateCount || relevantScrollTargets.length < pageScrollTargetCount);
  const selectedCandidates = taskScoped ? scopedCandidates : allCandidates;
  const selectedScrollTargets = taskScoped && relevantScrollTargets.length > 0 ? relevantScrollTargets : taskScoped ? [] : allScrollTargets;
  const candidateCount = selectedCandidates.length;
  const scrollTargetCount = selectedScrollTargets.length;
  const selectedFormRecords = semanticPage
    ? semanticPage.forms.filter(form => selectedCandidates.some(candidate => semanticControls.get(candidate.identity)?.formRef === form.ref)).slice(0, 24)
    : [];
  const projectedFormRefs = new Map(selectedFormRecords.map((form, index) => [form.ref, `form_${index + 1}`]));
  const appendTarget = (candidate, kind) => {
    if (candidates.length >= maxCandidates) return;
    const candidateRef = `${kind}_${candidates.length + 1}`;
    const binding = Object.freeze({
      candidateRef,
      identity: candidate.identity,
      kind,
      signature: workflowTargetSignature(candidate)
    });
    bindings.set(candidateRef, binding);
    candidates.push({
      candidateRef,
      kind,
      tag: binding.signature.tag,
      role: binding.signature.role,
      visible: candidate.visible === true,
      disabled: candidate.disabled === true,
      ...(semanticControls.has(candidate.identity) ? {
        semanticKind: semanticControls.get(candidate.identity).classification.value,
        semanticStatus: semanticControls.get(candidate.identity).classification.status,
        semanticInteraction: semanticInteractionProjection(semanticControls.get(candidate.identity).interaction),
        regionRef: semanticControls.get(candidate.identity).regionRef,
        formRef: projectedFormRefs.get(semanticControls.get(candidate.identity).formRef) ?? null,
        collectionRef: semanticControls.get(candidate.identity).collectionRef,
        recordRef: semanticControls.get(candidate.identity).recordRef ?? null
      } : {}),
      ...(includeLabels ? {
        label: binding.signature.name,
        context: binding.signature.contextName,
        href: binding.signature.href || null,
        inputType: binding.signature.type || null
      } : {})
    });
  };
  for (const candidate of selectedCandidates) appendTarget(candidate, "candidate");
  for (const target of selectedScrollTargets) appendTarget(target, "scroll");
  const submittedCandidateCount = candidates.filter(candidate => candidate.kind === "candidate").length;
  const submittedScrollTargetCount = candidates.filter(candidate => candidate.kind === "scroll").length;
  const truncated = submittedCandidateCount < candidateCount || submittedScrollTargetCount < scrollTargetCount;
  const upstreamCoverage = semanticPage?.candidateCoverage ?? observation.candidateCoverage ?? null;
  const upstreamTaskScopeComplete = relevanceTerms.size > 0
    && upstreamCoverage?.selectionScope === "task_relevant_region"
    && upstreamCoverage?.scopeCoverage === "complete";
  const coverageComplete = !truncated && (upstreamCoverage?.truncated !== true || upstreamTaskScopeComplete);
  const selectedRegionRefs = new Set(selectedCandidates.map(candidate => semanticControls.get(candidate.identity)?.regionRef).filter(Boolean));
  const selectedCollectionRefs = new Set(selectedCandidates.map(candidate => semanticControls.get(candidate.identity)?.collectionRef).filter(Boolean));
  const selectedRecordRefs = new Set(selectedCandidates.map(candidate => semanticControls.get(candidate.identity)?.recordRef).filter(Boolean));
  const candidateRefByIdentity = new Map([...bindings.values()].map(binding => [binding.identity, binding.candidateRef]));
  const semanticProjection = semanticPage ? {
    schemaVersion: 3,
    pageType: {
      value: ["article", "tabular_data", "repeated_content", "form", "navigation", "unknown"].includes(semanticPage.page?.pageType?.value)
        ? semanticPage.page.pageType.value : "unknown",
      status: ["observed", "inferred", "unknown"].includes(semanticPage.page?.pageType?.status)
        ? semanticPage.page.pageType.status : "unknown"
    },
    // Keep the typed semantic-page shape stable when labels are withheld.
    // An empty outline means "redacted", whereas omission violates the
    // versioned compiler contract and used to be reported as a privacy error.
    outline: includeLabels
      ? semanticPage.page.outline.slice(0, 32).map(item => ({ level: item.level, text: item.text, status: item.status }))
      : [],
    candidateCoverage: {
      pageCandidateCount: upstreamCoverage.pageCandidateCount,
      pageCoverage: upstreamCoverage.pageCoverage,
      selectionScope: upstreamCoverage.selectionScope,
      scopeCandidateCount: upstreamCoverage.scopeCandidateCount,
      scopeCoverage: upstreamCoverage.scopeCoverage
    },
    regions: semanticPage.regions.filter(region => selectedRegionRefs.has(region.ref) || !taskScoped).slice(0, 32).map(region => ({
      ref: region.ref,
      kind: region.kind,
      tag: region.tag,
      label: includeLabels
        ? { value: region.label.value, status: region.label.status, source: region.label.source ?? null }
        : region.label.status === "unknown"
          ? { value: null, status: "unknown", source: null }
          : { value: null, status: "redacted", source: null }
    })),
    forms: selectedFormRecords.map(form => ({
      ref: projectedFormRefs.get(form.ref),
      method: form.method,
      controlCount: form.controlRefs.length,
      submitControlCount: form.submitControlRefs.length,
      effect: "unknown"
    })),
    collections: semanticPage.collections.filter(collection => selectedCollectionRefs.has(collection.ref) || !taskScoped).slice(0, 24).map(collection => ({
      ref: collection.ref,
      kind: collection.kind,
      status: collection.status,
      visibleCount: collection.visibleCount,
      completeness: collection.completeness,
      fieldCount: collection.fields.length,
      fieldsTruncated: collection.fieldsTruncated === true,
      itemsTruncated: collection.itemsTruncated === true,
      recordBindingStatus: ["unique", "ambiguous"].includes(collection.recordBindingStatus) ? collection.recordBindingStatus : "unknown",
      ...(includeLabels ? { fields: collection.fields.map(field => ({
        name: field.name,
        status: field.status,
        semanticRole: field.semanticRole ?? null,
        semanticRoleStatus: field.semanticRoleStatus ?? "unknown",
        label: field.label ?? { value: null, status: "unknown", source: null },
        evidenceRef: field.evidenceRef ?? null
      })) } : {}),
      records: (collection.items ?? []).filter(item => selectedRecordRefs.has(item.ref)).slice(0, 64).map(item => ({
        ref: item.ref,
        ordinal: item.ordinal,
        fields: item.fields.slice(0, 16).map(field => ({
          name: includeLabels ? field.name : "",
          value: includeLabels ? field.value : null,
          status: includeLabels ? field.status : field.status === "unknown" ? "unknown" : "redacted",
          semanticRole: includeLabels ? field.semanticRole ?? null : null,
          semanticRoleStatus: includeLabels ? field.semanticRoleStatus ?? "unknown" : "redacted",
          label: includeLabels ? field.label : { value: null, status: "redacted", source: null },
          valueRef: field.valueRef ?? field.evidenceRef ?? null,
          truncated: field.truncated === true
        })),
        controlRefs: item.controlRefs.map(identity => candidateRefByIdentity.get(identity)).filter(Boolean).slice(0, 160)
      }))
    })),
    warnings: (semanticPage.warnings ?? []).filter(value => [
      "candidate_list_truncated", "task_scope_incomplete", "heading_list_truncated",
      "closed_shadow_dom_not_observed", "collection_completeness_unknown",
      "collection_items_truncated", "collection_fields_truncated", "collection_values_truncated"
    ].includes(value)).slice(0, 8),
    trust: semanticPage.trust
  } : null;
  return {
    projection: {
      observationId: observation.evidenceId,
      pageOrigin: safeOrigin(observation.page.url),
      title: includeLabels ? String(observation.page.title ?? "").slice(0, 160) : "",
      headings: includeLabels ? (observation.headings ?? []).slice(0, 32).map(item => String(item.text ?? "").slice(0, 160)) : [],
      ...(semanticProjection ? { semanticPage: semanticProjection } : {}),
      candidateCoverage: {
        candidateCount,
        scopedCandidateCount: candidateCount,
        submittedCandidateCount,
        scrollTargetCount,
        submittedScrollTargetCount,
        disposition: coverageComplete ? "complete" : "incomplete",
        selectionScope: taskScoped || upstreamTaskScopeComplete ? "task_relevant_region" : "page",
        pageCandidateCount,
        pageScrollTargetCount,
        pageCoverage: upstreamCoverage?.pageCoverage === "partial" || taskScoped || truncated ? "partial" : "complete",
        scopeCoverage: coverageComplete ? "complete" : "incomplete"
      },
      candidates
    },
    bindings,
    coverageComplete
  };
}
