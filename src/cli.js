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
import { buildEnvironmentBinding, buildEphemeralCurrentOriginBinding, normalizeOrigin } from "./environments/model.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RunStateStore, withTargetExecutionLease } from "./testing/runState.js";
import { exportRedactedTrace, formatOperatorMarkdown, inspectDurableRun, inspectOperatorEnvironment } from "./diagnostics/operator.js";
import { preflightModelCapabilities, writeModelPreflightSummary } from "./navigation/modelPreflight.js";
import { CapabilityService } from "./capabilities/capabilityService.js";
import { loadExtractionFieldPolicy } from "./capabilities/fieldPolicy.js";
import { plannerModeFromArgs } from "./navigation/plannerMode.js";
import { createAuthorizedSameTargetReattacher, supportsAuthorizedSameTargetReattachment } from "./browser/targetReattachment.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const endpoint = arg("--endpoint") ?? process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const autoConnect = args.includes("--auto-connect");
const userDataDir = arg("--user-data-dir") ?? process.env.ACTIVETAB_CHROME_USER_DATA_DIR;
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const profilesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

function outputDiagnostic(value, kind) {
  const format = arg("--format") ?? "json";
  if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown.");
  const sectionId = arg("--section") ?? null;
  const listSections = args.includes("--list-sections");
  if ((sectionId || listSections) && format !== "markdown") throw new Error("--section and --list-sections require --format markdown.");
  if (sectionId && listSections) throw new Error("Use either --section ID or --list-sections, not both.");
  const text = format === "markdown" ? `${formatOperatorMarkdown(value, kind, { sectionId, listSections })}\n` : `${JSON.stringify(value, null, 2)}\n`;
  return new Promise(resolveWrite => stdout.write(text, resolveWrite));
}

async function approveRunLocalPublicRead(proposal) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  stdout.write("\nRun-local public read approval\n");
  stdout.write(`Origin: ${proposal.origin}${proposal.pagePath}\nTarget: ${proposal.targetId}\nFields:\n`);
  for (const field of proposal.fields) {
    stdout.write(`  ${field.name} <- ${field.sourceHeader ?? field.sourceKey}\n`);
  }
  stdout.write(`Requested output: ${proposal.requestedOutput.join(", ")}\n`);
  stdout.write(`Record limit: ${proposal.maxRecords}\nByte limit: ${proposal.maxBytes}\nExpires in: ${Math.ceil(proposal.expiresInMs / 60_000)} minute(s)\n`);
  stdout.write("This grant applies to this principal, target, observed source, and run only.\n");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`Type '${proposal.approvalPhrase}' to approve these fields: `)).trim() === proposal.approvalPhrase;
  } finally {
    rl.close();
  }
}

if (command === "doctor") {
  const report = await inspectOperatorEnvironment({
    profileId: arg("--profile") ?? null,
    profilesDir,
    fixtureScenarioDir: resolve(profilesDir, "..", "test-lab", "catalog", "scenarios"),
    extensionDir: resolve(profilesDir, "..", "extension")
  });
  await outputDiagnostic(report, "doctor");
  if (report.status !== "ok") process.exitCode = 1;
  process.exit();
}
if (command === "inspect-run") {
  const runId = args[1] && !args[1].startsWith("--") ? args[1] : arg("--run-id");
  if (!runId) throw new Error("inspect-run requires a runId.");
  const report = await inspectDurableRun(runId, {
    ...(arg("--run-state-dir") ? { runStateDir: arg("--run-state-dir") } : {}),
    ...(arg("--telemetry-db") ? { telemetryDb: arg("--telemetry-db") } : {})
  });
  await outputDiagnostic(report, "inspect-run");
  if (report.status !== "available") process.exitCode = 2;
  process.exit();
}
if (command === "export-trace") {
  const runId = args[1] && !args[1].startsWith("--") ? args[1] : arg("--run-id");
  if (!runId) throw new Error("export-trace requires a runId.");
  if (!args.includes("--redacted")) throw new Error("export-trace requires --redacted.");
  const report = await exportRedactedTrace(runId, {
    ...(arg("--telemetry-db") ? { databasePath: arg("--telemetry-db") } : {})
  });
  await outputDiagnostic(report, "export-trace");
  if (report.status !== "available") process.exitCode = 2;
  process.exit();
}

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
  stdout.write("ActiveTab local native CDP runtime\n\nCommands:\n  doctor [--profile ID] [--format json|markdown]\n  inspect-run <runId> [--run-state-dir PATH] [--telemetry-db PATH] [--format json|markdown]\n  export-trace <runId> --redacted [--telemetry-db PATH] [--format json|markdown]\n  targets [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n  observe --target ID [--profile lightweight|interaction|structural|visual] [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n  run --target ID --goal TEXT [--planner-mode auto|deterministic|model|workflow] [--profile ID|--scope current-origin] [--journal PATH] [--workflow-store PATH] [--auto-connect] [--user-data-dir PATH]\n  resume --journal PATH --goal TEXT [--planner-mode auto|deterministic|model|workflow] [--profile ID|--scope current-origin] [--workflow-store PATH] [--auto-connect] [--user-data-dir PATH] [--endpoint URL]\n\nDoctor validates local runtime, browser grant readiness, model/image configuration, Jev, profile bindings, durable state, Fixture Lab, and output storage without probing browser targets. Inspect-run correlates durable state with the selected redacted telemetry trace and reports resume safety. Trace exports require --redacted, verify the append-only event hash chain, and include causal lineage, model accounting, fixture references, workflow hashes, and evidence references. Markdown output decomposes reports into headings and bounded evidence blocks.\n\nNavigation runs default to --planner-mode auto. Auto routes supported reads, compound requests, and registered workflows through guarded workflow planning; ordinary navigation uses the existing direct or semantic planner. Use an explicit --planner-mode to select another route. Observation profiles select the evidence cost: lightweight reads route and lifecycle state, interaction adds fresh DOM/AX candidates, structural returns DOM/AX/frame evidence, and visual adds a screenshot. Screenshot capture is off by default. Use --profile ID to bind navigation to a local environment profile in ./profiles. For explicitly authorized public read-only navigation without a profile, --scope current-origin asks for the observed origin in an interactive run; non-interactive runs require ACTIVETAB_AUTHORIZED_ORIGIN to be set out of band to that exact origin. This temporary scope permits only the current HTTP(S) origin and adds no form or mutation operations. Resuming a task requires the same profile or scope authorization used when it started. Task journals store only a goal fingerprint and environment fingerprint; supply the same goal and profile/scope again to resume. Chrome auto-connect requires remote debugging enabled at chrome://inspect/#remote-debugging and the browser's permission prompt. Each selected tab still requires exact target-ID confirmation. Non-interactive control requires ACTIVETAB_AUTHORIZED_TARGET_ID set out of band after explicit consent.\n");
  stdout.write("Diagnostic Markdown: use inspect-run/export-trace with --format markdown and either --list-sections or --section ID to list headings or return one focused subtree.\n");
  process.exit(0);
}

const journalPath = arg("--journal");
const journal = journalPath ? new TaskJournal(journalPath) : undefined;
const workflowStorePath = arg("--workflow-store");
const workflowStore = workflowStorePath ? new WorkflowStore(workflowStorePath) : undefined;
const extractionFieldPolicy = await loadExtractionFieldPolicy(process.env.ACTIVETAB_EXTRACTION_POLICY_FILE);
const capabilityService = new CapabilityService({
  classifyField: extractionFieldPolicy.classifyField,
  authorizeRead: extractionFieldPolicy.authorizeRead,
  authorizeRelease: extractionFieldPolicy.authorizeRelease,
  classifyPublicField: extractionFieldPolicy.classifyPublicField,
  publicFieldPolicy: extractionFieldPolicy.publicFieldPolicy,
  authorizePublicRead: extractionFieldPolicy.authorizePublicRead,
  authorizePublicRelease: extractionFieldPolicy.authorizePublicRelease,
  approvePublicRead: approveRunLocalPublicRead,
  authorizePagination: extractionFieldPolicy.authorizePagination
});
const principalId = process.env.ACTIVETAB_PRINCIPAL_ID ?? "local_cli_automation";
const resumeState = command === "resume" ? await journal?.read() : undefined;
if (command === "resume" && !resumeState) throw new Error("resume requires --journal PATH.");
let environment = command === "run" || command === "resume" ? await loadEnvironmentProfile(arg("--profile")) : null;
const requestedScope = arg("--scope");
if (requestedScope && requestedScope !== "current-origin") throw new Error("--scope supports only current-origin.");
if (requestedScope && arg("--profile")) throw new Error("Use either --profile or --scope current-origin, not both.");
if (requestedScope && command !== "run" && command !== "resume") throw new Error("--scope current-origin is available only for run and resume.");
const resumedGoal = command === "resume" ? arg("--goal") ?? resumeState.goal : undefined;
if (command === "resume" && resumeState.requiresGoalInput && !resumeState.goalFingerprint) throw new Error("This legacy task journal redacts its goal without a fingerprint and cannot safely resume; start a new task.");
if (command === "resume" && resumeState.goalFingerprint && !arg("--goal")) throw new Error("This task journal omits the original goal. Resume with --goal and re-enter the same request; goal text is not stored in the journal.");
if (command === "resume" && resumeState.goalFingerprint && resumeState.goalFingerprint !== taskGoalFingerprint(resumedGoal)) throw new Error("The supplied goal does not match the task journal's goal fingerprint.");
const targetId = resumeState?.targetId ?? arg("--target");
if (!targetId) throw new Error("--target is required.");
if (command === "run" || command === "resume") {
  const modelPreflight = await preflightModelCapabilities();
  writeModelPreflightSummary(modelPreflight);
}
let connection;
let session;
let decisionRuntime;
const managedSessions = new Set();
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
  const resolvedJournalEndpoint = resolved.journalEndpoint ?? resolved.endpoint;
  if (resumeState && resumeState.endpoint !== "local-cdp"
    && resumeState.endpoint !== resolved.endpoint && resumeState.endpoint !== resolvedJournalEndpoint) {
    throw new Error("The task journal belongs to a different CDP endpoint.");
  }
  session = await new BrowserSession(resolved).attach();
  managedSessions.add(session);
  if (requestedScope === "current-origin") {
    const initialObservation = await session.observe({ profile: "lightweight" });
    const observedOrigin = normalizeOrigin(initialObservation?.page?.url);
    if (!observedOrigin) throw new Error("The selected tab has no valid HTTP or HTTPS origin to authorize.");
    if (!stdin.isTTY) {
      if (process.env.ACTIVETAB_AUTHORIZED_ORIGIN !== observedOrigin) {
        throw new Error(`Non-interactive current-origin scope requires ACTIVETAB_AUTHORIZED_ORIGIN=${observedOrigin}, set out of band after explicit consent.`);
      }
    } else {
      const rl = createInterface({ input: stdin, output: stdout });
      const answer = await rl.question(`Authorize read-only navigation within this origin for this run?\n  ${observedOrigin}\nType the exact origin to continue: `);
      rl.close();
      if (answer.trim() !== observedOrigin) throw new Error("Current-origin scope was not confirmed.");
    }
    environment = buildEphemeralCurrentOriginBinding(initialObservation.page.url);
  }
  if (runStateStore) {
    await runStateStore.init();
    decisionRuntime = createDecisionRuntime();
  }
  if (command === "observe") print(await session.observe({ profile: arg("--profile") ?? "interaction", includeRawInResponse: true }));
  else if (command === "run") {
    const goal = arg("--goal");
    if (!goal) throw new Error("--goal is required.");
    const taskJournal = journal ?? new TaskJournal(`.activetab/${targetId}.json`);
    const result = await withTargetExecutionLease(runStateStore, session, `cli-run-${randomUUID()}`, lease => {
      const reattachSameTarget = supportsAuthorizedSameTargetReattachment(session)
        ? createAuthorizedSameTargetReattacher({
          session,
          environment,
          assertLeaseTokenCurrent: lease.assertLeaseTokenCurrent,
          bindSession: lease.bindSession,
          onSessionCreated: nextSession => managedSessions.add(nextSession),
          onSessionCommitted: nextSession => { session = nextSession; }
        })
        : null;
      return new NavigationEngine(session, {
        journal: taskJournal, workflowStore, decisionRuntime, environment, capabilityService, principalId,
        executionMode: "standalone", plannerMode: plannerModeFromArgs(args), assertExecutionLease: lease.assertCurrent,
        reattachSameTarget
      }).run(goal);
    });
    print(result);
    if (result.status !== "succeeded") process.exitCode = 2;
  } else if (command === "resume") {
    const result = await withTargetExecutionLease(runStateStore, session, `cli-resume-${randomUUID()}`, lease => {
      const reattachSameTarget = supportsAuthorizedSameTargetReattachment(session)
        ? createAuthorizedSameTargetReattacher({
          session,
          environment,
          assertLeaseTokenCurrent: lease.assertLeaseTokenCurrent,
          bindSession: lease.bindSession,
          onSessionCreated: nextSession => managedSessions.add(nextSession),
          onSessionCommitted: nextSession => { session = nextSession; }
        })
        : null;
      return new NavigationEngine(session, {
        journal, workflowStore, decisionRuntime, environment, capabilityService, principalId,
        executionMode: "standalone", plannerMode: plannerModeFromArgs(args), assertExecutionLease: lease.assertCurrent,
        reattachSameTarget
      }).run(resumedGoal, { resumeState });
    });
    print(result);
    if (result.status !== "succeeded") process.exitCode = 2;
  } else throw new Error(`Unknown command: ${command}`);
} finally {
  decisionRuntime?.close();
  for (const managedSession of managedSessions) await managedSession.close().catch(() => {});
  await connection?.close();
}
