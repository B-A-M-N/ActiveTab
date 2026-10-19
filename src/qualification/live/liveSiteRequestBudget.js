import { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class LiveSiteRequestBudget {
  constructor(path) {
    if (typeof path !== "string" || !path) throw new Error("Live-site request budget requires a local database path.");
    this.path = resolve(path);
    this.db = null;
  }

  async init() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(dirname(this.path));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
      throw new Error("Live-site request budget directory must be a real, owner-owned directory.");
    }
    await chmod(dirname(this.path), 0o700);
    try {
      const file = await open(this.path, "wx", 0o600);
      await file.close();
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    const fileStat = await lstat(this.path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()
      || (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Live-site request budget must be a regular owner-owned file.");
    }
    await chmod(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS live_site_requests (
        id INTEGER PRIMARY KEY,
        site_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        requested_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_site_requests_site_time
        ON live_site_requests(site_id, requested_at_ms);
    `);
    return this;
  }

  consume(siteId, { kind, limit, windowMs = 60_000, now = Date.now() } = {}) {
    if (!this.db) throw new Error("Live-site request budget is not initialized.");
    if (typeof siteId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/u.test(siteId)
      || typeof kind !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(kind)
      || !Number.isInteger(limit) || limit < 1 || limit > 60
      || !Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000
      || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Live-site request budget input is invalid.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cutoff = now - windowMs;
      this.db.prepare("DELETE FROM live_site_requests WHERE site_id = ? AND requested_at_ms <= ?").run(siteId, cutoff);
      const count = this.db.prepare("SELECT COUNT(*) AS total FROM live_site_requests WHERE site_id = ? AND requested_at_ms > ?").get(siteId, cutoff).total;
      if (count >= limit) {
        this.db.exec("ROLLBACK");
        return Object.freeze({ allowed: false, count, limit, reasonCode: "live_site_request_rate_limited" });
      }
      this.db.prepare("INSERT INTO live_site_requests(site_id, kind, requested_at_ms) VALUES (?, ?, ?)").run(siteId, kind, now);
      this.db.exec("COMMIT");
      return Object.freeze({ allowed: true, count: count + 1, limit, reasonCode: null });
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original database failure */ }
      throw error;
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
