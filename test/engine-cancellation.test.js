import test from "node:test";
import assert from "node:assert/strict";
import { FixtureNavigationEngine as NavigationEngine } from "../test-support/fixtureNavigationEngine.js";

/**
 * A scripted fake session: the first observe() reports one candidate; the
 * click() hangs until released, simulating an in-flight CDP operation.
 */
function makeHangingSession() {
  let signalClickStarted;
  const clickStarted = new Promise(resolve => { signalClickStarted = resolve; });
  const evidence = { evidenceId: "ev-0", page: { url: "https://example.test", title: "Home" }, headings: [{ level: 1, text: "Home" }], candidates: [], scrollTargets: [] };
  return {
    target: { id: "t1", endpoint: "test", url: "https://example.test/" },
    attached: true,
    observeCalls: 0,
    releaseClick: null,
    clickStarted,
    async observe() {
      this.observeCalls++;
      return {
        evidenceId: `ev-${this.observeCalls}`,
        page: { url: "https://example.test", title: "Home" },
        headings: [{ level: 1, text: "Home" }],
        frames: [],
        candidates: [{ identity: "c1", tag: "button", role: "button", name: "Open settings", visible: true, disabled: false }],
        scrollTargets: [],
        domMutationCount: 0, lifecycleEventCount: 0, pageChangeFingerprint: "fp"
      };
    },
    async click() {
      await new Promise(resolve => {
        this.releaseClick = resolve;
        signalClickStarted();
      });
    },
    async scroll() { throw new Error("not used"); },
    async typeSearchPhrase() { throw new Error("not used"); },
    async waitForChange() {},
    async verifySearchOutcome() { return true; }
  };
}

test("cancellation during an in-flight action yields canceled with the action preserved as uncertain", async () => {
  const session = makeHangingSession();
  const controller = new AbortController();
  const fixtureAction = {
    operationId: "test.hanging_fixture_button",
    authorize({ action, candidate, observation }) {
      const fresh = observation?.candidates?.some(item => item.identity === candidate?.identity && item.name === "Open settings" && item.visible === true);
      let observedOrigin = null;
      try { observedOrigin = new URL(observation?.page?.url).origin; } catch {}
      return action === "click" && candidate?.identity === "c1" && observedOrigin === "https://example.test" && fresh
        ? { allowed: true, category: "test_fixture_action" }
        : { allowed: false, reason: "Only the fresh scripted fixture button is allowed." };
    }
  };
  const engine = new NavigationEngine(session, { maxActions: 3, signal: controller.signal, operationAuthorizer: fixtureAction, planner: {
    async plan() { return { status: "planned", action: { type: "click", target: { identity: "c1", tag: "button", role: "button", name: "Open settings", visible: true, disabled: false } } }; }
  } });
  const pending = engine.run("Open the settings page");
  // Synchronize with actual dispatch instead of relying on a timing guess.
  const clickDidStart = await Promise.race([
    session.clickStarted.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1_000))
  ]);
  if (!clickDidStart) assert.fail(`The fixture action did not dispatch: ${JSON.stringify(await pending)}`);
  controller.abort();
  session.releaseClick();
  const result = await pending;
  assert.equal(result.status, "canceled", JSON.stringify(result));
  assert.equal(result.uncertain, true, "post-dispatch cancellation preserves uncertainty");
  assert.match(result.reason, /unknown outcome/);
});

test("cancellation before any dispatch returns canceled without an uncertain action", async () => {
  const session = makeHangingSession();
  const controller = new AbortController();
  const engine = new NavigationEngine(session, { signal: controller.signal, planner: {
    async plan() {
      controller.abort(); // cancel while planning
      return { status: "planned", action: { type: "click", target: { identity: "c1", tag: "button", role: "button", name: "Open settings", visible: true, disabled: false } } };
    }
  } });
  const result = await engine.run("Open the settings page");
  assert.equal(result.status, "canceled");
  assert.equal(result.attempts, 0, "no browser input was dispatched");
});

test("stress: rapid concurrent cancellations do not corrupt state", async t => {
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    const target = { id: `stress-target-${i}`, endpoint: "local-cdp" };
    let observeCount = 0;
    const session = {
      target,
      documentGeneration: 1,
      async observe() {
        observeCount++;
        // Simulate a small delay to increase interleaving.
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 20)));
        return {
          evidenceId: `ev-${observeCount}`,
          page: { url: "http://fixture.local/", title: "Stress" },
          candidates: [{ identity: `btn-${observeCount}`, backendNodeId: observeCount, targetId: target.id, tag: "button", role: "button", name: "Open details", visible: true, disabled: false, documentGeneration: 1 }],
          headings: [], frames: [], scrollTargets: [],
          pageChangeFingerprint: `fp-${observeCount}`
        };
    },
      async click(candidate) {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 50)));
        return { dispatched: true, backendNodeId: candidate.backendNodeId };
      },
      async waitForChange() {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 100)));
      }
    };
    const controller = new AbortController();
    const engine = new NavigationEngine(session, { maxActions: 3, maxRecoveries: 1, signal: controller.signal });
    // Cancel after a short, variable delay.
    setTimeout(() => controller.abort(), Math.floor(Math.random() * 50) + 10);
    tasks.push(engine.run("Open details").catch(error => ({ status: "error", reason: String(error?.message ?? error) })));
  }
  const results = await Promise.all(tasks);
  // Every result must be a truthful terminal state; no partial or fabricated success.
  for (const result of results) {
    assert.ok(["canceled", "unresolved", "needs_human", "succeeded"].includes(result.status), `Unexpected status: ${result.status}`);
  }
  const statuses = results.map(r => r.status);
  t.diagnostic(`Stress results: ${statuses.join(", ")}`);
});
