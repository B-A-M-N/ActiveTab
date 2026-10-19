import { once } from "node:events";

export const MAX_BODY_BYTES = 16_384;

export function send(response, status, body, type = "application/json; charset=utf-8", headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(request) {
  const body = await readBody(request);
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error("Request body must be JSON."), { status: 400 }); }
}

export async function readForm(request) {
  return new URLSearchParams(await readBody(request));
}

export function cookieValue(request, name) {
  const cookieHeader = request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
