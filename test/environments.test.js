/** Environment/application identity and routing contract (P0-1). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironmentBinding, verifyObservedUrl, isLoopbackUrl } from "../src/environments/model.js";
import { loadEnvironmentBinding } from "../src/testing/profiles.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");

test("loopback can never be the application entry", () => {
  for (const url of ["http://127.0.0.1:13002", "http://localhost:3000", "http://[::1]:8080"]) {
    assert.ok(isLoopbackUrl(url), `${url} is loopback`);
    assert.throws(
      () => buildEnvironmentBinding({ profile_id: "x", environment: { environment_id: "x", application_entry_url: url } }),
      /loopback/i,
      `${url} must be rejected as an application entry`
    );
  }
});

test("a tunnel diagnostic endpoint requires explicit ssh_tunnel transport and verified remote target", () => {
  const base = { profile_id: "x", environment: { environment_id: "x", application_entry_url: "https://staging.example.org" } };
  assert.throws(
    () => buildEnvironmentBinding({ ...base, environment: { ...base.environment, diagnostic_endpoint: "http://127.0.0.1:18000" } }),
    /diagnostic_transport/i
  );
  assert.throws(
    () => buildEnvironmentBinding({ ...base, environment: { ...base.environment, diagnostic_endpoint: "http://127.0.0.1:18000", diagnostic_transport: "ssh_tunnel" } }),
    /remote_target/i
  );
  const ok = buildEnvironmentBinding({
    ...base,
    environment: { ...base.environment, diagnostic_endpoint: "http://127.0.0.1:18000", diagnostic_transport: "ssh_tunnel", remote_target: "staging.internal:18000" }
  });
  assert.equal(ok.diagnosticEndpoint, "http://127.0.0.1:18000");
  assert.equal(ok.diagnosticTransport, "ssh_tunnel");
  assert.equal(ok.remoteTarget, "staging.internal:18000");
  // The entry stays the real website; the tunnel is transport only.
  assert.equal(ok.applicationEntryUrl, "https://staging.example.org");
});

test("authorized_origins always includes the entry origin", () => {
  const binding = buildEnvironmentBinding({
    profile_id: "x",
    environment: { environment_id: "x", application_entry_url: "https://a.example.org", authorized_origins: [] }
  });
  assert.ok(binding.authorizedOrigins.includes("https://a.example.org"));
});

test("verifyObservedUrl rejects unrelated origins (untrusted redirects)", () => {
  const binding = buildEnvironmentBinding({
    profile_id: "x",
    environment: { environment_id: "x", application_entry_url: "https://staging.freeinference.org" }
  });
  assert.ok(verifyObservedUrl(binding, "https://staging.freeinference.org/dashboard").ok);
  const bad = verifyObservedUrl(binding, "https://evil.example.org/phish");
  assert.ok(!bad.ok);
  assert.match(bad.reason, /not authorized/);
});

test("staging profiles bind to the real FreeInference website with distinct realms", async () => {
  for (const profileId of ["freeinference-staging", "cloud-agent-staging"]) {
    const binding = await loadEnvironmentBinding(profilesDir, profileId);
    assert.equal(binding.applicationEntryUrl, "https://staging.freeinference.org");
    assert.ok(!isLoopbackUrl(binding.applicationEntryUrl));
    const realms = binding.applications.map(a => a.authenticationRealm);
    assert.ok(realms.includes("agents-session"), `${profileId} declares the Agents realm`);
  }
  const fi = await loadEnvironmentBinding(profilesDir, "freeinference-staging");
  const realmIds = fi.applications.map(a => a.authenticationRealm);
  for (const expected of ["fi-session", "fi-admin", "agents-session", "pgadmin-session"]) {
    assert.ok(realmIds.includes(expected), `freeinference-staging declares realm ${expected}`);
  }
});
