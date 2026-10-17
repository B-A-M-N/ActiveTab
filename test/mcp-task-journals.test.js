import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpTaskJournalStore } from "../src/state/mcpTaskJournals.js";
import { TaskJournal, taskGoalFingerprint } from "../src/state/journal.js";
import { runMcpGoal } from "../src/mcp/runGoal.js";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "activetab-mcp-journal-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("MCP task journals use private files and opaque keys without persisting the raw goal", async () => withDirectory(async directory => {
  const goal = "Open the account page for private-user-734";
  const target = { id: "authorized-tab-id", endpoint: "local-cdp" };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const first = await store.forTask(target, goal);
  const repeated = await store.forTask(target, goal);
  assert.equal(first.key, repeated.key);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.equal(first.journal.path, repeated.journal.path);

  const directoryStat = await stat(join(directory, "tasks"));
  assert.equal(directoryStat.mode & 0o777, 0o700);
  await first.journal.write({
    schemaVersion: 1,
    taskId: "task-1",
    goal: "[redacted task goal]",
    goalFingerprint: taskGoalFingerprint(goal),
    requiresGoalInput: true,
    targetId: target.id,
    endpoint: target.endpoint,
    status: "unresolved",
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const fileStat = await stat(first.journal.path);
  assert.equal(fileStat.mode & 0o777, 0o600);
  const contents = await readFile(first.journal.path, "utf8");
  assert.equal(contents.includes(goal), false);
  assert.equal(contents.includes("private-user-734"), false);
  assert.equal((await readdir(join(directory, "tasks"))).length, 1);
}));

test("MCP journal capacity prunes completed tasks and preserves resumable tasks", async () => withDirectory(async directory => {
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks"), maxEntries: 1 });
  const completed = await store.forTask({ id: "tab-1" }, "Open the completed page");
  await completed.journal.write({ schemaVersion: 1, goal: "[redacted task goal]", targetId: "tab-1", status: "succeeded", attempts: [] });
  const active = await store.forTask({ id: "tab-2" }, "Open the active page");
  await active.journal.write({ schemaVersion: 1, goal: "[redacted task goal]", targetId: "tab-2", status: "unresolved", attempts: [] });

  await assert.rejects(store.forTask({ id: "tab-3" }, "Open another page"), /capacity.*full of resumable or invalid tasks/);
  assert.equal((await active.journal.read()).status, "unresolved");
  assert.equal((await readdir(join(directory, "tasks"))).length, 1);
}));

test("task journals enforce a byte cap and reject unapproved pending-action fields", async () => withDirectory(async directory => {
  const journal = new TaskJournal(join(directory, "task.json"));
  const state = {
    schemaVersion: 1,
    goal: "[redacted task goal]",
    targetId: "target",
    status: "running",
    attempts: [],
    pendingAction: {
      action: "type",
      targetIdentity: "search-field",
      beforeStateFingerprint: "a".repeat(64),
      beforeRouteFingerprint: "b".repeat(64),
      beforeEvidenceId: "evidence",
      startedAt: new Date().toISOString()
    }
  };
  await journal.write(state);
  assert.equal((await journal.read()).pendingAction.action, "type");
  await assert.rejects(journal.write({ ...state, unbounded: "x".repeat(65 * 1024) }), /64 KiB local storage limit/);

  await journal.write({ ...state, pendingAction: { ...state.pendingAction, value: "private search phrase" } });
  await assert.rejects(journal.read(), /Task journal is invalid or unsupported/);
}));

test("MCP run_goal survives process termination after dispatch and resumes without repeating the action", { timeout: 15_000 }, async () => withDirectory(async directory => {
  const target = { id: "resume-target", endpoint: "local-cdp" };
  const goal = "Open the account page";
  const runChild = stage => {
    const storeModule = new URL("../src/state/mcpTaskJournals.js", import.meta.url).href;
    const runnerModule = new URL("../src/mcp/runGoal.js", import.meta.url).href;
    const code = `
      import { writeSync } from "node:fs";
      import { McpTaskJournalStore } from ${JSON.stringify(storeModule)};
      import { runMcpGoal } from ${JSON.stringify(runnerModule)};
      const target = { id: "resume-target", endpoint: "local-cdp" };
      const goal = "Open the account page";
      const stage = process.env.ACTIVETAB_TEST_STAGE;
      const account = { page: { url: "https://shop.example.test/account", title: "Account" }, headings: [{ level: 1, text: "Account" }], candidates: [] };
      const session = stage === "first" ? {
        target,
        clicks: 0,
        state: { page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [{ identity: "account-link", backendNodeId: 1, name: "Open account", role: "link", tag: "a", visible: true, disabled: false }] },
        async observe() { return { evidenceId: "before-interruption", ...structuredClone(this.state) }; },
        async click() { this.clicks++; this.state = account; },
        async waitForChange() { process.exit(73); }
      } : {
        target,
        async observe() { return { evidenceId: "after-process-restart", ...structuredClone(account) }; },
        async click() { throw new Error("A resumed completed navigation must not click again."); },
        async waitForChange() {}
      };
      const result = await runMcpGoal(session, { goal, maxActions: 2 }, { journalStore: new McpTaskJournalStore({ directory: process.env.ACTIVETAB_TEST_JOURNAL_DIR }) });
      writeSync(1, JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ACTIVETAB_TEST_STAGE: stage, ACTIVETAB_TEST_JOURNAL_DIR: join(directory, "tasks") }
    });
    return child;
  };

  const first = runChild("first");
  assert.equal(first.status, 73, first.stderr || first.error?.message);
  assert.equal(first.stdout, "", "the process should terminate before returning a tool result");

  const interruptedStore = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const { journal } = await interruptedStore.forTask(target, goal);
  const interruptedState = await journal.read();
  assert.equal(interruptedState.attempts.length, 0);
  assert.equal(interruptedState.pendingAction.action, "click");
  assert.equal(interruptedState.pendingAction.targetIdentity, "account-link");

  const resumed = runChild("resume");
  assert.equal(resumed.status, 0, resumed.stderr || resumed.error?.message);
  const resumedResult = JSON.parse(resumed.stdout);
  assert.equal(resumedResult.status, "succeeded");
  assert.equal(resumedResult.taskId, interruptedState.taskId);
  assert.equal(resumedResult.resumed, true);
  assert.equal(resumedResult.attempts, 1);

  const alreadySucceeded = runChild("complete");
  assert.equal(alreadySucceeded.status, 0, alreadySucceeded.stderr || alreadySucceeded.error?.message);
  const completedResult = JSON.parse(alreadySucceeded.stdout);
  assert.equal(completedResult.status, "succeeded");
  assert.equal(completedResult.alreadySucceeded, true);
  assert.equal(completedResult.taskId, interruptedState.taskId);
}));

test("MCP run_goal rejects concurrent tasks on the same browser target", async () => withDirectory(async directory => {
  const target = { id: "locked-target", endpoint: "local-cdp" };
  let releaseObservation;
  const observationGate = new Promise(resolve => { releaseObservation = resolve; });
  let enteredObservation;
  const observationStarted = new Promise(resolve => { enteredObservation = resolve; });
  const session = {
    target,
    async observe() {
      enteredObservation();
      await observationGate;
      return { evidenceId: "locked", page: { url: "https://shop.example.test/", title: "Shop" }, headings: [{ level: 1, text: "Shop" }], candidates: [] };
    }
  };
  const store = new McpTaskJournalStore({ directory: join(directory, "tasks") });
  const running = runMcpGoal(session, { goal: "Open the account page" }, { journalStore: store });
  await observationStarted;
  await assert.rejects(runMcpGoal(session, { goal: "Open the billing page" }, { journalStore: store }), /already active on this browser target/);
  releaseObservation();
  assert.equal((await running).status, "unresolved");
}));
