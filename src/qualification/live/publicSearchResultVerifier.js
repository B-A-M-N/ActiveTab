import { createHash } from "node:crypto";

function sha256(value) { return createHash("sha256").update(String(value ?? "")).digest("hex"); }

function insidePath(pathname, prefixes) {
  return prefixes.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function topicMatches(text, topic) {
  const words = String(text ?? "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const target = String(topic?.goalTarget ?? "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (target.length === 0 || target.length > words.length) return false;
  for (let start = 0; start <= words.length - target.length; start++) {
    if (target.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

async function readBoundedText(response, maxBytes) {
  if (!response.body?.getReader) throw new Error("independent_result_body_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("independent_result_too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Independently checks a browser-observed public result with a bounded GET.
 * It reports evidence only and cannot authorize browser actions.
 */
export async function verifyPublicSearchResult(scenario, topic, observation, {
  fetchImpl = globalThis.fetch,
  consumeRequest = null,
  signal,
  timeoutMs = 8_000
} = {}) {
  let observed;
  try { observed = new URL(observation?.page?.url ?? ""); }
  catch { return { status: "evaluator_error", reasonCode: "browser_result_url_unavailable", verificationLevel: "inconclusive" }; }
  if (observed.origin !== scenario.destinationOrigin || !insidePath(observed.pathname, scenario.destinationPathPrefixes)) {
    return { status: "agent_error", reasonCode: "result_destination_outside_scope", verificationLevel: "inconclusive" };
  }
  if (typeof consumeRequest === "function") {
    const budget = consumeRequest();
    if (!budget?.allowed) return { status: "site_access_error", reasonCode: budget?.reasonCode ?? "live_site_request_rate_limited", verificationLevel: "inconclusive" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(observed.href, { method: "GET", redirect: "error", signal: combined, headers: { accept: "text/html", "cache-control": "no-cache" } });
    if (response.status === 429 || [401, 403].includes(response.status)) return { status: "site_access_error", reasonCode: "independent_result_access_refused", httpStatus: response.status, verificationLevel: "inconclusive" };
    if (!response.ok) return { status: "site_access_error", reasonCode: "independent_result_unavailable", httpStatus: response.status, verificationLevel: "inconclusive" };
    if (!/text\/html/iu.test(response.headers.get("content-type") ?? "")) return { status: "evaluator_error", reasonCode: "independent_result_not_html", verificationLevel: "inconclusive" };
    let text;
    try { text = await readBoundedText(response, 1_000_000); }
    catch (error) {
      return { status: "evaluator_error", reasonCode: error?.message === "independent_result_too_large" ? "independent_result_too_large" : "independent_result_body_unavailable", verificationLevel: "inconclusive" };
    }
    const html = text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ");
    const title = (html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu)?.[1] ?? "").replace(/<[^>]*>/gu, " ").replace(/&amp;/giu, "&").replace(/&#39;/giu, "'").replace(/&quot;/giu, '"').replace(/\s+/gu, " ").trim();
    const heading = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/iu)?.[1] ?? "").replace(/<[^>]*>/gu, " ").replace(/&amp;/giu, "&").replace(/&#39;/giu, "'").replace(/&quot;/giu, '"').replace(/\s+/gu, " ").trim();
    const browserHeading = (observation.headings ?? []).find(item => item.level === 1)?.text?.trim() ?? "";
    const identityMatches = Boolean(heading && browserHeading && heading === browserHeading);
    const relevant = topicMatches(title + " " + heading, topic);
    const verified = identityMatches && relevant;
    return Object.freeze({
      status: verified ? "verified" : "agent_error",
      reasonCode: verified ? null : identityMatches ? "result_does_not_match_search_topic" : "browser_and_independent_heading_disagree",
      verificationLevel: verified ? "cross_source_verified" : "inconclusive",
      httpStatus: response.status,
      finalOrigin: observed.origin,
      finalPathFingerprint: sha256(observed.pathname),
      documentFingerprint: sha256(text),
      titleFingerprint: sha256(title),
      headingFingerprint: sha256(heading),
      topicMatch: relevant,
      falseSuccess: observation?.reportedStatus === "succeeded" && !verified
    });
  } catch (error) {
    const denied = error?.name === "TypeError" && String(error.message ?? "").toLowerCase().includes("redirect");
    return { status: "site_access_error", reasonCode: denied ? "independent_result_redirect_denied" : error?.name === "AbortError" ? "independent_result_timeout" : "independent_result_unavailable", verificationLevel: "inconclusive" };
  } finally { clearTimeout(timer); }
}
