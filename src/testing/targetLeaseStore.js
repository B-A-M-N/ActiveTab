import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";

const TARGET_LEASE_TTL_MS = 30_000;

function safeIdentifier(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a bounded identifier.`);
  }
  if ([...value].some(character => character.charCodeAt(0) < 32)) {
    throw new Error(`${label} contains an unsupported control character.`);
  }
  return value;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

/** Owns the SQLite-backed fencing leases for exact browser targets. */
export class BrowserTargetLeaseStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.db = null;
  }

  async init() {
    if (this.db) return;
    const path = join(this.baseDir, "target-leases.sqlite");
    try {
      const file = await open(path, "wx", 0o600);
      await file.close();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Target lease database must be a regular file, not a symlink.");
    await chmod(path, 0o600);
    this.db?.close();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS target_lease_counters (
        target_key TEXT PRIMARY KEY,
        fencing_token INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS target_leases (
        target_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        host TEXT NOT NULL,
        pid INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  async acquireTargetLease(targetId, runId, { ttlMs = TARGET_LEASE_TTL_MS } = {}) {
    safeIdentifier(String(targetId ?? ""), "targetId");
    safeIdentifier(String(runId ?? ""), "runId");
    if (!this.db) throw new Error("RunStateStore must be initialized before acquiring a target lease.");
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw new Error("Target lease TTL must be between 1000 and 300000 ms.");
    const targetKey = createHash("sha256").update(String(targetId)).digest("hex");
    const db = this.db;
    const ownerId = randomUUID();
    const now = Date.now();
    let fencingToken;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db.prepare("SELECT * FROM target_leases WHERE target_key = ?").get(targetKey);
      const sameHostOwnerAlive = current?.host === hostname()
        ? processIsAlive(current.pid)
        : null;
      if (current && current.expires_at > now && sameHostOwnerAlive !== false) {
        const error = new Error(`Browser target '${targetId}' already has an active run owner.`);
        error.code = "RUN_TARGET_LEASE_HELD";
        throw error;
      }
      if (current?.host === hostname() && sameHostOwnerAlive !== false) {
        const error = new Error(`Browser target '${targetId}' has an expired lease whose owner process is still alive.`);
        error.code = "RUN_TARGET_LEASE_HELD";
        throw error;
      }
      const counter = db.prepare("SELECT fencing_token FROM target_lease_counters WHERE target_key = ?").get(targetKey);
      fencingToken = Number(counter?.fencing_token ?? 0) + 1;
      db.prepare(`INSERT INTO target_lease_counters (target_key, fencing_token) VALUES (?, ?)
        ON CONFLICT(target_key) DO UPDATE SET fencing_token = excluded.fencing_token`).run(targetKey, fencingToken);
      db.prepare(`INSERT INTO target_leases (target_key, owner_id, run_id, host, pid, fencing_token, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_key) DO UPDATE SET owner_id = excluded.owner_id, run_id = excluded.run_id,
          host = excluded.host, pid = excluded.pid, fencing_token = excluded.fencing_token,
          heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`)
        .run(targetKey, ownerId, runId, hostname(), process.pid, fencingToken, now, now + ttlMs);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    let lost = false;
    const renew = () => {
      if (lost) throw Object.assign(new Error("Browser target execution lease was lost."), { code: "RUN_TARGET_LEASE_LOST" });
      const heartbeatAt = Date.now();
      const result = db.prepare(`UPDATE target_leases SET heartbeat_at = ?, expires_at = ?
        WHERE target_key = ? AND owner_id = ? AND fencing_token = ?`)
        .run(heartbeatAt, heartbeatAt + ttlMs, targetKey, ownerId, fencingToken);
      if (Number(result.changes) !== 1) {
        lost = true;
        throw Object.assign(new Error("Browser target execution lease was lost."), { code: "RUN_TARGET_LEASE_LOST" });
      }
      return fencingToken;
    };
    const timer = setInterval(() => {
      try { renew(); } catch { lost = true; }
    }, Math.max(250, Math.floor(ttlMs / 3)));
    timer.unref?.();
    return {
      fencingToken,
      async assertCurrent() { return renew(); },
      async release() {
        clearInterval(timer);
        db.prepare("DELETE FROM target_leases WHERE target_key = ? AND owner_id = ? AND fencing_token = ?")
          .run(targetKey, ownerId, fencingToken);
      }
    };
  }
}
