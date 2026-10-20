import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, open, lstat, chmod, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_RUN_STATE_BYTES = 64 * 1024;

function safeRunId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || value.includes("/") || value.includes("\\")
    || [...value].some(character => character.charCodeAt(0) < 32)) {
    throw new Error("runId must be a bounded identifier.");
  }
  return value;
}

/** Owns owner-private JSON run documents and atomic replacement on disk. */
export class RunDocumentStore {
  constructor(baseDir) {
    if (typeof baseDir !== "string" || !baseDir) throw new Error("RunDocumentStore requires a baseDir.");
    this.baseDir = resolve(baseDir);
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.baseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Run state directory must be a real directory, not a symlink.");
    await chmod(this.baseDir, 0o700);
    return await this.readAll();
  }

  runPath(runId) {
    return join(this.baseDir, `${safeRunId(runId)}.json`);
  }

  async readAll() {
    let entries;
    try { entries = await readdir(this.baseDir, { withFileTypes: true }); }
    catch { return []; }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await readFile(join(this.baseDir, entry.name), "utf8"));
        if (run?.runId && entry.name === `${safeRunId(run.runId)}.json`) runs.push(run);
      } catch { /* Unreadable records remain available for explicit local inspection. */ }
    }
    return runs;
  }

  async read(runId) {
    try {
      const path = this.runPath(runId);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Run state must be a regular file, not a symlink.");
      const run = JSON.parse(await readFile(path, "utf8"));
      return run?.runId === runId ? run : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeAtomic(run) {
    const path = this.runPath(run.runId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      const serialized = JSON.stringify(run, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_STATE_BYTES) throw new Error("Run state exceeds the 64 KiB local storage limit.");
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temp).catch(() => {});
      throw error;
    }
    await file.close();
    await rename(temp, path);
    await chmod(path, 0o600);
  }
}
