import { fixtureFaults, fixtureFaultTrigger } from "./faultInjector.js";

const allowedRealms = new Set(["platform", "cloud-agent"]);
const allowedOperations = new Set(["create_test_agent_run"]);
const allowedStatuses = new Set(["succeeded", "failed"]);
const externalOperations = new Set(["mark_email_read", "extract_inbox_records"]);

export function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) return { valid: false, errors: ["Scenario must be an object."] };
  if (scenario.schema_version !== 1) errors.push("schema_version must be 1.");
  if (typeof scenario.scenario_id !== "string" || !scenario.scenario_id.trim() || scenario.scenario_id.length > 96) errors.push("scenario_id must be a bounded non-empty string.");
  if (typeof scenario.site_family !== "string" || !scenario.site_family.trim()) errors.push("site_family is required.");
  if (!Number.isSafeInteger(scenario.seed) || scenario.seed < 0) errors.push("seed must be a non-negative safe integer.");
  const qualification = scenario.qualification;
  if (!qualification || typeof qualification !== "object" || Array.isArray(qualification)) {
    errors.push("qualification provenance is required.");
  } else {
    if (!new Set(["resolver", "integration", "outcome", "live"]).has(qualification.level)) errors.push("qualification.level is unsupported.");
    for (const field of ["provider_id", "provider_identity", "source_revision", "oracle_reference"]) {
      if (typeof qualification[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(qualification[field])) errors.push(`qualification.${field} must be a bounded structural identifier.`);
    }
    if (qualification.level === "resolver" && qualification.independent_application_outcome !== false) errors.push("Resolver qualification cannot claim an independent application outcome.");
    if (qualification.level === "integration" && qualification.independent_application_outcome !== false) errors.push("Integration qualification cannot claim an independent application outcome.");
    if ((qualification.level === "outcome" || qualification.level === "live") && qualification.independent_application_outcome !== true) errors.push("Outcome and live qualification require an independent application outcome.");
    if (qualification.level === "live") errors.push("Live qualification requires a separately authorized live-target runtime and cannot run through Fixture Lab.");
  }
  if (scenario.site_family === "fi-agent-twin") {
    const realms = scenario.application?.auth_realms;
    if (!Array.isArray(realms) || realms.length !== 2 || new Set(realms).size !== realms.length || realms.some(realm => !allowedRealms.has(realm))) errors.push("FI Agent Twin scenarios require the platform and cloud-agent auth realms.");
    if (typeof scenario.application?.build !== "string" || !scenario.application.build) errors.push("application.build is required.");
    if (!allowedOperations.has(scenario.task?.operation)) errors.push("task.operation is unsupported.");
    if (typeof scenario.task?.model_ref !== "string" || !scenario.task.model_ref) errors.push("task.model_ref is required.");
    if (typeof scenario.task?.prompt_ref !== "string" || !scenario.task.prompt_ref) errors.push("task.prompt_ref is required.");
    if (typeof scenario.task?.prompt !== "string" || !scenario.task.prompt.trim() || scenario.task.prompt.length > 4000) errors.push("task.prompt must be bounded and non-empty.");
    if (typeof scenario.task?.goal !== "string" || !scenario.task.goal.trim() || scenario.task.goal.length > 4000) errors.push("task.goal must be bounded and non-empty.");
    const oracle = scenario.oracle;
    if (!Number.isInteger(oracle?.maximum_created_runs) || oracle.maximum_created_runs < 0 || oracle.maximum_created_runs > 10) errors.push("oracle.maximum_created_runs must be between 0 and 10.");
    if (!allowedStatuses.has(oracle?.expected_final_status)) errors.push("oracle.expected_final_status is unsupported.");
    if (typeof oracle?.require_exact_inputs !== "boolean" || typeof oracle?.require_no_unauthorized_mutations !== "boolean") errors.push("oracle flags must be booleans.");
  } else if (scenario.site_family === "webarena-infinity-gmail") {
    if (typeof scenario.application?.build !== "string" || !scenario.application.build) errors.push("application.build must pin the external application version.");
    if (!externalOperations.has(scenario.task?.operation)) errors.push("task.operation is unsupported for WebArena-Infinity Gmail.");
    if (typeof scenario.task?.goal !== "string" || !scenario.task.goal.trim() || scenario.task.goal.length > 1000) errors.push("task.goal must be bounded and non-empty.");
    if (scenario.task?.operation === "mark_email_read") {
      if (typeof scenario.task?.subject !== "string" || !scenario.task.subject.trim() || scenario.task.subject.length > 200) errors.push("task.subject must be bounded and non-empty.");
      if (typeof scenario.task?.sender !== "string" || !scenario.task.sender.trim() || scenario.task.sender.length > 200) errors.push("task.sender must be bounded and non-empty.");
      if (typeof scenario.task?.initialIsRead !== "boolean" || typeof scenario.task?.expectedIsRead !== "boolean"
        || scenario.task.initialIsRead === scenario.task.expectedIsRead) errors.push("Gmail task must declare a changing, typed read-state postcondition.");
      if (scenario.task?.expectedIsRead !== true) errors.push("This benchmark adapter only supports marking a message as read.");
      if (scenario.oracle?.kind !== "email_read_state") errors.push("oracle.kind must be email_read_state.");
    } else if (scenario.task?.operation === "extract_inbox_records") {
      if (!Array.isArray(scenario.task?.emails) || scenario.task.emails.length < 2 || scenario.task.emails.length > 20) errors.push("Inbox extraction scenarios require 2 to 20 synthetic emails.");
      else {
        const subjects = new Set();
        for (const email of scenario.task.emails) {
          if (!email || typeof email !== "object" || Array.isArray(email)
            || typeof email.subject !== "string" || !email.subject.trim() || email.subject.length > 200
            || typeof email.sender !== "string" || !email.sender.trim() || email.sender.length > 120) {
            errors.push("Every synthetic email requires a bounded subject and sender.");
            continue;
          }
          if (subjects.has(email.subject)) errors.push("Synthetic inbox subjects must be unique for independent completeness checks.");
          subjects.add(email.subject);
        }
      }
      if (scenario.oracle?.kind !== "email_list_contents") errors.push("oracle.kind must be email_list_contents.");
    }
  } else {
    errors.push(`Unsupported site_family '${scenario.site_family}'.`);
  }
  if (!Array.isArray(scenario.faults) || scenario.faults.length > 16) errors.push("faults must be a bounded array.");
  else for (const fault of scenario.faults) {
    if (!fixtureFaults.includes(fault?.behavior)) errors.push(`Unsupported fault '${String(fault?.behavior)}'.`);
    else if (fault?.when !== fixtureFaultTrigger(fault.behavior)) errors.push(`Fault '${fault.behavior}' must target '${fixtureFaultTrigger(fault.behavior)}'.`);
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidScenario(scenario) {
  const result = validateScenario(scenario);
  if (!result.valid) throw new Error(`Invalid fixture scenario: ${result.errors.join(" ")}`);
  return scenario;
}
