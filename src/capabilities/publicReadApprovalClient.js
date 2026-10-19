function localApiBase(value) {
  const base = new URL(value);
  if (base.protocol !== "http:" || !new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(base.hostname)) {
    throw new Error("Public-read approval API must be an explicitly configured loopback HTTP endpoint.");
  }
  return base;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    const finish = value => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Request a human decision over the authenticated local operator API. */
export async function approvePublicReadThroughApi(proposal, {
  apiUrl = process.env.ACTIVETAB_PUBLIC_READ_APPROVAL_API_URL
    ?? `http://127.0.0.1:${process.env.ACTIVETAB_API_PORT ?? "9377"}`,
  apiToken = process.env.ACTIVETAB_API_TOKEN ?? null,
  fetchImpl = globalThis.fetch,
  signal = null,
  pollIntervalMs = 750
} = {}) {
  if (typeof apiToken !== "string" || !apiToken || typeof fetchImpl !== "function" || signal?.aborted) return false;
  let base;
  try { base = localApiBase(apiUrl); } catch { return false; }
  const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const requestTimeout = () => AbortSignal.timeout(5_000);
  let created;
  try {
    const response = await fetchImpl(new URL("/v1/public-reads/requests", base), {
      method: "POST", headers, body: JSON.stringify(proposal), signal: requestTimeout()
    });
    if (!response.ok) return false;
    created = await response.json();
  } catch { return false; }
  if (typeof created?.requestId !== "string" || !Number.isInteger(created?.revision)) return false;
  const deadline = Date.now() + Math.max(1_000, Math.min(15 * 60_000, proposal.expiresInMs ?? 5 * 60_000));
  const statusUrl = new URL(`/v1/public-reads/requests/${encodeURIComponent(created.requestId)}/status`, base);
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const response = await fetchImpl(statusUrl, { headers: { Authorization: `Bearer ${apiToken}` }, signal: requestTimeout() });
      if (!response.ok) return false;
      const status = await response.json();
      if (status?.status === "approved") return true;
      if (status?.status !== "pending") return false;
    } catch { return false; }
    if (!await delay(Math.max(100, Math.min(5_000, pollIntervalMs)), signal)) return false;
  }
  return false;
}
