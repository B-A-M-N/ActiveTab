/**
 * Peer token handling for the LAN remote-execution split.
 *
 * One secret, two uses: the forwarder sends it as a bearer token, the
 * executor node checks it. The token is always operator-generated, never
 * logged, never journaled, and read from a 0o600 file by default.
 *
 * Security without pain:
 * - No certificates, no handshake ceremony, no per-run pairing. The
 *   pre-shared token plus the private-LAN pin does the work.
 * - The file is created with a random 256-bit token the first time the
 *   executor node runs, so the only manual step is copying ONE file to
 *   the other machine (scp it once, done).
 * - Old tokens are accepted for a grace window when the file changes, so
 *   rotating the token on both machines does not have to be simultaneous.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, chmod, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export const DEFAULT_TOKEN_PATH = joinHome(".activetab", "peer-token");

function joinHome(...parts) {
  return [process.env.HOME ?? process.cwd(), ...parts].join("/");
}

/** Load the active peer token; generate and persist one on first use. */
export async function loadOrCreatePeerToken(tokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE ?? DEFAULT_TOKEN_PATH) {
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length >= 16) return { token, tokenFile };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return { token, tokenFile };
}

/**
 * Load the active token plus any still-valid previous tokens (for rotation).
 * Returns an array; index 0 is the current token.
 */
export async function loadPeerTokenRing(tokenFile = process.env.ACTIVETAB_REMOTE_TOKEN_FILE ?? DEFAULT_TOKEN_PATH, { maxAgeMs = 24 * 60 * 60_000 } = {}) {
  const { token } = await loadOrCreatePeerToken(tokenFile);
  const ring = [token];
  try {
    const { mtimeMs } = await stat(tokenFile);
    const previous = process.env.ACTIVETAB_REMOTE_TOKEN_PREVIOUS;
    if (previous && Date.now() - mtimeMs < maxAgeMs) ring.push(previous.trim());
  } catch { /* stat failures are fine; the current token still works */ }
  return ring;
}

/** Constant-time check of a presented token against the token ring. */
export function tokenMatches(presented, ring) {
  if (typeof presented !== "string" || !presented) return false;
  return ring.some(candidate =>
    Buffer.byteLength(presented) === Buffer.byteLength(candidate) &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(candidate))
  );
}
