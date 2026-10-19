import { sanitizeUrl } from "./urlPrivacy.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function safeDisplayUrl(value) {
  return sanitizeUrl(value);
}

export function validateLoopbackEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== "http:" || !LOOPBACK.has(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error("CDP discovery endpoint must be an unauthenticated loopback HTTP URL.");
  }
  return endpoint;
}

export async function listTargets(endpoint = "http://127.0.0.1:9222") {
  const base = validateLoopbackEndpoint(endpoint);
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}.`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("CDP target discovery returned an invalid response.");
  return targets.filter(target => target?.type === "page" && typeof target.id === "string").map(target => ({
    id: target.id,
    title: target.title ?? "",
    url: safeDisplayUrl(target.url ?? ""),
    type: target.type
  }));
}

export async function resolveAuthorizedTarget(endpoint, targetId, confirmedTargetId) {
  if (!targetId || targetId !== confirmedTargetId) throw new Error("Explicit target authorization is required and must match the selected target id.");
  const targets = await listTargets(endpoint);
  const target = targets.find(item => item.id === targetId);
  if (!target) throw new Error("The selected CDP target is no longer available.");
  const pageUrl = new URL(target.url);
  if (!new Set(["http:", "https:"]).has(pageUrl.protocol)) throw new Error("Only HTTP(S) page targets can be controlled.");
  const base = validateLoopbackEndpoint(endpoint);
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(5_000) });
  const rawTargets = await response.json();
  const raw = rawTargets.find(item => item.id === targetId);
  if (!raw?.webSocketDebuggerUrl) throw new Error("The selected target has no direct CDP WebSocket.");
  const socketUrl = new URL(raw.webSocketDebuggerUrl);
  if (socketUrl.protocol !== "ws:" || !LOOPBACK.has(socketUrl.hostname)) throw new Error("Target CDP socket is not loopback-only.");
  return { ...target, endpoint: base.toString(), webSocketDebuggerUrl: socketUrl.toString() };
}

/** Resolve only the blank page of the Chrome process launched by this call. */
export async function resolveOwnedBlankTarget(endpoint, targetId, ownedProcess) {
  if (!Number.isInteger(ownedProcess?.pid) || ownedProcess.pid < 1
    || ownedProcess.exitCode !== null || ownedProcess.signalCode !== null
    || typeof targetId !== "string" || !targetId) {
    throw new Error("An owned live Chrome process and exact blank target are required.");
  }
  const base = validateLoopbackEndpoint(endpoint);
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}.`);
  const targets = await response.json();
  const target = Array.isArray(targets) ? targets.find(item => item?.id === targetId && item?.type === "page") : null;
  if (target?.url !== "about:blank" || typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("The owned startup target must be the exact blank page created for this Chrome process.");
  }
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  if (socketUrl.protocol !== "ws:" || !LOOPBACK.has(socketUrl.hostname)) throw new Error("Target CDP socket is not loopback-only.");
  return { id: targetId, title: "", url: "about:blank", type: "page", endpoint: base.toString(), webSocketDebuggerUrl: socketUrl.toString() };
}
