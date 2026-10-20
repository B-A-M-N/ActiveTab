import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { launchOwnedChrome } from "../src/browser/ownedChrome.js";
import { queryRetainedControls } from "../src/observe/targetedControlLookup.js";

function retainedFixture({ nodeCount = 3, children = new Map(), candidates = [] } = {}) {
  const snapshot = {};
  const sourceDocument = { nodes: { nodeName: Array.from({ length: nodeCount }, () => 1), parentIndex: Array.from({ length: nodeCount }, (_, index) => index ? 0 : -1) } };
  const document = {
    snapshot,
    documentIndex: 0,
    frameId: "root-frame",
    sourceDocument,
    children,
    backendNodeIndexes: new Map([[101, 0]])
  };
  const evidence = {
    id: "obs-1",
    targetId: "tab-1",
    documentGeneration: 7,
    domSnapshot: snapshot,
    outOfProcessFrames: [],
    activity: { totalDomMutations: 0 },
    semanticPage: {
      evidence: { observationId: "obs-1" },
      coverage: { closedShadowRoots: "complete" }
    }
  };
  const session = {
    attached: true,
    targetLifecycle: "attached",
    target: { id: "tab-1" },
    documentGeneration: 7,
    activity: { totalDomMutations: 0 }
  };
  const lookupIndex = {
    available: true,
    candidateCoverage: "complete",
    candidates,
    frames: [{ frameTargetId: null, snapshot, documents: [document] }]
  };
  return { evidence, session, lookupIndex };
}

test("retained control lookup is read-only and returns bounded matches from the exact snapshot index", () => {
  const candidates = [
    { identity: "tab-1:root:root-frame:201:7", targetId: "tab-1", documentGeneration: 7, frameTargetId: null, frameId: "root-frame", documentIndex: 0, nodeIndex: 1, backendNodeId: 201, role: "button", tag: "button", name: "Save", contextName: "Profile", visible: true, disabled: false },
    { identity: "tab-1:root:root-frame:202:7", targetId: "tab-1", documentGeneration: 7, frameTargetId: null, frameId: "root-frame", documentIndex: 0, nodeIndex: 2, backendNodeId: 202, role: "button", tag: "button", name: "Save", contextName: "Billing", visible: true, disabled: false }
  ];
  const { evidence, session, lookupIndex } = retainedFixture({ nodeCount: 3, children: new Map([[0, [1, 2]]]), candidates });
  const result = queryRetainedControls({ evidence, session, lookupIndex, input: { role: "button", accessibleName: "Save" } });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.visitedNodeCount, 3);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].identityEvidence, "retained_candidate_index");
  assert.equal(result.matches[0].actionAuthorized, false);
  assert.equal(result.actionAuthorized, false);
});

test("retained traversal detects cycles and enforces the node and deadline budgets", () => {
  const cyclic = retainedFixture({ nodeCount: 2, children: new Map([[0, [1]], [1, [0]]]) });
  const cycleResult = queryRetainedControls({ ...cyclic, input: { targetTokens: ["save"] } });
  assert.equal(cycleResult.stopReason, "complete", "a child cycle terminates without revisiting nodes");
  assert.equal(cycleResult.visitedNodeCount, 2);

  const manyChildren = retainedFixture({ nodeCount: 1_000, children: new Map([[0, Array.from({ length: 999 }, (_, index) => index + 1)]]) });
  const bounded = queryRetainedControls({ ...manyChildren, input: { targetTokens: ["save"], maxNodes: 50 } });
  assert.equal(bounded.stopReason, "node_budget");
  assert.equal(bounded.visitedNodeCount, 50);
  assert.equal(bounded.status, "incomplete");

  let clockTick = 0;
  const timed = queryRetainedControls({
    ...manyChildren,
    input: { targetTokens: ["save"], timeoutMs: 50 },
    now: () => clockTick++ * 50
  });
  assert.equal(timed.stopReason, "deadline");
  assert.equal(timed.visitedNodeCount, 0);
});

test("detached, changed, or unavailable evidence cannot produce a retained match", () => {
  const fixture = retainedFixture();
  const detached = queryRetainedControls({ ...fixture, session: { ...fixture.session, attached: false }, input: { targetTokens: ["save"] } });
  assert.equal(detached.status, "unavailable");
  assert.equal(detached.actionAuthorized, false);

  const changed = queryRetainedControls({ ...fixture, session: { ...fixture.session, documentGeneration: 8 }, input: { targetTokens: ["save"] } });
  assert.equal(changed.status, "stale");

  const noSnapshot = queryRetainedControls({ ...fixture, lookupIndex: null, input: { targetTokens: ["save"] } });
  assert.equal(noSnapshot.stopReason, "snapshot_unavailable");
  assert.equal(noSnapshot.truncated, true);
});

const chromeExecutable = process.env.CHROME_PATH ?? process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

test("retained control lookup finds omitted controls without CDP traversal and preserves scope and frame identity", {
  skip: !existsSync(chromeExecutable),
  timeout: 120_000
}, async () => {
  const controls = Array.from({ length: 600 }, (_, index) => `<button aria-label="Control ${index}"></button>`).join("");
  const pageServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (request.url === "/small") {
      response.end('<!doctype html><title>Small fixture</title><main><button aria-label="Small Submit"></button></main>');
      return;
    }
    response.end(`<!doctype html><title>Retained lookup fixture</title><main>
      <section aria-label="Target scope"><form aria-label="Scope Form"><button aria-label="Scoped Submit"></button></form></section>
      <button aria-label="Duplicate"></button><button aria-label="Duplicate"></button>
      <button disabled aria-label="Disabled Action"></button>
      ${Array.from({ length: 60 }, () => '<button aria-label="Repeated"></button>').join("")}
      ${controls}<iframe title="Cross origin frame" src="http://localhost:${frameServer.address()?.port ?? 0}/frame"></iframe>
    </main>`);
  });
  const frameServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end('<!doctype html><title>Frame fixture</title><button aria-label="Frame Save"></button>');
  });
  pageServer.listen(0, "127.0.0.1");
  frameServer.listen(0, "localhost");
  await Promise.all([once(pageServer, "listening"), once(frameServer, "listening")]);
  const initialUrl = `http://127.0.0.1:${pageServer.address().port}/`;
  const profileDir = await mkdtemp(join(tmpdir(), "activetab-targeted-control-lookup-"));
  let owned = null;

  try {
    owned = await launchOwnedChrome({ initialUrl, headed: process.env.ACTIVETAB_HEADLESS !== "1", userDataDir: profileDir, preserveProfile: false });
    const session = owned.session;
    const observation = await session.observe({ profile: "interaction", candidateLimit: 200 });
    assert.equal(observation.candidateCoverage.pageCoverage, "partial", "the fixture exceeds the normal candidate projection limit");

    const omitted = await session.queryAccessibility(observation.evidenceId, {
      role: "button", accessibleName: "Control 250", exact: true, timeoutMs: 2_000
    });
    assert.equal(omitted.matches.length, 1,
      `the retained lookup sees a present control omitted from the response projection (${JSON.stringify({ status: omitted.status, stopReason: omitted.stopReason, visitedNodeCount: omitted.visitedNodeCount })})`);
    assert.equal(omitted.matches[0].name, "Control 250");
    assert.equal(omitted.matches[0].identityEvidence, "retained_candidate_index");
    assert.equal(omitted.actionAuthorized, false);
    assert.ok(omitted.visitedNodeCount <= 500);
    assert.equal(omitted.stopReason, "node_budget", "the bounded page scan cannot claim uniqueness after reaching its node budget");

    const duplicates = await session.queryAccessibility(observation.evidenceId, {
      role: "button", accessibleName: "Duplicate", exact: true
    });
    assert.equal(duplicates.matches.length, 2);
    assert.equal(duplicates.status, "incomplete", "unobserved closed-shadow coverage remains explicit");

    const limited = await session.queryAccessibility(observation.evidenceId, {
      role: "button", accessibleName: "Repeated", exact: true, maxResults: 10
    });
    assert.equal(limited.matches.length, 10);
    assert.equal(limited.stopReason, "match_limit");
    assert.equal(limited.truncated, true);

    const nodeLimited = await session.queryAccessibility(observation.evidenceId, {
      role: "button", accessibleName: "Control 599", exact: true, maxNodes: 100
    });
    assert.equal(nodeLimited.stopReason, "node_budget");
    assert.equal(nodeLimited.visitedNodeCount, 100);

    const form = observation.semanticPage.forms.find(item => item.ref && item.evidenceRef);
    assert.ok(form, "the observed form carries an exact backend scope reference");
    const scoped = await session.queryAccessibility(observation.evidenceId, {
      role: "button", accessibleName: "Scoped Submit", exact: true, scopeRef: form.ref
    });
    assert.equal(scoped.matches.length, 1);
    assert.equal(scoped.matches[0].name, "Scoped Submit");

    const frameDeadline = Date.now() + 10_000;
    while (Date.now() < frameDeadline && ![...session.frameSessions.values()].some(frame => frame.status === "ready")) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const framedObservation = await session.observe({ profile: "interaction", candidateLimit: 200 });
    const frameTargetId = [...session.frameSessions.values()].find(frame => frame.status === "ready")?.targetId;
    assert.ok(frameTargetId, "the fixture's cross-origin frame is an attached OOPIF target");
    const frameMatch = await session.queryAccessibility(framedObservation.evidenceId, {
      role: "button", accessibleName: "Frame Save", exact: true, frameTargetId
    });
    assert.equal(frameMatch.matches.length, 1);
    assert.equal(frameMatch.matches[0].frameTargetId, frameTargetId);

    await session.client.send("Page.navigate", { url: `${new URL(initialUrl).origin}/small` });
    const staleDeadline = Date.now() + 10_000;
    while (Date.now() < staleDeadline && session.documentGeneration === framedObservation.documentGeneration) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const stale = await session.queryAccessibility(framedObservation.evidenceId, {
      role: "button", accessibleName: "Control 250", exact: true
    });
    assert.equal(stale.status, "stale");

    const invalid = await session.queryAccessibility(observation.evidenceId, {
      targetTokens: ["Save"], maxNodes: 501
    });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.actionAuthorized, false);
  } finally {
    await owned?.close();
    await Promise.all([
      new Promise(resolve => pageServer.close(resolve)),
      new Promise(resolve => frameServer.close(resolve))
    ]);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
