import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldKeepOwnedBrowserOpen,
  qualifyCloudAgent
} from "../src/testing/qualifyCloudAgent.js";
import {
  resolveCloudAgentEntry,
  hasCloudAgentTaskComposer,
  verifyCloudAgentReady,
  discoverVisibleDiagnosticSurfaces,
  createCloudAgentEntryWorkflow
} from "../src/testing/cloudAgentEntry.js";
import { InterventionStore } from "../src/runtime/interventions.js";
import { RunStateStore, blockingQualificationRuns } from "../src/testing/runState.js";
import { BrowserStepHandler } from "../src/testing/steps/browserStepHandler.js";
import { validateWorkflow } from "../src/testing/schema.js";

test("replacement qualification remains blocked by unresolved runs unless one is explicitly abandoned", () => {
  const runs = [
    { runId: "waiting-auth", status: "waiting_for_authentication" },
    { runId: "running", status: "running" }
  ];

  assert.deepEqual(blockingQualificationRuns(runs), runs);
  assert.deepEqual(blockingQualificationRuns(runs, { selectedDiscardId: "waiting-auth" }), [runs[1]]);
});

const environment = {
  applicationEntryUrl: "https://staging.freeinference.org",
  authorizedOrigins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"],
  environmentId: "freeinference-staging",
  authenticationRealms: [
    { realmId: "fi-session", scope: ["dashboard"], separateCredentials: false },
    { realmId: "agents-session", scope: ["agents_app"], separateCredentials: true }
  ],
  applications: [
    {
      applicationId: "fi-dashboard",
      authenticationRealm: "fi-session",
      candidateEntry: "/dashboard",
      entryLinkLabels: ["Dashboard"]
    },
    {
      applicationId: "fi-agents",
      authenticationRealm: "agents-session",
      candidateEntry: "https://agents-staging.freeinference.org/",
      entryLinkLabels: ["Agents", "Cloud Agents"]
    }
  ]
};

test("Cloud Agent profile entry is only an identity hint and must be authorized", () => {
  assert.deepEqual(resolveCloudAgentEntry(environment), {
    url: "https://agents-staging.freeinference.org/",
    origin: "https://agents-staging.freeinference.org",
    pathname: "/",
    applicationId: "fi-agents",
    authenticationRealm: "agents-session",
    linkLabels: ["Agents", "Cloud Agents"]
  });
  assert.throws(() => resolveCloudAgentEntry({
    ...environment,
    applications: environment.applications.map(app => app.applicationId === "fi-agents"
      ? { ...app, candidateEntry: "https://untrusted.example/" }
      : app)
  }), /not authorized/);
});

test("owned staging browser stays open after a blocked or uncertain result until explicit stop", () => {
  const signal = new AbortController().signal;
  assert.equal(shouldKeepOwnedBrowserOpen("owned", { qualificationState: "BLOCKED" }, signal), true);
  assert.equal(shouldKeepOwnedBrowserOpen("owned", { qualificationState: "UNCERTAIN" }, signal), true);
  assert.equal(shouldKeepOwnedBrowserOpen("owned", { qualificationState: "PASSED" }, signal), true);
  assert.equal(shouldKeepOwnedBrowserOpen("owned", { qualificationState: "BLOCKED" }, { aborted: true }), false);
  assert.equal(shouldKeepOwnedBrowserOpen("attached", { qualificationState: "BLOCKED" }, signal), false);
});

test("Cloud Agent auth resumes only when the protected task composer is visible", () => {
  assert.equal(hasCloudAgentTaskComposer({ candidates: [
    { name: "New task", role: "link", visible: true },
    { name: "Describe the task", role: "textbox", visible: true, disabled: false }
  ] }), true);
  assert.equal(hasCloudAgentTaskComposer({ candidates: [
    { name: "Sign in", role: "button", visible: true },
    { name: "Password", role: "textbox", visible: true, disabled: false }
  ] }), false);
});

test("read-only discovery reports visible diagnostic links from either authorized staging app", () => {
  const observation = {
    page: { url: "https://staging.freeinference.org/dashboard" },
    candidates: [
      { name: "Request History", role: "link", href: "https://staging.freeinference.org/admin/history?token=private", visible: true },
      { name: "Admin Console", role: "link", href: "https://staging.freeinference.org/admin/", visible: true },
      { name: "Open", role: "link", href: "https://staging.freeinference.org/admin/trace-viewer", visible: true },
      { name: "Production Audit Logs", role: "link", href: "https://prod.freeinference.org/audit", visible: true },
      { name: "Delete workspace", role: "button", href: null, visible: true }
    ]
  };
  assert.deepEqual(discoverVisibleDiagnosticSurfaces(observation, environment), [
    {
      sourceOrigin: "https://staging.freeinference.org",
      sourcePage: "https://staging.freeinference.org/dashboard",
      label: "Request History",
      role: "link",
      destination: "https://staging.freeinference.org/admin/history",
      category: "admin-entry",
      action: "not opened"
    },
    {
      sourceOrigin: "https://staging.freeinference.org",
      sourcePage: "https://staging.freeinference.org/dashboard",
      label: "Admin Console",
      role: "link",
      destination: "https://staging.freeinference.org/admin/",
      category: "admin-entry",
      action: "not opened"
    },
    {
      sourceOrigin: "https://staging.freeinference.org",
      sourcePage: "https://staging.freeinference.org/dashboard",
      label: "admin trace",
      role: "link",
      destination: "https://staging.freeinference.org/admin/trace-viewer",
      category: "admin-entry",
      action: "not opened"
    }
  ]);
});

test("Agent readiness requires the observed authorized origin and task composer", () => {
  const observation = {
    page: { url: "https://agents-staging.freeinference.org/runs", title: "FreeInference Cloud Agent" },
    evidenceId: "ev-agent",
    candidates: [
      { name: "New task", role: "link", visible: true },
      { name: "Describe the task", role: "textbox", visible: true, disabled: false }
    ]
  };
  assert.deepEqual(verifyCloudAgentReady(observation, environment, "https://agents-staging.freeinference.org"), {
    ok: true,
    origin: "https://agents-staging.freeinference.org",
    evidenceId: "ev-agent"
  });
  assert.equal(verifyCloudAgentReady(observation, environment, "https://staging.freeinference.org").ok, false);
  assert.equal(verifyCloudAgentReady({ ...observation, page: { ...observation.page, url: "https://production.example/" } }, environment, "https://agents-staging.freeinference.org").ok, false);
});

test("entry workflow follows fresh, exact Dashboard then Agents links with URL postconditions", () => {
  const rootPage = {
    page: { url: "https://staging.freeinference.org/", title: "FreeInference" },
    evidenceId: "ev-root",
    candidates: [
      { name: "Dashboard", role: "link", tag: "a", href: "https://staging.freeinference.org/dashboard", visible: true }
    ]
  };
  const fromRoot = createCloudAgentEntryWorkflow(environment, rootPage);
  assert.equal(validateWorkflow(fromRoot.workflow).valid, true);
  assert.equal(fromRoot.alreadyAtComposer, false);
  assert.deepEqual(fromRoot.workflow.steps.map(step => step.id), [
    "follow-visible-dashboard-link", "follow-visible-agents-link", "verify-task-composer"
  ]);
  assert.deepEqual(fromRoot.workflow.steps.slice(0, 2).map(step => step.type), ["interact", "interact"]);
  assert.deepEqual(fromRoot.workflow.steps[0].action.target, {
    nameIn: ["Dashboard"], role: "link", hrefOrigin: "https://staging.freeinference.org", hrefPath: "/dashboard", visible: true
  });
  assert.deepEqual(fromRoot.workflow.steps[1].action.target, {
    nameIn: ["Agents", "Cloud Agents"], role: "link", hrefOrigin: "https://agents-staging.freeinference.org", hrefPath: "/", visible: true
  });
  assert.match(fromRoot.workflow.steps[1].action.postcondition.pattern, /^\^https:\/\/agents-staging\\\.freeinference\\\.org/);
  assert.equal(JSON.stringify(fromRoot.workflow).includes("https://agents-staging.freeinference.org/"), false);

  const dashboardPage = {
    page: { url: "https://staging.freeinference.org/dashboard", title: "FreeInference" },
    evidenceId: "ev-dashboard",
    candidates: [
      { name: "Agents", role: "link", tag: "a", href: "https://agents-staging.freeinference.org/", visible: true }
    ]
  };
  const fromDashboard = createCloudAgentEntryWorkflow(environment, dashboardPage);
  assert.equal(validateWorkflow(fromDashboard.workflow).valid, true);
  assert.deepEqual(fromDashboard.workflow.steps.map(step => step.id), ["follow-visible-agents-link", "verify-task-composer"]);
});

test("visible-entry selectors refuse hidden, disabled, wrong-origin, and ambiguous links", () => {
  const handler = new BrowserStepHandler();
  const target = {
    nameIn: ["Agents", "Cloud Agents"],
    role: "link",
    hrefOrigin: "https://agents-staging.freeinference.org",
    hrefPath: "/",
    visible: true
  };
  const visible = { name: "Agents", role: "link", href: "https://agents-staging.freeinference.org/", visible: true };
  assert.equal(handler.resolveCandidate({ page: { url: "https://staging.freeinference.org/dashboard" }, evidenceId: "ev", candidates: [visible] }, { target }), visible);
  for (const rejected of [
    { ...visible, visible: false },
    { ...visible, disabled: true },
    { ...visible, href: "https://production.example/" },
    { ...visible, href: "https://agents-staging.freeinference.org/other" }
  ]) {
    assert.equal(handler.resolveCandidate({ page: { url: "https://staging.freeinference.org/dashboard" }, evidenceId: "ev", candidates: [rejected] }, { target }), null);
  }
  assert.equal(handler.resolveCandidate({ page: { url: "https://staging.freeinference.org/dashboard" }, evidenceId: "ev", candidates: [visible, { ...visible, backendNodeId: 2 }] }, { target }), null);
});

test("entry workflow skips link clicks when already at the protected task composer", () => {

  const agentPage = {
    page: { url: "https://agents-staging.freeinference.org/", title: "FreeInference Cloud Agent" },
    candidates: [
      { name: "New task", role: "link", visible: true },
      { name: "Describe the task", role: "textbox", visible: true, disabled: false }
    ]
  };
  const alreadyReady = createCloudAgentEntryWorkflow(environment, agentPage);
  assert.equal(alreadyReady.alreadyAtComposer, true);
  assert.deepEqual(alreadyReady.workflow.steps.map(step => step.type), ["assert"]);
});

test("owned qualification resumes the same durable run after process restart and verified composer reattachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-staging-resume-"));
  const runDir = join(dir, "run-state");
  const interventionDir = join(dir, "interventions");
  const reportDir = join(dir, "reports");
  try {
    const makeSession = page => ({
      attached: true,
      persistent: true,
      target: { id: "owned-target-fixture", url: page.url },
      async observe() {
        return {
          page: { url: page.url, title: page.title },
          candidates: page.candidates,
          evidenceId: page.evidenceId,
          pageChangeFingerprint: page.url
        };
      },
      async waitForChange() {},
      async close() {},
      client: { async send() { throw new Error("No browser dispatch is expected in this resume fixture."); } }
    });
    const initialSession = makeSession({
      url: "https://staging.freeinference.org/login",
      title: "Sign in to continue",
      evidenceId: "ev-login",
      candidates: [
        { name: "Sign in", role: "button", visible: true },
        { name: "Password", role: "textbox", type: "password", visible: true }
      ]
    });
    const firstRunStore = new RunStateStore(runDir);
    await firstRunStore.init();
    const firstInterventions = new InterventionStore(interventionDir);
    await firstInterventions.init();
    const firstReport = await qualifyCloudAgent({
      session: initialSession,
      environment,
      interventions: firstInterventions,
      runStore: firstRunStore,
      mode: "owned",
      profileId: "cloud-agent-staging",
      reportDir,
      onHumanIntervention: async () => false
    });

    assert.equal(firstReport.qualificationState, "WAITING_FOR_HUMAN");
    const persisted = new RunStateStore(runDir);
    await persisted.init();
    const suspended = persisted.get(firstReport.runId);
    assert.equal(suspended.status, "waiting_for_authentication");
    assert.equal(suspended.resumeCursor.suspendedStepId, "follow-visible-agents-route");
    assert.equal(suspended.profileId, "cloud-agent-staging");
    assert.equal(suspended.mode, "owned");
    assert.equal(JSON.stringify(suspended.resumeCursor).includes("Follow the visible Cloud Agents link"), false);

    const resumedInterventions = new InterventionStore(interventionDir);
    await resumedInterventions.init();
    const composerSession = makeSession({
      url: "https://agents-staging.freeinference.org/runs",
      title: "Cloud Agent",
      evidenceId: "ev-composer",
      candidates: [
        { name: "New task", role: "link", visible: true },
        { name: "Describe the task", role: "textbox", visible: true, disabled: false }
      ]
    });
    const resumedReport = await qualifyCloudAgent({
      session: composerSession,
      environment,
      interventions: resumedInterventions,
      runStore: persisted,
      resumeRunState: suspended,
      mode: "owned",
      profileId: "cloud-agent-staging",
      reportDir,
      onHumanIntervention: async (_record, { inspectCurrentPage }) => (await inspectCurrentPage()).ok
    });

    assert.equal(resumedReport.runId, firstReport.runId);
    assert.equal(resumedReport.gates.agents_application_entered.passed, true);
    assert.equal(resumedReport.qualificationState, "UNCERTAIN", "reaching the composer still does not claim an Agent operation ran");
    const completedState = persisted.get(firstReport.runId);
    assert.equal(completedState.status, "uncertain");
    assert.equal(completedState.resumeCursor, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
