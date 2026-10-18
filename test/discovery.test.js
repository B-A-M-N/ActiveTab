import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationCapabilityMap, RELATIONSHIP_STRENGTH } from "../src/discovery/capabilityMap.js";
import { ApplicationDiscoveryEngine } from "../src/discovery/engine.js";

const fixtureLease = async () => {};

test("capabilityMap records pages, controls, and network operations", () => {
  const map = new ApplicationCapabilityMap({ applicationId: "http://app.test", origin: "http://app.test" });
  map.recordObservation({
    page: { url: "http://app.test/", title: "Home" },
    candidates: [
      { role: "link", name: "Archive", href: "http://app.test/archive" },
      { role: "button", name: "Submit", href: null },
      { role: "link", name: "Archive", href: "http://app.test/archive" }
    ],
    headings: [{ level: 1, text: "Welcome" }],
    frames: [{ frameId: "f1", url: "http://app.test/", mainFrame: true }],
    networkRequests: [{ method: "GET", url: "http://app.test/api/data" }]
  });
  assert.equal(map.observationCount, 1);
  assert.deepEqual(map.getPageUrls(), ["http://app.test/"]);
  const controls = map.getControls();
  assert.equal(controls.length, 2);
  assert.ok(controls.find(c => c.name === "Archive"));
  assert.ok(controls.find(c => c.name === "Submit"));
  const networkOps = map.getNetworkOperations();
  assert.equal(networkOps.length, 1);
  assert.equal(networkOps[0].url, "http://app.test/api/data");
});

test("capabilityMap uses composite identity — same-label controls on different pages remain distinct", () => {
  const map = new ApplicationCapabilityMap({ applicationId: "http://app.test", origin: "http://app.test" });
  map.recordObservation({ page: { url: "http://app.test/a", title: "A" }, candidates: [{ role: "link", name: "Shared", href: "http://app.test/x" }] });
  map.recordObservation({ page: { url: "http://app.test/b", title: "B" }, candidates: [{ role: "link", name: "Shared", href: "http://app.test/x" }] });
  // The same label on different pages is a different structural context and
  // must NOT collapse into one identity.
  assert.equal(map.getControls().length, 2, "Same-label controls on different pages must remain distinct.");
  const control = map.getControls()[0];
  assert.equal(control.pages.size, 1);
  assert.equal(map.observationCount, 2);
  assert.equal(map.revision, 2);
});

test("capabilityMap preserves dedup within the same page and structural context", () => {
  const map = new ApplicationCapabilityMap({ applicationId: "http://app.test", origin: "http://app.test" });
  map.recordObservation({ page: { url: "http://app.test/a", title: "A" }, candidates: [{ role: "link", name: "Shared", href: "http://app.test/x" }] });
  map.recordObservation({ page: { url: "http://app.test/a", title: "A" }, candidates: [{ role: "link", name: "Shared", href: "http://app.test/x" }] });
  // Re-observing the same page with the same structural context deduplicates.
  assert.equal(map.getControls().length, 1);
  const control = map.getControls()[0];
  assert.equal(control.pages.size, 1);
  assert.equal(map.observationCount, 2);
});

test("capabilityMap toObject serializes with evidence", () => {
  const map = new ApplicationCapabilityMap({ applicationId: "http://app.test", origin: "http://app.test" });
  map.recordObservation({ page: { url: "http://app.test/", title: "Home" }, candidates: [{ role: "link", name: "Link1", href: "http://app.test/link1" }] });
  const obj = map.toObject();
  assert.equal(obj.applicationId, "http://app.test");
  assert.equal(obj.pages[0].title, "Home");
  assert.equal(obj.controls[0].name, "Link1");
  assert.ok(Array.isArray(obj.controls[0].pages));
});

test("discovery engine requires a session", async () => {
  const engine = new ApplicationDiscoveryEngine({ session: null });
  await assert.rejects(() => engine.discover(), /requires a browser session/);
});

test("attached-target discovery refuses before observing when no durable lease is supplied", async () => {
  let observations = 0;
  const session = {
    target: { id: "attached-discovery-target", endpoint: "local-cdp" },
    attached: true,
    async observe() { observations++; return { page: { url: "http://fixture.local/" }, candidates: [] }; }
  };
  const engine = new ApplicationDiscoveryEngine({ session });
  await assert.rejects(() => engine.discover(), /durable browser target execution lease/);
  assert.equal(observations, 0);
});

test("discovery engine performs passive observation and records the initial page", async () => {
  const mockSession = {
    async observe() {
      return {
        page: { url: "http://fixture.local/", title: "Demo shop" },
        candidates: [
          { role: "link", name: "Archive", href: "http://fixture.local/archive", visible: true },
          { role: "button", name: "Submit", visible: true },
          { role: "link", name: "External", href: "http://other.com/x", visible: true },
          { role: "link", name: "Self", href: "http://fixture.local/", visible: true }
        ],
        headings: [{ level: 1, text: "Shop" }],
        frames: [{ frameId: "root", url: "http://fixture.local/", mainFrame: true }],
        evidenceId: "ev-1"
      };
    },
    client: {
      async send(method, params) {
        if (method !== "Page.navigate") throw new Error(`Unexpected ${method}`);
        return {};
      }
    }
  };
  const engine = new ApplicationDiscoveryEngine({ session: mockSession, maxSteps: 2, maxLinksPerStep: 2 });
  const result = await engine.discover();
  assert.ok(result.capabilityMap);
  assert.ok(result.discoveries.some(d => d.type === "initial_observation"));
  assert.ok(result.visitedCount >= 1);
});

test("discovery engine navigates safe same-origin links", async () => {
  let navigationCount = 0;
  const pages = [
    {
      page: { url: "http://fixture.local/", title: "Home" },
      candidates: [{ role: "link", name: "Archive", href: "http://fixture.local/archive", visible: true }],
      headings: [], frames: []
    },
    {
      page: { url: "http://fixture.local/archive", title: "Archive" },
      candidates: [],
      headings: [{ level: 1, text: "Archive" }], frames: []
    }
  ];
  const mockSession = {
    target: { id: "fixture-tab", url: "http://fixture.local/" },
    attached: true,
    async observe() {
      const page = structuredClone(pages[Math.min(navigationCount, 1)]);
      return {
        ...page,
        targetId: this.target.id,
        candidates: page.candidates.map((candidate, index) => ({
          ...candidate,
          identity: `candidate-${index}`,
          targetId: this.target.id,
          documentGeneration: navigationCount + 1,
          backendNodeId: index + 1
        }))
      };
    },
    async click() { navigationCount++; },
    async waitForChange() {}
  };
  const engine = new ApplicationDiscoveryEngine({ session: mockSession, maxSteps: 3, maxLinksPerStep: 2, assertExecutionLease: fixtureLease });
  const result = await engine.discover();
  assert.ok(result.discoveries.some(d => d.type === "navigated" && d.to === "http://fixture.local/archive"));
  assert.ok(result.capabilityMap.pages.some(p => p.url === "http://fixture.local/archive"));
});

test("discovery engine does not navigate unsafe controls", async () => {
  const mockSession = {
    async waitForChange() {},
    async observe() {
      return {
        page: { url: "http://fixture.local/", title: "Home" },
        candidates: [
          { role: "button", name: "Delete", visible: true },
          { role: "link", name: "Disabled", href: "http://fixture.local/x", visible: true, disabled: true },
          { role: "link", name: "NoHref", visible: true },
          { role: "link", name: "External", href: "http://other.com/", visible: true }
        ],
        headings: [], frames: []
      };
    },
    client: { async send() { throw new Error("Should not navigate"); } }
  };
  const engine = new ApplicationDiscoveryEngine({ session: mockSession, maxSteps: 2 });
  const result = await engine.discover();
  assert.ok(result.discoveries.some(d => d.type === "no_more_links" || d.type === "no_safe_navigations"));
});

test("discovery engine respects cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const mockSession = {
    async observe() {
      return {
        page: { url: "http://fixture.local/", title: "Home" },
        candidates: [{ role: "link", name: "Link", href: "http://fixture.local/x", visible: true }],
        headings: [], frames: []
      };
    },
    client: { async send() { return {}; } }
  };
  const engine = new ApplicationDiscoveryEngine({ session: mockSession, signal: controller.signal });
  const result = await engine.discover();
  assert.ok(result.discoveries.some(d => d.type === "aborted" || d.type === "no_more_links" || d.type === "no_safe_navigations"));
});

test("discovery engine saves and reuses knowledge", async t => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const knowledgeDir = await mkdtemp(join(tmpdir(), "activetab-knowledge-test-"));
  try {
    const pages = [
      { page: { url: "http://fixture.local/", title: "Home" }, candidates: [{ role: "link", name: "Archive", href: "http://fixture.local/archive", visible: true }], headings: [], frames: [] },
      { page: { url: "http://fixture.local/archive", title: "Archive" }, candidates: [], headings: [], frames: [] }
    ];
    let observeCount = 0;
    const mockSession = {
      async observe() { return pages[Math.min(observeCount, 1)]; },
      client: { async send(method) { if (method === "Page.navigate") { observeCount++; return {}; } throw new Error(`Unexpected ${method}`); } }
    };
    const engine = new ApplicationDiscoveryEngine({ session: mockSession, maxSteps: 2, maxLinksPerStep: 2, knowledgeDir });
    const result = await engine.discover();
    assert.ok(result.savedKnowledge, "Knowledge was saved.");
    assert.equal(result.savedKnowledge.origin, "http://fixture.local");

    // Second run should load prior knowledge.
    const engine2 = new ApplicationDiscoveryEngine({ session: mockSession, maxSteps: 2, maxLinksPerStep: 2, knowledgeDir });
    const result2 = await engine2.discover();
    assert.ok(result2.reusedKnowledge, "Prior knowledge was reused.");
    assert.equal(result2.reusedKnowledge.origin, "http://fixture.local");
    assert.equal(result2.reusedKnowledge.stale, true);
  } finally {
    await rm(knowledgeDir, { recursive: true, force: true }).catch(() => {});
  }
});
