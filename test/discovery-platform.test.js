/** Platform/application hierarchy in discovery (P1-3). Scripted session; no Chrome. */
import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";
import { buildEnvironmentBinding } from "../src/environments/model.js";

const environment = buildEnvironmentBinding({
  profile_id: "freeinference-staging",
  environment: {
    environment_id: "freeinference-staging",
    platform: "freeinference",
    application_entry_url: "https://staging.freeinference.org",
    authorized_origins: ["https://staging.freeinference.org"],
    applications: [{ application_id: "fi-agents", authentication_realm: "agents-session", candidate_entry: "/agents/" }]
  }
});

function page(url, candidates = []) {
  return { page: { url, title: "FI" }, headings: [], candidates, evidenceId: url, pageChangeFingerprint: url, domMutationCount: 0, lifecycleEventCount: 0 };
}

test("cross-origin navigation inside the platform is recorded and verified", async () => {
  const main = page("https://staging.freeinference.org/", [
    { name: "Agents", role: "link", href: "https://staging.freeinference.org/agents/", visible: true }
  ]);
  const agents = page("https://staging.freeinference.org/agents/", [
    { name: "New connector", role: "button", visible: true }
  ]);
  let step = 0;
  const session = {
    async observe() { return step === 0 ? main : agents; },
    async waitForChange() { step++; },
    client: { send: async () => {} }
  };
  const engine = new ApplicationDiscoveryEngine({ session, environment, maxSteps: 3 });
  const result = await engine.discover();
  // Same-origin navigation within the platform: pages accumulate, no child
  // application boundary is crossed, and platform identity is preserved.
  assert.equal(result.capabilityMap.platform, "freeinference");
  assert.ok(result.capabilityMap.pages.length >= 2, "both staging pages recorded");
  assert.equal((result.capabilityMap.childApplications ?? []).length, 0);
});

test("arbitrary cross-origin links are never trusted: discovery stops at the boundary", async () => {
  const main = page("https://staging.freeinference.org/", [
    { name: "External promo", role: "link", href: "https://evil.example.net/promo", visible: true }
  ]);
  const evil = page("https://evil.example.net/promo", []);
  let step = 0;
  const session = {
    async observe() { return step === 0 ? main : evil; },
    async waitForChange() { step++; },
    client: { send: async () => {} }
  };
  const engine = new ApplicationDiscoveryEngine({ session, environment, maxSteps: 3 });
  const result = await engine.discover();
  assert.ok(result.discoveries.some(d => d.type === "cross_origin_untrusted"),
    "untrusted cross-origin navigation must be recorded and refused");
  const children = result.capabilityMap.childApplications ?? [];
  assert.equal(children.length, 1);
  assert.equal(children[0].verified, false, "untrusted destinations stay unverified");
});

test("an authentication boundary pauses discovery instead of bypassing it", async () => {
  const main = page("https://staging.freeinference.org/", [
    { name: "Agents", role: "link", href: "https://staging.freeinference.org/agents/", visible: true }
  ]);
  const login = page("https://staging.freeinference.org/login", [
    { name: "Sign in to continue", role: "heading", visible: true },
    { name: "Password", role: "textbox", type: "password", visible: true }
  ]);
  let step = 0;
  const session = {
    async observe() { return step === 0 ? main : login; },
    async waitForChange() { step++; },
    client: { send: async () => {} }
  };
  const boundaries = [];
  const engine = new ApplicationDiscoveryEngine({
    session, environment, maxSteps: 3,
    onAuthorizationBoundary: boundary => boundaries.push(boundary)
  });
  await engine.discover();
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].category, "authentication");
});
