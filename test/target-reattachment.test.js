import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizedSameTargetReattacher } from "../src/browser/targetReattachment.js";

function setup({
  endpoint = "http://127.0.0.1:9222",
  targetId = "target-a",
  targetUrl = "https://shop.example.test/destination",
  observedUrl = targetUrl,
  assertLeaseTokenCurrent = async () => {},
  bindSession = async () => {},
  resolveTarget = async (resolvedEndpoint, resolvedTargetId) => ({
    id: resolvedTargetId,
    endpoint: resolvedEndpoint,
    url: targetUrl,
    type: "page"
  })
} = {}) {
  const original = {
    attached: false,
    target: { id: targetId, endpoint, url: "https://shop.example.test/start" }
  };
  const calls = { leaseChecks: 0, targetResolutions: 0, observations: 0, created: 0, commits: 0 };
  const reattach = createAuthorizedSameTargetReattacher({
    session: original,
    environment: { authorizedOrigins: ["https://shop.example.test"] },
    assertLeaseTokenCurrent: async () => { calls.leaseChecks++; await assertLeaseTokenCurrent(); },
    bindSession: async session => { calls.commits++; await bindSession(session); },
    resolveTarget: async (...args) => { calls.targetResolutions++; return await resolveTarget(...args); },
    createSession: target => ({
      target,
      attached: false,
      async attach() { this.attached = true; return this; },
      async observe(options) {
        calls.observations++;
        this.selectionGoal = options.selectionGoal;
        return {
          targetId,
          evidenceId: "fresh-evidence",
          page: { url: observedUrl, title: "Destination" },
          candidates: []
        };
      },
      async close() { this.closed = true; }
    }),
    onSessionCreated: () => { calls.created++; }
  });
  return { reattach, calls, targetId, endpoint };
}

test("authorized same-target reattachment observes fresh evidence and commits the original lease", async () => {
  let boundSession = null;
  const fixture = setup({ bindSession: async session => { boundSession = session; } });
  const replacement = await fixture.reattach({
    targetId: fixture.targetId,
    endpoint: `${fixture.endpoint}/`,
    selectionGoal: "Open the destination"
  });

  assert.equal(replacement.session.attached, true);
  assert.equal(replacement.observation.evidenceId, "fresh-evidence");
  assert.equal(replacement.session.selectionGoal, "Open the destination");
  assert.equal(fixture.calls.targetResolutions, 1);
  assert.equal(fixture.calls.observations, 1);
  assert.equal(fixture.calls.leaseChecks, 3, "the durable fence is checked before discovery, after attach, and after observation");
  await replacement.commit();
  await replacement.commit();
  assert.equal(fixture.calls.leaseChecks, 4, "the durable fence is checked once more before commit");
  assert.equal(boundSession, replacement.session);
  assert.equal(fixture.calls.commits, 1, "commit is idempotent");
});

test("reattachment refuses a different target or loopback endpoint before discovery", async () => {
  const fixture = setup();
  await assert.rejects(
    fixture.reattach({ targetId: "target-b", endpoint: fixture.endpoint }),
    error => error.reattachFailureCode === "target_scope_rejected"
  );
  await assert.rejects(
    fixture.reattach({ targetId: fixture.targetId, endpoint: "http://127.0.0.1:9223" }),
    error => error.reattachFailureCode === "target_scope_rejected"
  );
  assert.equal(fixture.calls.targetResolutions, 0);
});

test("reattachment refuses a target that leaves the authorized origin and does not keep its session", async () => {
  const fixture = setup({ targetUrl: "https://outside.example.test/page" });
  await assert.rejects(
    fixture.reattach({ targetId: fixture.targetId, endpoint: fixture.endpoint }),
    error => error.reattachFailureCode === "target_scope_rejected"
  );
  assert.equal(fixture.calls.created, 0, "no CDP session is attached to an unauthorized target route");
  assert.equal(fixture.calls.observations, 0);
});

test("reattachment checks the durable lease before target discovery", async () => {
  const fixture = setup({
    assertLeaseTokenCurrent: async () => { throw Object.assign(new Error("lease lost"), { code: "RUN_TARGET_LEASE_LOST" }); }
  });
  await assert.rejects(
    fixture.reattach({ targetId: fixture.targetId, endpoint: fixture.endpoint }),
    error => error.code === "RUN_TARGET_LEASE_LOST" && error.reattachFailureCode === "lease_rebind_failed"
  );
  assert.equal(fixture.calls.targetResolutions, 0);
});

test("reattachment closes a replacement when the fresh observed route is outside scope", async () => {
  const fixture = setup({ observedUrl: "https://outside.example.test/page" });
  let created;
  // The setup's session factory is overridden with a small test adapter that
  // records the object while preserving the same exact-target checks.
  const reattach = createAuthorizedSameTargetReattacher({
    session: { attached: false, target: { id: fixture.targetId, endpoint: fixture.endpoint, url: "https://shop.example.test/start" } },
    environment: { authorizedOrigins: ["https://shop.example.test"] },
    assertLeaseTokenCurrent: async () => {},
    bindSession: async () => {},
    resolveTarget: async endpoint => ({ id: fixture.targetId, endpoint, url: "https://shop.example.test/destination", type: "page" }),
    createSession: target => (created = {
      target, attached: false,
      async attach() { this.attached = true; },
      async observe() { return { targetId: fixture.targetId, page: { url: "https://outside.example.test/page" } }; },
      async close() { this.closed = true; }
    })
  });
  await assert.rejects(
    reattach({ targetId: fixture.targetId, endpoint: fixture.endpoint }),
    error => error.reattachFailureCode === "reattach_identity_mismatch"
  );
  assert.equal(created.closed, true);
});
