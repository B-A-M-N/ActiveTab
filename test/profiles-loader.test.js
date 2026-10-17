import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileLoader } from "../src/testing/profiles.js";

const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

test("ProfileLoader lists profiles", async () => {
  const loader = new ProfileLoader(profilesDir);
  const profiles = await loader.listProfiles();
  assert.ok(profiles.length >= 2);
  const ids = profiles.map(p => p.profile_id);
  assert.ok(ids.includes("freeinference-staging"));
  assert.ok(ids.includes("cloud-agent-staging"));
});

test("ProfileLoader loads a profile by id", async () => {
  const loader = new ProfileLoader(profilesDir);
  const profile = await loader.loadProfile("cloud-agent-staging");
  assert.ok(profile);
  assert.ok(Array.isArray(profile.diagnostic_sources));
  assert.ok(profile.diagnostic_sources.length >= 1);
});

test("ProfileLoader returns null for unknown profile", async () => {
  const loader = new ProfileLoader(profilesDir);
  assert.equal(await loader.loadProfile("no-such-profile"), null);
});

test("ProfileLoader loads test packs from examples", async () => {
  const loader = new ProfileLoader(profilesDir);
  const workflow = await loader.loadTestPack("cloud-agent-smoke");
  assert.ok(workflow);
  assert.equal(workflow.workflow_id, "cloud-agent-smoke");
  assert.ok(Array.isArray(workflow.steps));
});

test("ProfileLoader validates example workflows", async () => {
  const loader = new ProfileLoader(profilesDir);
  const workflow = await loader.loadTestPack("cloud-agent-smoke");
  const result = loader.validateWorkflow(workflow);
  assert.equal(result.valid, true);
  assert.ok(result.normalized.steps.length >= 2);
});

test("ProfileLoader rejects unknown test pack", async () => {
  const loader = new ProfileLoader(profilesDir);
  assert.equal(await loader.loadTestPack("no-such-workflow"), null);
});
