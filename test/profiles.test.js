import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWorkflow } from "../src/testing/schema.js";

const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");
const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "cloud-agent");

test("profile files are valid JSON with required fields", () => {
  const files = readdirSync(profilesDir).filter(f => f.endsWith(".json") && f !== "profile-schema.json");
  assert.ok(files.length >= 2, "Expected at least two profile files.");
  for (const file of files) {
    const content = JSON.parse(readFileSync(join(profilesDir, file), "utf8"));
    assert.ok(content.profile_id, `${file} has profile_id`);
    assert.ok(content.name, `${file} has name`);
    assert.ok(Array.isArray(content.origin_patterns), `${file} has origin_patterns`);
    assert.ok(Array.isArray(content.authentication_realms), `${file} has authentication_realms`);
    for (const source of content.diagnostic_sources ?? []) {
      assert.equal(source.validation_required, true, `${file}:${source.source_id} requires validation`);
      assert.ok(source.authority, `${file}:${source.source_id} has authority`);
      assert.ok(source.scope, `${file}:${source.source_id} has scope`);
      assert.ok(source.sensitivity, `${file}:${source.source_id} has sensitivity`);
    }
  }
});

test("example cloud-agent workflows are labeled planning templates, not executable workflows", () => {
  const files = readdirSync(examplesDir).filter(f => f.endsWith(".json"));
  assert.ok(files.length >= 5, "Expected at least five example workflows.");
  for (const file of files) {
    const workflow = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
    assert.ok(workflow.workflow_id, `${file} has workflow_id`);
    assert.ok(workflow.steps, `${file} has steps`);
    // Per P0-E, these are unqualified planning templates. They must be
    // explicitly labeled as such and must NOT be treated as executable.
    assert.equal(workflow.template, true, `${file} must be explicitly labeled template:true`);
    const normalized = {
      id: workflow.workflow_id,
      name: workflow.name,
      steps: workflow.steps.map(step => ({
        id: step.id,
        type: step.type,
        url: step.url,
        action: step.action,
        assertion: step.assertion,
        condition: step.condition
      }))
    };
    const result = validateWorkflow(normalized);
    // Templates that happen to validate structurally still carry
    // executable:false, so the runner must not load them automatically.
    if (result.valid) {
      assert.equal(workflow.executable, false, `${file} must be explicitly non-executable.`);
    }
  }
});

test("example workflows include required test scenarios", () => {
  const files = readdirSync(examplesDir).filter(f => f.endsWith(".json"));
  const ids = files.map(f => JSON.parse(readFileSync(join(examplesDir, f), "utf8")).workflow_id);
  for (const expected of ["cloud-agent-smoke", "cloud-agent-mcp-lifecycle", "cloud-agent-execution-recovery", "cloud-agent-session-isolation", "cloud-agent-diagnostic-correlation"]) {
    assert.ok(ids.includes(expected), `Expected workflow '${expected}'`);
  }
});
