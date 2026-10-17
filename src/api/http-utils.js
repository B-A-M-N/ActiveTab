/**
 * Shared HTTP helpers for the ActiveTab local API server.
 * Zero dependencies — Node.js platform APIs only.
 */
import { randomUUID } from "node:crypto";

export function sendJson(res, status, body, { allowOrigin } = {}) {
  const payload = JSON.stringify(body);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  res.writeHead(status, headers);
  res.end(payload);
}

export function sendError(res, status, code, msg) {
  sendJson(res, status, {
    code, msg, data: null,
    ts: Date.now(),
    time: new Date().toISOString().replace("T", " ").slice(0, 19),
    traceId: randomUUID().replace(/-/g, "")
  });
}

export async function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolvePromise({});
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export function parseQuery(url) {
  const q = {};
  const queryString = url.split("?")[1];
  if (!queryString) return q;
  for (const pair of queryString.split("&")) {
    const [k, v] = pair.split("=");
    q[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return q;
}
