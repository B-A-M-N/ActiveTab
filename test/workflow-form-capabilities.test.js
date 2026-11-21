import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedAction } from "../src/runtime/authorizedExecutor.js";
import { WorkflowGraphPlanner } from "../src/navigation/workflowPlanner.js";
import { environmentBindingFingerprint, NavigationEngine } from "../src/navigation/engine.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";
import { createNativeFormWorkflowCapabilities, createProfileFormWorkflowCapabilities } from "../src/navigation/workflowCapabilities.js";
import { WorkflowSynthesizer } from "../src/navigation/workflowSynthesizer.js";

const environment = {
  environmentId: "fixture-environment",
  entryOrigin: "https://fixture.example",
  authorizedOrigins: ["https://fixture.example"],
  authenticationRealms: [{ realmId: "shop-session" }, { realmId: "admin-session" }],
  applications: [
    { applicationId: "shop", candidateEntry: "https://fixture.example/shop", authenticationRealm: "shop-session" },
    { applicationId: "admin", candidateEntry: "https://fixture.example/admin", authenticationRealm: "admin-session" }
  ]
};

const session = {
  target: { id: "form-tab", endpoint: "fixture" },
  attached: true,
  documentGeneration: 7,
  async verifyControlValue(_candidate, expectedValue) {
    return { verified: true, matches: ["Foo.Bar+QA@example.com  ", "US"].includes(expectedValue) };
  },
  async verifyCheckboxState(_candidate, expectedChecked) {
    return { verified: true, matches: expectedChecked === true };
  }
};

const operationIds = {
  fill: "fixture_forms_fill",
  select: "fixture_forms_select",
  toggle: "fixture_forms_toggle",
  apply_filter: "fixture_forms_apply_filter"
};

function candidate(identity, overrides = {}) {
  return {
    identity,
    backendNodeId: identity === "email" ? 11 : identity === "country" ? 12 : 13,
    targetId: "form-tab",
    documentGeneration: 7,
    tag: "input",
    type: "email",
    role: "textbox",
    name: "Email",
    contextName: "Shop profile",
    visible: true,
    disabled: false,
    readOnly: false,
    ...overrides
  };
}

function observation({ evidenceId = "before", url = "https://fixture.example/shop/profile", candidates = [], title = "Shop profile", semanticPage = undefined, documentGeneration = 7 } = {}) {
  return {
    evidenceId,
    targetId: "form-tab",
    documentGeneration,
    page: { url, title },
    candidates,
    ...(semanticPage ? { semanticPage } : {})
  };
}

function formCapabilities() {
  return createNativeFormWorkflowCapabilities({
    session,
    environment,
    applicationId: "shop",
    operationIds
  });
}

test("native form capabilities expose only scoped, non-sensitive editable controls", () => {
  const [fill, select] = formCapabilities();
  const email = candidate("email");
  const password = candidate("password", { type: "password", name: "Password" });
  const token = candidate("token", { name: "Access token" });
  const file = candidate("file", { type: "file" });
  const remote = candidate("remote", { frameTargetId: "oopif-1" });
  const country = candidate("country", { tag: "select", type: "select-one", role: "combobox", name: "Country" });
  const page = observation({ candidates: [email, password, token, file, remote, country] });

  assert.equal(fill.effectClass, "shared_mutation");
  assert.equal(fill.requiresApproval, true);
  assert.equal(fill.operationId, operationIds.fill);
  assert.deepEqual(fill.resolveTarget(page), ["email"]);
  assert.equal(fill.validateTarget(password, page), false);
  assert.equal(fill.validateTarget(token, page), false);
  assert.equal(fill.validateTarget(remote, page), false);
  assert.equal(select.operationId, operationIds.select);
  assert.deepEqual(select.resolveTarget(page), ["country"]);
  assert.deepEqual(select.resolveTarget(observation({ url: "https://fixture.example/admin/users", candidates: [country] })), []);
});

test("workflow engine wires only exact profile-declared form operations and fingerprints them", async () => {
  const profileEnvironment = buildEnvironmentBinding({
    profile_id: "forms-profile",
    authentication_realms: [{ realm_id: "shop-session", scope: ["shop"] }],
    environment: {
      environment_id: "forms-profile",
      application_entry_url: "https://fixture.example",
      applications: [{
        application_id: "shop",
        authentication_realm: "shop-session",
        candidate_entry: "/shop/profile",
        workflow_operations: { fill: "shop_forms_fill", select: "shop_forms_select", toggle: "shop_forms_toggle", apply_filter: "shop_forms_apply_filter" }
      }]
    }
  });
  let synthesisInput = null;
  let observations = 0;
  const browserSession = {
    target: { id: "profile-form-tab", endpoint: "fixture", url: "https://fixture.example/shop/profile" },
    attached: true,
    async observe() {
      observations++;
      return {
        evidenceId: `profile_form_observation_${observations}`,
        targetId: this.target.id,
        documentGeneration: 1,
        page: { url: "https://fixture.example/shop/profile", title: "Shop profile" },
        headings: [],
        candidates: [],
        scrollTargets: []
      };
    }
  };
  const engine = new NavigationEngine(browserSession, {
    plannerMode: "workflow",
    workflowSynthesizer: {
      async synthesize(input) {
        synthesisInput = input;
        return { status: "unavailable", failureCode: "fixture_unavailable" };
      }
    },
    environment: profileEnvironment,
    maxActions: 1
  });
  await engine.run("Update the shop profile", {
    workflowIntent: { purposeCode: "update_profile", outcomeCode: "profile_field_updated" }
  });

  const formCapabilities = synthesisInput.capabilities.filter(capability => capability.action === "fill" || capability.action === "select" || capability.action === "toggle" || capability.id === "apply_observed_filter");
  assert.deepEqual(formCapabilities.map(capability => [capability.id, capability.operationId]), [
    ["fill_observed_text_field", "shop_forms_fill"],
    ["select_observed_option", "shop_forms_select"],
    ["set_observed_checkbox_state", "shop_forms_toggle"],
    ["apply_observed_filter", "shop_forms_apply_filter"]
  ]);
  assert.deepEqual(createProfileFormWorkflowCapabilities({
    session: browserSession,
    environment: profileEnvironment,
    applicationId: "unknown_app"
  }), []);

  const changedOperations = {
    ...profileEnvironment,
    applications: profileEnvironment.applications.map(application => ({
      ...application,
      workflowOperations: { ...application.workflowOperations, fill: "replacement_fill" }
    }))
  };
  assert.notEqual(environmentBindingFingerprint(profileEnvironment), environmentBindingFingerprint(changedOperations),
    "resume state is fenced when trusted profile operation bindings change");
});

test("checkbox filters require an exact caller input and verify only the requested state", async () => {
  const toggle = formCapabilities().find(capability => capability.id === "set_observed_checkbox_state");
  const checkbox = candidate("brand-filter", { type: "checkbox", role: "checkbox", name: "NVIDIA", tag: "input" });
  const before = observation({ candidates: [checkbox] });
  const after = observation({ evidenceId: "after-filter-toggle", candidates: [checkbox] });
  const result = await toggle.verify({
    verificationCode: toggle.verificationCodes[0], target: checkbox, inputValue: "checked",
    beforeObservation: before, afterObservation: after
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.evidenceRefs, ["before", "after-filter-toggle"]);
  assert.equal(toggle.validateTarget(candidate("password-filter", { type: "checkbox", name: "password reset" }), before), false);
  assert.equal((await toggle.verify({ verificationCode: toggle.verificationCodes[0], target: checkbox,
    inputValue: "yes", beforeObservation: before, afterObservation: after })).status, "uncertain");
});

test("SPA filter apply needs a scoped non-submit control and a visible result transition", () => {
  const apply = formCapabilities().find(capability => capability.id === "apply_observed_filter");
  const button = candidate("apply", { tag: "button", type: "button", role: "button", name: "Apply filters" });
  const before = observation({ candidates: [button] });
  const after = observation({ evidenceId: "after-spa-filter", candidates: [button], title: "Filtered products", semanticPage: { collections: [{ kind: "repeated_dom_structure", records: [{ fields: [{ role: "name", value: "GPU A" }] }] }] } });
  assert.deepEqual(apply.resolveTarget(before), ["apply"]);
  assert.equal(apply.validateTarget(button, observation({ url: "https://fixture.example/admin/users", candidates: [button] })), false);
  assert.equal(apply.verify({ verificationCode: apply.verificationCodes[0], target: button,
    beforeObservation: before, afterObservation: after }).status, "verified");
  const unchanged = observation({ evidenceId: "unchanged", candidates: [button] });
  assert.equal(apply.verify({ verificationCode: apply.verificationCodes[0], target: button,
    beforeObservation: before, afterObservation: unchanged }).status, "uncertain");
  assert.equal(apply.validateTarget(candidate("submit", { tag: "button", role: "button", type: "submit", name: "Apply filters", submitsForm: true }), before), false);
});

test("fill capability preserves caller inputRef and verifies the exact value against the same application evidence", async () => {
  const [fill] = formCapabilities();
  const field = candidate("email");
  const before = observation({ candidates: [field] });
  const workflowPlan = {
    version: 1,
    steps: [{
      id: "fill_email",
      capabilityId: fill.id,
      targetRole: fill.targetRole,
      targetRef: "candidate_1",
      inputRef: "email",
      dependsOn: [],
      verifyCode: fill.verificationCodes[0],
      onMissing: "stop"
    }]
  };
  const planner = new WorkflowGraphPlanner({
    synthesizer: new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: workflowPlan }; } } }),
    capabilities: [fill],
    inputs: { email: "Foo.Bar+QA@example.com  " },
    taskIntent: { purposeCode: "update_profile", permittedPurposeCodes: ["fill_form"], outcomeCode: "exact_form_value_observed", requiredCapabilityIds: [fill.id] }
  });

  const plan = await planner.plan("Update profile", before);
  assert.equal(plan.status, "planned");
  assert.equal(plan.action.value, "Foo.Bar+QA@example.com  ");
  const after = observation({ evidenceId: "after", candidates: [field] });
  const outcome = await planner.recordOutcome({
    action: plan.action,
    beforeObservation: before,
    afterObservation: after,
    dispatchStatus: "dispatched"
  });
  assert.equal(outcome.status, "verified_pass");
  assert.equal(outcome.reasonCode, "exact_form_value_observed");
  assert.deepEqual(outcome.evidenceRefs, ["before", "after"]);
  assert.equal(JSON.stringify(outcome).includes("Foo.Bar+QA@example.com"), false);
});

test("native form verification rebinds to the current same-target session after recovery", async () => {
  let retiredVerifications = 0;
  let currentVerifications = 0;
  const retired = {
    ...session,
    documentGeneration: 7,
    async verifyControlValue() { retiredVerifications++; throw new Error("retired session used"); }
  };
  const replacement = {
    ...session,
    target: { ...session.target },
    documentGeneration: 8,
    async verifyControlValue(_target, value) {
      currentVerifications++;
      return { verified: true, matches: value === "Foo.Bar+QA@example.com  " };
    }
  };
  let current = retired;
  const [fill] = createNativeFormWorkflowCapabilities({
    session: retired,
    getSession: () => current,
    environment,
    applicationId: "shop",
    operationIds
  });
  const field = candidate("email", { documentGeneration: 8 });
  const before = observation({ evidenceId: "reattached-before", candidates: [field], documentGeneration: 8 });
  const after = observation({ evidenceId: "reattached-after", candidates: [field], documentGeneration: 8 });
  current = replacement;

  const result = await fill.verify({
    verificationCode: fill.verificationCodes[0],
    beforeObservation: before,
    afterObservation: after,
    target: field,
    inputValue: "Foo.Bar+QA@example.com  "
  });
  assert.equal(result.status, "verified");
  assert.equal(retiredVerifications, 0);
  assert.equal(currentVerifications, 1);
});

test("select capability resolves and verifies one caller-bound option value", async () => {
  const [, select] = formCapabilities();
  const country = candidate("country", { tag: "select", type: "select-one", role: "combobox", name: "Country" });
  const before = observation({ candidates: [country] });
  const workflowPlan = {
    version: 1,
    steps: [{
      id: "select_country",
      capabilityId: select.id,
      targetRole: select.targetRole,
      targetRef: "candidate_1",
      inputRef: "country",
      dependsOn: [],
      verifyCode: select.verificationCodes[0],
      onMissing: "stop"
    }]
  };
  const planner = new WorkflowGraphPlanner({
    synthesizer: new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: workflowPlan }; } } }),
    capabilities: [select],
    inputs: { country: "US" },
    taskIntent: { purposeCode: "choose_country", permittedPurposeCodes: ["select_option"], outcomeCode: "exact_selected_option_observed", requiredCapabilityIds: [select.id] }
  });

  const plan = await planner.plan("Choose country", before);
  assert.equal(plan.status, "planned");
  assert.equal(plan.action.type, "select");
  assert.equal(plan.action.value, "US");
  const outcome = await planner.recordOutcome({
    action: plan.action,
    beforeObservation: before,
    afterObservation: observation({ evidenceId: "after-select", candidates: [country] }),
    dispatchStatus: "dispatched"
  });
  assert.equal(outcome.status, "verified_pass");
  assert.equal(outcome.reasonCode, "exact_form_value_observed");
});

test("form target resolution rejects sensitive controls, wrong applications, and missing input references", async () => {
  const [fill] = formCapabilities();
  const password = candidate("password", { type: "password", name: "Password" });
  const passwordPlan = {
    version: 1,
    steps: [{ id: "fill_password", capabilityId: fill.id, targetRole: fill.targetRole,
      targetRef: "candidate_1", inputRef: "password", dependsOn: [],
      verifyCode: fill.verificationCodes[0], onMissing: "stop" }]
  };
  const makePlanner = plan => new WorkflowGraphPlanner({
    synthesizer: new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: plan }; } } }),
    capabilities: [fill],
    inputs: { password: "never-log-this" },
    taskIntent: { purposeCode: "update_profile", permittedPurposeCodes: ["fill_form"], outcomeCode: "exact_form_value_observed", requiredCapabilityIds: [fill.id] }
  });
  const denied = await makePlanner(passwordPlan).plan("Update profile", observation({ candidates: [password] }));
  assert.equal(denied.status, "ambiguous");

  const email = candidate("email");
  const wrongApp = await makePlanner(passwordPlan)
    .plan("Update profile", observation({ url: "https://fixture.example/admin/users", candidates: [email] }));
  assert.equal(wrongApp.status, "ambiguous");

  const missingInput = { ...passwordPlan, steps: [{ ...passwordPlan.steps[0], inputRef: undefined }] };
  const synthesizer = new WorkflowSynthesizer({ provider: { async requestStructured() { return { result: missingInput }; } } });
  const unavailable = await synthesizer.synthesize({
    taskIntent: { purposeCode: "update_profile", permittedPurposeCodes: ["fill_form"], outcomeCode: "exact_form_value_observed", requiredCapabilityIds: [fill.id] },
    observation: observation({ candidates: [email] }),
    capabilities: [fill],
    inputRefs: ["password"]
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.failureCode, "schema");
});

test("native form dispatch still requires the trusted operation authorizer", async () => {
  const [fill] = formCapabilities();
  const field = candidate("email");
  const before = observation({ candidates: [field] });
  let dispatchedValue = null;
  const browserSession = {
    target: { id: "form-tab" },
    attached: true,
    documentGeneration: 7,
    async observe() { return before; },
    async fillField(_target, value) { dispatchedValue = value; return { dispatched: true }; }
  };

  const refused = await executeAuthorizedAction({
    session: browserSession,
    environment,
    action: "fill",
    candidate: field,
    value: "Foo.Bar+QA@example.com  ",
    operationId: fill.operationId,
    assertExecutionLease: async () => {}
  });
  assert.equal(refused.dispatched, false);
  assert.equal(dispatchedValue, null);

  const switchedApplication = {
    ...browserSession,
    async observe() {
      return observation({ url: "https://fixture.example/admin/users", candidates: [field] });
    }
  };
  const staleScope = await executeAuthorizedAction({
    session: switchedApplication,
    environment,
    action: "fill",
    candidate: field,
    value: "Foo.Bar+QA@example.com  ",
    operationId: fill.operationId,
    operationAuthorizer: { authorize() { return { allowed: true }; } },
    validateActionTarget: fill.validateTarget,
    assertExecutionLease: async () => {}
  });
  assert.equal(staleScope.dispatched, false);
  assert.equal(staleScope.category, "workflow_capability_scope_mismatch");
  assert.equal(dispatchedValue, null, "same-origin app changes cannot carry a previously planned form action");

  const authorized = await executeAuthorizedAction({
    session: browserSession,
    environment,
    action: "fill",
    candidate: field,
    value: "Foo.Bar+QA@example.com  ",
    operationId: fill.operationId,
    operationAuthorizer: {
      authorize({ operationId, action, candidate: selected, value }) {
        return { allowed: operationId === fill.operationId && action === "fill" && selected.identity === "email" && value === "Foo.Bar+QA@example.com  " };
      }
    },
    validateActionTarget: fill.validateTarget,
    assertExecutionLease: async () => {}
  });
  assert.equal(authorized.status, "dispatched");
  assert.equal(dispatchedValue, "Foo.Bar+QA@example.com  ");
});
