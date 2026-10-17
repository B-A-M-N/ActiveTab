import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveCloudAgentEntry,
  hasCloudAgentTaskComposer,
  verifyCloudAgentReady,
  discoverVisibleDiagnosticSurfaces,
  createCloudAgentEntryWorkflow
} from "../src/testing/qualifyCloudAgent.js";

const environment = {
  applicationEntryUrl: "https://staging.freeinference.org",
  authorizedOrigins: ["https://staging.freeinference.org", "https://agents-staging.freeinference.org"],
  environmentId: "freeinference-staging",
  applications: [{
    applicationId: "fi-agents",
    authenticationRealm: "agents-session",
    candidateEntry: "https://agents-staging.freeinference.org"
  }]
};

test("Cloud Agent profile entry is only an identity hint and must be authorized", () => {
  assert.deepEqual(resolveCloudAgentEntry(environment), {
    url: "https://agents-staging.freeinference.org/",
    origin: "https://agents-staging.freeinference.org",
    applicationId: "fi-agents",
    authenticationRealm: "agents-session"
  });
  assert.throws(() => resolveCloudAgentEntry({
    ...environment,
    applications: [{ ...environment.applications[0], candidateEntry: "https://untrusted.example/" }]
  }), /not authorized/);
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

test("entry workflow follows the visible UI from staging and skips navigation when already at the composer", () => {
  const stagingPage = { page: { url: "https://staging.freeinference.org/dashboard", title: "FreeInference" }, candidates: [] };
  const fromStaging = createCloudAgentEntryWorkflow(environment, stagingPage);
  assert.equal(fromStaging.alreadyAtComposer, false);
  assert.equal(fromStaging.workflow.steps[0].type, "goal");
  assert.doesNotMatch(JSON.stringify(fromStaging.workflow), /https:\/\/agents-staging/);
  assert.equal(fromStaging.workflow.steps.at(-1).type, "assert");

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
