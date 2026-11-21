/** Environment/application identity and routing contract (P0-1). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironmentBinding, buildEphemeralCurrentOriginBinding, resolveObservedApplication, verifyObservedUrl, isLoopbackUrl } from "../src/environments/model.js";
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

test("ephemeral current-origin scope authorizes only the observed public origin and adds no operation grants", () => {
  const binding = buildEphemeralCurrentOriginBinding("https://catalog.example/products?sort=price#results");
  assert.equal(binding.scopeKind, "current_origin");
  assert.equal(binding.ephemeral, true);
  assert.deepEqual(binding.authorizedOrigins, ["https://catalog.example"]);
  assert.equal(binding.applications.length, 1);
  assert.equal(binding.applications[0].applicationId, "ephemeral_public_site");
  assert.equal(binding.applications[0].workflowOperations, undefined);
  assert.equal(verifyObservedUrl(binding, "https://catalog.example/product/1").ok, true);
  assert.equal(verifyObservedUrl(binding, "https://other.example/product/1").ok, false);
  assert.throws(() => buildEphemeralCurrentOriginBinding("http://127.0.0.1:3000/"), /non-loopback HTTP or HTTPS origin/u);
  assert.throws(() => buildEphemeralCurrentOriginBinding("javascript:alert(1)"), /non-loopback HTTP or HTTPS origin/u);
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

test("environment bindings preserve exact diagnostic route evidence from the profile", () => {
  const bindings = [{ name: "runDetail", method: "GET", pathTemplate: "/api/admin/agent/runs/{runId}", observedStatus: 200, contentType: "application/json", sourceEvidenceId: "route-evidence-1" }];
  const environment = buildEnvironmentBinding({
    profile_id: "x",
    environment: {
      environment_id: "x",
      application_entry_url: "https://staging.example.org",
      diagnostic_endpoint: "https://diagnostics.example.org",
      diagnostic_transport: "direct",
      diagnostic_endpoint_bindings: bindings
    }
  });
  assert.equal(environment.diagnosticEndpoint, "https://diagnostics.example.org");
  assert.deepEqual(environment.diagnosticEndpointBindings, bindings);
  assert.equal(Object.isFrozen(environment.diagnosticEndpointBindings), true);
  assert.equal(Object.isFrozen(environment.diagnosticEndpointBindings[0]), true);
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

test("environment bindings retain profile and authentication-realm identity for resume fencing", () => {
  const profile = {
    profile_id: "staging-app",
    authentication_realms: [
      { realm_id: "agent-session", scope: ["agents"], separate_credentials: true },
      { realm_id: "dashboard-session", scope: ["dashboard", "admin"], separate_credentials: true }
    ],
    environment: {
      environment_id: "shared-staging",
      application_entry_url: "https://staging.example.org",
      applications: [{ application_id: "agent", authentication_realm: "agent-session", candidate_entry: "https://agents-staging.example.org/" }]
    }
  };
  const binding = buildEnvironmentBinding(profile);
  assert.equal(binding.profileId, "staging-app");
  assert.deepEqual(binding.authenticationRealms, [
    { realmId: "agent-session", scope: ["agents"], separateCredentials: true },
    { realmId: "dashboard-session", scope: ["admin", "dashboard"], separateCredentials: true }
  ]);
  const otherProfile = buildEnvironmentBinding({
    ...profile,
    profile_id: "other-staging-surface",
    authentication_realms: [{ realm_id: "other-session", scope: ["other"], separate_credentials: true }]
  });
  assert.notEqual(binding.profileId, otherProfile.profileId);
  assert.notDeepEqual(binding.authenticationRealms, otherProfile.authenticationRealms);
});

test("application workflow operation IDs are explicit, bounded, and immutable profile bindings", () => {
  const profile = {
    profile_id: "form-capability-profile",
    environment: {
      environment_id: "form-capability-profile",
      application_entry_url: "https://forms.example.test",
      applications: [{
        application_id: "forms-app",
        authentication_realm: null,
        candidate_entry: "/settings",
        workflow_operations: { fill: "forms_fill", select: "forms_select" }
      }]
    }
  };
  const binding = buildEnvironmentBinding(profile);
  assert.deepEqual(binding.applications[0].workflowOperations, { fill: "forms_fill", select: "forms_select" });
  assert.equal(Object.isFrozen(binding.applications[0].workflowOperations), true);
  assert.throws(() => buildEnvironmentBinding({
    ...profile,
    environment: { ...profile.environment, applications: [{ ...profile.environment.applications[0], workflow_operations: { submit: "forms_submit" } }] }
  }), /unsupported application workflow operations/u);
  assert.throws(() => buildEnvironmentBinding({
    ...profile,
    environment: { ...profile.environment, applications: [{ ...profile.environment.applications[0], workflow_operations: { fill: "Forms Fill" } }] }
  }), /invalid 'fill' workflow operation ID/u);
});

test("profile entry-link labels are copied into immutable application bindings", () => {
  const binding = buildEnvironmentBinding({
    profile_id: "entry-links",
    environment: {
      environment_id: "entry-links",
      application_entry_url: "https://staging.example.org",
      applications: [{
        application_id: "agents",
        authentication_realm: "agents-session",
        candidate_entry: "https://agents-staging.example.org/",
        entry_link_labels: ["Agents", "Cloud Agents", "Agents"]
      }]
    }
  });
  assert.deepEqual(binding.applications[0].entryLinkLabels, ["Agents", "Cloud Agents"]);
  assert.equal(Object.isFrozen(binding.applications[0].entryLinkLabels), true);
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

test("observed application resolution uses profile routes and realms, including same-origin applications", async () => {
  const binding = await loadEnvironmentBinding(profilesDir, "freeinference-staging");
  const cases = [
    ["https://staging.freeinference.org/dashboard", "fi-dashboard", "fi-session"],
    ["https://staging.freeinference.org/dashboard/admin/users", "fi-admin", "fi-admin"],
    ["https://staging.freeinference.org/dashboard/admin/users/42", "fi-admin", "fi-admin"],
    ["https://staging.freeinference.org/pgadmin/browser/", "fi-pgadmin", "pgadmin-session"],
    ["https://agents-staging.freeinference.org/", "fi-agents", "agents-session"]
  ];
  for (const [url, applicationId, realm] of cases) {
    const resolved = resolveObservedApplication(binding, url);
    assert.equal(resolved.status, "matched", url);
    assert.equal(resolved.applicationId, applicationId, url);
    assert.equal(resolved.authenticationRealm, realm, url);
  }
  assert.equal(resolveObservedApplication(binding, "https://staging.freeinference.org/unmapped").status, "unmatched");
  assert.equal(resolveObservedApplication(binding, "https://staging.freeinference.org/dashboard/admin/users", { authenticationRealm: "fi-session" }).status, "unmatched");
  assert.equal(resolveObservedApplication(binding, "https://evil.example.test/dashboard").status, "unmatched");
});

test("application resolution refuses same-route identity ambiguity", () => {
  const binding = buildEnvironmentBinding({
    profile_id: "ambiguous-apps",
    authentication_realms: [
      { realm_id: "realm-a", scope: ["a"] },
      { realm_id: "realm-b", scope: ["b"] }
    ],
    environment: {
      environment_id: "ambiguous-apps",
      application_entry_url: "https://staging.example.test",
      applications: [
        { application_id: "app-a", authentication_realm: "realm-a", candidate_entry: "/shared" },
        { application_id: "app-b", authentication_realm: "realm-b", candidate_entry: "/shared" }
      ]
    }
  });
  assert.equal(resolveObservedApplication(binding, "https://staging.example.test/shared").status, "ambiguous");
  assert.equal(resolveObservedApplication(binding, "https://staging.example.test/shared", { authenticationRealm: "realm-b" }).applicationId, "app-b");
});
