#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { listTargets, resolveAuthorizedTarget } from "./browser/targets.js";
import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "./browser/chrome-autoconnect.js";
import { BrowserSession } from "./browser/session.js";
import { NavigationEngine } from "./navigation/engine.js";
import { TaskJournal, taskGoalFingerprint } from "./state/journal.js";
import { WorkflowStore } from "./state/workflows.js";
import { createDecisionRuntime } from "./decisions/runtime.js";
import { ProfileLoader } from "./testing/profiles.js";
import { buildEnvironmentBinding } from "./environments/model.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RunStateStore, withTargetExecutionLease } from "./testing/runState.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const endpoint = arg("--endpoint") ?? process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const autoConnect = args.includes("--auto-connect");
const userDataDir = arg("--user-data-dir") ?? process.env.ACTIVETAB_CHROME_USER_DATA_DIR;
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const profilesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

async function loadEnvironmentProfile(profileId) {
  if (profileId === undefined) return null;
  if (typeof profileId !== "string" || profileId.length === 0) throw new Error("--profile requires a local ActiveTab profile id.");
  const profile = await new ProfileLoader(profilesDir).loadProfile(profileId);
  if (!profile) throw new Error(`No local environment profile '${profileId}' exists.`);
  return buildEnvironmentBinding(profile);
}

if (command === "targets") {
  const connection = autoConnect ? await connectChromeAuto({ ...(userDataDir ? { userDataDir } : {}) }) : undefined;
  try { print(connection ? await listChromeTargets(connection) : await listTargets(endpoint)); }
  finally { await connection?.close(); }
  process.exit(0);
}
if (command === "help" || command === "--help") {
  stdout.write("ActiveTab local native CDP runtime\n\nCommands:\n  targets [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n  observe --target ID [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n  run --target ID --goal TEXT [--profile ID] [--journal PATH] [--workflow-store PATH] [--auto-connect] [--user-data-dir PATH]\n  resume --journal PATH --goal TEXT [--profile ID] [--workflow-store PATH] [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n\nUse --profile ID to bind navigation to a local environment profile in ./profiles. Resuming a task requires the same profile binding used when it started. Without a profile, navigation and following links are refused; same-origin non-navigation actions may still run. Task journals store only a goal fingerprint and environment fingerprint; supply the same goal and profile again to resume. Chrome auto-connect requires remote debugging enabled at chrome://inspect/#remote-debugging and the browser's permission prompt. Each selected tab still requires exact target-ID confirmation. Non-interactive control requires ACTIVETAB_AUTHORIZED_TARGET_ID set out of band after explicit consent.\n");
  process.exit(0);
}

const journalPath = arg("--journal");
const journal = journalPath ? new TaskJournal(journalPath) : undefined;
const workflowStorePath = arg("--workflow-store");
const workflowStore = workflowStorePath ? new WorkflowStore(workflowStorePath) : undefined;
const resumeState = command === "resume" ? await journal?.read() : undefined;
if (command === "resume" && !resumeState) throw new Error("resume requires --journal PATH.");
const environment = command === "run" || command === "resume" ? await loadEnvironmentProfile(arg("--profile")) : null;
const resumedGoal = command === "resume" ? arg("--goal") ?? resumeState.goal : undefined;
if (command === "resume" && resumeState.requiresGoalInput && !resumeState.goalFingerprint) throw new Error("This legacy task journal redacts its goal without a fingerprint and cannot safely resume; start a new task.");
if (command === "resume" && resumeState.goalFingerprint && !arg("--goal")) throw new Error("This task journal omits the original goal. Resume with --goal and re-enter the same request; goal text is not stored in the journal.");
if (command === "resume" && resumeState.goalFingerprint && resumeState.goalFingerprint !== taskGoalFingerprint(resumedGoal)) throw new Error("The supplied goal does not match the task journal's goal fingerprint.");
const targetId = resumeState?.targetId ?? arg("--target");
if (!targetId) throw new Error("--target is required.");
let connection;
let session;
let decisionRuntime;
const runStateStore = command === "run" || command === "resume"
  ? new RunStateStore(resolve(process.env.ACTIVETAB_RUN_STATE_DIR ?? ".activetab/runs"))
  : null;
try {
  if (autoConnect) connection = await connectChromeAuto({ ...(userDataDir ? { userDataDir } : {}) });
  const targets = connection ? await listChromeTargets(connection) : await listTargets(endpoint);
  const target = targets.find(item => item.id === targetId);
  if (!target) throw new Error("Target id was not found. Run `targets` and choose it explicitly.");
  if (!stdin.isTTY) {
    if (process.env.ACTIVETAB_AUTHORIZED_TARGET_ID !== targetId) throw new Error(`Non-interactive control requires ACTIVETAB_AUTHORIZED_TARGET_ID=${targetId}, set out of band after explicit user consent.`);
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`Authorize ActiveTab to control this tab?\n  ${target.title}\n  ${target.url}\nType the target id (${targetId}) to continue: `);
    rl.close();
    if (answer.trim() !== targetId) throw new Error("Target authorization was not confirmed.");
  }
  const resolved = connection
    ? await resolveChromeTarget(connection, targetId, targetId)
    : await resolveAuthorizedTarget(endpoint, targetId, targetId);
  if (resumeState && resumeState.endpoint !== "local-cdp" && resumeState.endpoint !== resolved.endpoint) throw new Error("The task journal belongs to a different CDP endpoint.");
  session = await new BrowserSession(resolved).attach();
  if (runStateStore) {
    await runStateStore.init();
    decisionRuntime = createDecisionRuntime();
  }
  if (command === "observe") print(await session.observe({ includeRawInResponse: true }));
  else if (command === "run") {
    const goal = arg("--goal");
    if (!goal) throw new Error("--goal is required.");
    const taskJournal = journal ?? new TaskJournal(`.activetab/${targetId}.json`);
    const result = await withTargetExecutionLease(runStateStore, session, `cli-run-${randomUUID()}`, lease =>
      new NavigationEngine(session, { journal: taskJournal, workflowStore, decisionRuntime, environment, executionMode: "standalone", plannerMode: arg("--planner-mode") ?? "deterministic", assertExecutionLease: lease.assertCurrent }).run(goal));
    print(result);
    if (result.status !== "succeeded") process.exitCode = 2;
  } else if (command === "resume") {
    const result = await withTargetExecutionLease(runStateStore, session, `cli-resume-${randomUUID()}`, lease =>
      new NavigationEngine(session, { journal, workflowStore, decisionRuntime, environment, executionMode: "standalone", plannerMode: arg("--planner-mode") ?? "deterministic", assertExecutionLease: lease.assertCurrent }).run(resumedGoal, { resumeState }));
    print(result);
    if (result.status !== "succeeded") process.exitCode = 2;
  } else throw new Error(`Unknown command: ${command}`);
} finally {
  decisionRuntime?.close();
  if (session) await session.close();
  await connection?.close();
}
