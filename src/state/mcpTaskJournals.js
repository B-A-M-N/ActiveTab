import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { stateDirectory } from "../extension/paths.js";
import { TaskJournal, taskGoalFingerprint } from "./journal.js";

export const MAX_MCP_TASK_JOURNALS = 128;

function taskKey(target, goal) {
  return createHash("sha256")
    .update(JSON.stringify([String(target?.endpoint ?? "local-cdp"), String(target?.id ?? ""), taskGoalFingerprint(goal)]))
    .digest("hex");
}

export class McpTaskJournalStore {
  constructor({ directory, maxEntries = MAX_MCP_TASK_JOURNALS } = {}) {
    const configuredDirectory = directory ?? process.env.ACTIVETAB_TASK_JOURNAL_DIR;
    if (configuredDirectory !== undefined && !isAbsolute(configuredDirectory)) {
      throw new Error("ACTIVETAB_TASK_JOURNAL_DIR must be an absolute path.");
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
      throw new Error("MCP task journal capacity must be between 1 and 10000 entries.");
    }
    this.directory = configuredDirectory ?? join(stateDirectory(), "mcp-tasks");
    this.maxEntries = maxEntries;
    this.directoryReady = undefined;
  }

  async forTask(target, goal) {
    if (typeof target?.id !== "string" || !target.id || typeof goal !== "string" || !goal.trim()) {
      throw new Error("A selected browser target and non-empty goal are required for an MCP task journal.");
    }
    await this.#ensureDirectory();
    const key = taskKey(target, goal);
    const path = join(this.directory, `${key}.json`);
    await this.#ensureJournalFile(path);
    await this.#makeRoom(path);
    return { key, journal: new TaskJournal(path) };
  }

  async #ensureDirectory() {
    this.directoryReady ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryStat = await lstat(this.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
          (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
        throw new Error("MCP task journal directory must be a real directory owned by the current user.");
      }
      await chmod(this.directory, 0o700);
    })();
    await this.directoryReady;
  }

  async #ensureJournalFile(path) {
    const fileStat = await lstat(path).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!fileStat) return;
    if (!fileStat.isFile() || fileStat.isSymbolicLink() ||
        (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) {
      throw new Error("Refusing to read an unsafe MCP task journal path.");
    }
    await chmod(path, 0o600);
  }

  async #makeRoom(currentPath) {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const journalNames = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
    if (journalNames.some(entry => join(this.directory, entry.name) === currentPath) || journalNames.length < this.maxEntries) return;

    const completed = [];
    for (const entry of journalNames) {
      const path = join(this.directory, entry.name);
      const fileStat = await lstat(path).catch(() => null);
      if (!fileStat?.isFile() || fileStat.isSymbolicLink() ||
          (typeof process.getuid === "function" && fileStat.uid !== process.getuid())) continue;
      try {
        const state = await new TaskJournal(path).read();
        if (state.status === "succeeded") completed.push({ path, mtimeMs: fileStat.mtimeMs });
      } catch { /* Invalid journals are preserved for explicit local recovery. */ }
    }
    completed.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of completed) {
      if (journalNames.length < this.maxEntries) break;
      await rm(entry.path, { force: true });
      journalNames.pop();
    }
    if (journalNames.length >= this.maxEntries) {
      throw new Error(`MCP task journal capacity (${this.maxEntries}) is full of resumable or invalid tasks; remove completed journals or choose another journal directory.`);
    }
  }
}
