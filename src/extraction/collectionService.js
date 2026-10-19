import { OutputAccumulator } from "./outputAccumulator.js";
import { verifyExtractionResult } from "./extractionVerifier.js";
import { createHash } from "node:crypto";

const HARD_MAX_PAGES = 100;

export function extractionIdentityFingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function extractionPageCursorFingerprint(value) {
  try {
    const url = new URL(value);
    return extractionIdentityFingerprint(JSON.stringify([url.origin, url.pathname, url.search]));
  } catch { return null; }
}

function uniqueRecordKey(record, uniqueBy) {
  if (!uniqueBy.length) return null;
  const values = uniqueBy.map(field => record?.values?.[field]);
  if (values.some(value => value === null || value === undefined || value === "")) return null;
  return JSON.stringify(values);
}

function failureStatus(status) {
  if (status === "blocked") return "blocked";
  if (status === "incomplete") return "failed";
  return "uncertain";
}

/**
 * Collect one registered extraction capability across its declared pages.
 * Page loading and navigation are injected so callers can retain their own
 * authority, lease, receipt, and application-run boundaries.
 */
export async function collectExtractionPages({
  outputName,
  capabilityId,
  capabilityVersion = 1,
  accumulator = new OutputAccumulator(),
  initialContract = null,
  initialPageIdentities = [],
  initialPageIdentityFingerprints = [],
  initialCursorFingerprint = null,
  initialDuplicateRecordCount = 0,
  initialProgressVerified = true,
  allowTerminalDuplicatePage = false,
  executePage,
  advancePage = null,
  signal = null,
  onPageCollected = null,
  maxPages = HARD_MAX_PAGES
} = {}) {
  if (typeof outputName !== "string" || !outputName
    || typeof capabilityId !== "string" || !capabilityId
    || typeof executePage !== "function") {
    return { status: "blocked", reasonCode: "collection_contract_unavailable", output: null, pageCount: 0 };
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > HARD_MAX_PAGES) {
    return { status: "blocked", reasonCode: "collection_page_budget_invalid", output: null, pageCount: 0 };
  }

  const visitedPages = new Set([
    ...initialPageIdentities.filter(value => typeof value === "string" && value).map(extractionIdentityFingerprint),
    ...initialPageIdentityFingerprints.filter(value => /^[a-f0-9]{64}$/.test(value))
  ]);
  const visitedPageFingerprints = [...visitedPages];
  const cursorHistory = [];
  let previousCursorFingerprint = /^[a-f0-9]{64}$/.test(initialCursorFingerprint ?? "") ? initialCursorFingerprint : null;
  let duplicateRecordCount = Number.isInteger(initialDuplicateRecordCount) && initialDuplicateRecordCount >= 0
    ? initialDuplicateRecordCount : 0;
  let contract = initialContract;
  let pageCount = visitedPages.size;
  const outputContractId = `${capabilityId}@${capabilityVersion}`;

  const currentOutput = () => contract ? accumulator.finalize(outputName, contract) : null;
  const fail = (status, reasonCode) => {
    if (contract) accumulator.markIncomplete(outputName, reasonCode);
    const output = currentOutput();
    if (output) output.verification.paginationProgress = {
      previousCursor: cursorHistory.length > 1 ? cursorHistory.at(-2)?.nextCursor ?? null : null,
      nextCursor: cursorHistory.at(-1)?.nextCursor ?? previousCursorFingerprint,
      newlyObservedRecordCount: accumulator.get(outputName)?.records.length ?? 0,
      duplicateRecordCount,
      progressVerified: initialProgressVerified === true && cursorHistory.every(item => item.progressVerified),
      terminalEvidence: cursorHistory.at(-1)?.terminalEvidence ?? null,
      completeness: "incomplete"
    };
    return { status, reasonCode, output, contract, pageCount };
  };

  while (pageCount < maxPages) {
    if (signal?.aborted) return fail("uncertain", pageCount ? "canceled_during_collection" : "canceled_before_collection");
    let result;
    try { result = await executePage({ pageNumber: pageCount + 1, signal }); }
    catch { return fail("uncertain", "page_extraction_execution_failed"); }
    if (result?.contract) {
      if (contract && (contract.id !== result.contract.id
        || contract.maxRecords !== result.contract.maxRecords
        || contract.completionPolicy !== result.contract.completionPolicy)) {
        return fail("blocked", "registered_capability_contract_mismatch");
      }
      contract = result.contract;
    }

    if (result?.status !== "available") {
      if (contract && result?.observation
        && !accumulator.get(outputName)?.pageEvidence.some(item => item.observationId === result.observation.evidenceId)) {
        accumulator.append(outputName, outputContractId, {
          records: [], evidence: [], truncated: false
        }, {
          observationId: result.observation.evidenceId,
          pageUrl: result.pageUrl ?? null,
          maxRecords: contract.maxRecords
        });
      }
      return fail(failureStatus(result?.status), result?.reasonCode ?? "page_extraction_unavailable");
    }

    if (!contract || result.capabilityId !== capabilityId || result.capabilityVersion !== capabilityVersion
      || result.contract?.id !== contract.id || result.contract?.maxRecords !== contract.maxRecords) {
      return fail("blocked", "registered_capability_contract_mismatch");
    }
    if (typeof result.pageIdentity !== "string" || !result.pageIdentity) return fail("uncertain", "page_identity_unavailable");
    const pageIdentityFingerprint = extractionIdentityFingerprint(result.pageIdentity);
    const cursorFingerprint = result.cursorFingerprint ?? extractionPageCursorFingerprint(result.pageIdentity);
    if (visitedPages.has(pageIdentityFingerprint)) {
      const isResumedTerminalPage = allowTerminalDuplicatePage
        && pageIdentityFingerprint === visitedPageFingerprints.at(-1)
        && result.nextPage?.status === "not_found"
        && Array.isArray(result.records) && result.records.length > 0;
      if (!isResumedTerminalPage) return fail("failed", "pagination_cycle_detected");
      accumulator.markPaginationExhausted(outputName);
      const terminalEvidence = {
        kind: "visible_next_control_absent_on_nonempty_page",
        observationId: result.observation.evidenceId,
        pageIdentityFingerprint,
        recordCount: result.records.length
      };
      const output = currentOutput();
      output.verification.paginationProgress = {
        previousCursor: previousCursorFingerprint,
        nextCursor: cursorFingerprint,
        newlyObservedRecordCount: accumulator.get(outputName)?.records.length ?? 0,
        duplicateRecordCount,
        progressVerified: true,
        terminalEvidence,
        completeness: "complete"
      };
      const verification = verifyExtractionResult(output);
      if (verification.status !== "complete") return fail("failed", "extraction_verification_failed");
      return { status: "complete", output, contract, pageCount, verification, progress: output.verification.paginationProgress };
    }
    visitedPages.add(pageIdentityFingerprint);
    visitedPageFingerprints.push(pageIdentityFingerprint);
    if (!result.observation?.evidenceId || !result.pageUrl) return fail("uncertain", "page_provenance_unavailable");

    pageCount++;
    const beforeRecordCount = accumulator.get(outputName)?.records.length ?? 0;
    const seenKeys = new Set((accumulator.get(outputName)?.records ?? [])
      .map(record => uniqueRecordKey({ values: record }, contract.uniqueBy ?? []))
      .filter(value => value !== null));
    const pageRecords = [];
    let pageDuplicateCount = 0;
    for (const record of result.records ?? []) {
      const key = record?.valid === true ? uniqueRecordKey(record, contract.uniqueBy ?? []) : null;
      if (key !== null && seenKeys.has(key)) {
        pageDuplicateCount++;
        continue;
      }
      if (key !== null) seenKeys.add(key);
      pageRecords.push(record);
    }
    duplicateRecordCount += pageDuplicateCount;
    try {
      accumulator.append(outputName, outputContractId, {
        records: pageRecords,
        truncated: result.truncated,
        evidence: result.evidence
      }, {
        observationId: result.observation.evidenceId,
        pageUrl: result.pageUrl,
        maxRecords: contract.maxRecords
      });
    } catch { return fail("blocked", "extraction_output_contract_mismatch"); }
    if (result.truncated || accumulator.get(outputName)?.overflow) return fail("failed", "record_limit_exceeded");
    const newlyObservedRecordCount = Math.max(0, (accumulator.get(outputName)?.records.length ?? 0) - beforeRecordCount);
    const cursorChanged = previousCursorFingerprint !== null && cursorFingerprint !== null
      && previousCursorFingerprint !== cursorFingerprint;
    const progressVerified = pageCount === 1
      ? newlyObservedRecordCount > 0
      : newlyObservedRecordCount > 0 || cursorChanged;
    const terminalEvidence = result.nextPage?.status === "not_found" && result.records.length > 0
      ? {
        kind: "visible_next_control_absent_on_nonempty_page",
        observationId: result.observation.evidenceId,
        pageIdentityFingerprint,
        recordCount: result.records.length
      }
      : null;
    const progress = {
      previousCursor: previousCursorFingerprint,
      nextCursor: cursorFingerprint,
      newlyObservedRecordCount,
      duplicateRecordCount: pageDuplicateCount,
      progressVerified,
      terminalEvidence,
      completeness: terminalEvidence ? "complete" : "observed_partial"
    };
    cursorHistory.push(progress);
    if (!progressVerified && result.nextPage?.status === "available") return fail("failed", "pagination_progress_not_verified");
    previousCursorFingerprint = cursorFingerprint;
    try {
      await onPageCollected?.({
        pageCount,
        observationId: result.observation.evidenceId,
        pageIdentityFingerprint,
        pageIdentityFingerprints: [...visitedPageFingerprints],
        cursorFingerprint,
        nextCursorFingerprint: result.nextPage?.status === "available" ? extractionPageCursorFingerprint(result.nextPage.url) : null,
        nextPageStatus: result.nextPage?.status ?? "not_configured",
        terminalEvidence,
        pageEvidence: structuredClone(accumulator.get(outputName)?.pageEvidence ?? []),
        recordCount: result.records.length,
        newlyObservedRecordCount,
        duplicateRecordCount: pageDuplicateCount,
        cumulativeDuplicateRecordCount: duplicateRecordCount,
        accumulatedRecordCount: accumulator.get(outputName)?.records.length ?? 0,
        output: currentOutput(),
        contract
      });
    } catch { return fail("uncertain", "collection_checkpoint_failed"); }
    if (signal?.aborted) return fail("uncertain", "canceled_during_collection");

    if (!contract.pagination) break;
    if (result.nextPage?.status === "not_found") {
      if (contract.completionPolicy === "pagination_exhausted" && (!result.records.length || !terminalEvidence)) {
        return fail("failed", "empty_terminal_page_not_proof_of_exhaustion");
      }
      accumulator.markPaginationExhausted(outputName);
      break;
    }
    const virtualizedTarget = contract.pagination?.kind === "virtualized_list"
      && typeof result.nextPage?.identity === "string";
    if (result.nextPage?.status !== "available" || (typeof result.nextPage.url !== "string" && !virtualizedTarget)) {
      const reasonCode = result.nextPage?.status === "ambiguous" ? "pagination_target_ambiguous"
        : result.nextPage?.status === "unavailable" ? "pagination_target_unavailable"
          : "pagination_target_unavailable";
      return fail("failed", reasonCode);
    }
    const pageLimit = Math.min(maxPages, contract.pagination.maxPages);
    if (pageCount >= pageLimit) return fail("failed", "pagination_page_limit_reached");
    if (typeof advancePage !== "function") return fail("blocked", "authorized_pagination_executor_unavailable");
    let navigation;
    try {
      navigation = await advancePage({
        url: result.nextPage.url ?? null,
        fromPageUrl: result.observation.page?.url,
        nextPage: result.nextPage,
        kind: contract.pagination.kind,
        queryParameter: contract.pagination.queryParameter ?? null,
        pageNumber: pageCount + 1,
        sourceObservationId: result.observation.evidenceId,
        capabilityId,
        capabilityVersion,
        signal,
        progress
      });
    } catch { return fail("uncertain", "pagination_navigation_result_unknown"); }
    if (navigation?.status !== "verified" && navigation?.status !== "PASS") {
      return fail(navigation?.status === "blocked" ? "blocked" : navigation?.status === "uncertain" ? "uncertain" : "failed",
        navigation?.reasonCode ?? "authorized_pagination_navigation_not_verified");
    }
  }

  const output = currentOutput();
  if (!output) return fail("uncertain", "extraction_contract_unavailable");
  const verification = verifyExtractionResult(output);
  if (verification.status !== "complete") return fail("failed", "extraction_verification_failed");
  const terminalEvidence = cursorHistory.at(-1)?.terminalEvidence ?? null;
  output.verification.paginationProgress = {
    previousCursor: cursorHistory.length > 1 ? cursorHistory.at(-2)?.nextCursor ?? null : null,
    nextCursor: cursorHistory.at(-1)?.nextCursor ?? previousCursorFingerprint,
    newlyObservedRecordCount: accumulator.get(outputName)?.records.length ?? 0,
    duplicateRecordCount,
    progressVerified: initialProgressVerified === true && cursorHistory.every(item => item.progressVerified),
    terminalEvidence,
    completeness: "complete"
  };
  return { status: "complete", output, contract, pageCount, verification, progress: output.verification.paginationProgress };
}
