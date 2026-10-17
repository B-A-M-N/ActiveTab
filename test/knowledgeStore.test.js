import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/discovery/knowledgeStore.js";

test("knowledgeStore saves and loads capability maps by origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-"));
  try {
    const store = new KnowledgeStore(dir);
    const map = {
      origin: "http://fixture.test",
      applicationId: "http://fixture.test",
      revision: 3,
      observationCount: 5,
      pages: [{ url: "http://fixture.test/", title: "Home" }],
      controls: [{ key: "link:Home", name: "Home", pages: ["http://fixture.test/"] }],
      networkOperations: []
    };
    const saved = await store.save(map);
    assert.equal(saved.origin, "http://fixture.test");
    const loaded = await store.load("http://fixture.test");
    assert.ok(loaded);
    assert.equal(loaded.revision, 3);
    assert.equal(loaded.pages[0].title, "Home");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("knowledgeStore returns null for unknown origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-"));
  try {
    const store = new KnowledgeStore(dir);
    assert.equal(await store.load("http://unknown.test"), null);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("knowledgeStore does not map one origin's data to another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-"));
  try {
    const store = new KnowledgeStore(dir);
    await store.save({ origin: "http://a.test", revision: 1, observationCount: 1, pages: [], controls: [], networkOperations: [] });
    await store.save({ origin: "http://b.test", revision: 2, observationCount: 2, pages: [], controls: [], networkOperations: [] });
    const a = await store.load("http://a.test");
    const b = await store.load("http://b.test");
    assert.equal(a.revision, 1);
    assert.equal(b.revision, 2);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("knowledgeStore list reports origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-"));
  try {
    const store = new KnowledgeStore(dir);
    await store.save({ origin: "http://x.test", revision: 1, observationCount: 1, pages: [], controls: [], networkOperations: [] });
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].origin, "http://x.test");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
