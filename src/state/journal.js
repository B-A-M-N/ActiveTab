import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const REDACTED_GOAL = "[redacted task goal]";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TASK_JOURNAL_BYTES = 64 * 1024;

function validTargetSignature(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["tag", "role", "nameFingerprint", "contextFingerprint", "hrefFingerprint"].includes(key)) &&
    typeof value.tag === "string" && value.tag.length <= 32 &&
    typeof value.role === "string" && value.role.length <= 64 &&
    HASH_PATTERN.test(value.nameFingerprint ?? "") &&
    (value.contextFingerprint === undefined || value.contextFingerprint === null || HASH_PATTERN.test(value.contextFingerprint)) &&
    (value.hrefFingerprint === undefined || value.hrefFingerprint === null || HASH_PATTERN.test(value.hrefFingerprint));
}

function validPendingAction(value) {
  const stableId = candidate => candidate === undefined || typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(candidate);
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["action", "targetIdentity", "targetSignature", "scrollTopBefore", "beforeStateFingerprint", "beforeRouteFingerprint", "beforeEvidenceId", "startedAt", "decisionId", "decisionStepId", "operationId"].includes(key)) ||
      !["click", "type", "fill", "select", "toggle", "upload", "scroll"].includes(value.action) ||
      typeof value.targetIdentity !== "string" || value.targetIdentity.length < 1 || value.targetIdentity.length > 256 ||
      !HASH_PATTERN.test(value.beforeStateFingerprint ?? "") ||
      typeof value.beforeRouteFingerprint !== "string" || value.beforeRouteFingerprint.length > 64 ||
      typeof value.beforeEvidenceId !== "string" || value.beforeEvidenceId.length > 256 ||
      typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt)) ||
      !stableId(value.decisionId) || !stableId(value.decisionStepId) || !stableId(value.operationId)) return false;
  if (value.targetSignature !== undefined && value.targetSignature !== null && !validTargetSignature(value.targetSignature)) return false;
  return value.action !== "scroll" || Number.isFinite(value.scrollTopBefore);
}

function normalizeGoal(goal) {
  return String(goal ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function taskGoalFingerprint(goal) {
  return createHash("sha256").update(normalizeGoal(goal)).digest("hex");
}

export class TaskJournal {
  constructor(path) { this.path = path; }

  async write(value) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_JOURNAL_BYTES) throw new Error("Task journal exceeds the 64 KiB local storage limit.");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, this.path);
  }

  async read() {
    const file = await open(this.path, "r");
    let contents;
    try {
      if ((await file.stat()).size > MAX_TASK_JOURNAL_BYTES) throw new Error("Task journal exceeds the 64 KiB local storage limit.");
      contents = await file.readFile("utf8");
    } finally { await file.close(); }
    const value = JSON.parse(contents);
    if (value?.schemaVersion !== 1 || typeof value.goal !== "string" || typeof value.targetId !== "string" || !Array.isArray(value.attempts) || value.attempts.length > 10 || !Number.isInteger(value.recoveryCount ?? 0) || (value.recoveryCount ?? 0) < 0 || (value.recoveryCount ?? 0) > 3 || (value.goalFingerprint !== undefined && !HASH_PATTERN.test(value.goalFingerprint)) || (value.environmentFingerprint !== undefined && value.environmentFingerprint !== null && !HASH_PATTERN.test(value.environmentFingerprint)) || !validPendingAction(value.pendingAction)) throw new Error("Task journal is invalid or unsupported.");
    return value;
  }

  async clear() { await rm(this.path, { force: true }); }
}

export function newTaskState(goal, target, endpoint) {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    goal: REDACTED_GOAL,
    goalFingerprint: taskGoalFingerprint(goal),
    requiresGoalInput: true,
    targetId: target.id,
    endpoint,
    status: "running",
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export async function updateTaskJournal(journal, state) {
  state.updatedAt = new Date().toISOString();
  // Keep the journal small; it stores a goal fingerprint and continuation facts, never raw goals, browser snapshots, or form values.
  await journal.write(state);
}
