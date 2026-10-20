import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { KnowledgeStore } from "../src/discovery/knowledgeStore.js";

function capabilityMap(origin, revision = 1) {
  return {
    origin,
    applicationId: origin,
    revision,
    observationCount: revision,
    pages: [],
    controls: [],
    networkOperations: []
  };
}

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

test("knowledgeStore requires an absolute configured root and rejects symlink roots", async () => {
  assert.throws(() => new KnowledgeStore("relative-knowledge"), /absolute canonical path/u);
  const parent = await mkdtemp(join(tmpdir(), "activetab-knowledge-symlink-"));
  const outside = join(parent, "outside");
  const linked = join(parent, "linked");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, linked);
  try {
    const store = new KnowledgeStore(linked);
    await assert.rejects(store.save(capabilityMap("http://symlink.test")), /symlink/u);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("knowledgeStore refuses a root with non-owner permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-permissions-"));
  try {
    await chmod(dir, 0o755);
    const store = new KnowledgeStore(dir);
    await assert.rejects(store.save(capabilityMap("http://permissions.test")), /owner-only/u);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledgeStore refuses non-private or symlinked entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-entry-security-"));
  const outsideFile = join(dir, "outside.json");
  try {
    const store = new KnowledgeStore(dir);
    const map = capabilityMap("http://entry-security.test");
    await store.save(map);
    const key = createHash("sha256")
      .update(JSON.stringify([map.origin, null, null]))
      .digest("hex")
      .slice(0, 32);
    const entryPath = join(dir, `${key}.json`);
    await chmod(entryPath, 0o644);
    await assert.rejects(store.load(map.origin), /owner-only/u);
    await chmod(entryPath, 0o600);

    await writeFile(outsideFile, "keep", { mode: 0o600 });
    await unlink(entryPath);
    await symlink(outsideFile, entryPath);
    await assert.rejects(store.load(map.origin), /ELOOP|symbolic|symlink/iu);
    assert.equal(await readFile(outsideFile, "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledgeStore concurrent saves stay bounded and preserve valid records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-concurrent-"));
  try {
    const store = new KnowledgeStore(dir);
    await Promise.all(Array.from({ length: 72 }, (_, index) =>
      store.save(capabilityMap(`http://concurrent-${index}.test`, index + 1))));
    const entries = await store.list();
    assert.equal(entries.length, 64);
    for (const entry of entries) {
      const loaded = await store.load(entry.origin);
      assert.ok(loaded);
      assert.equal(loaded.origin, entry.origin);
    }
    const files = await readdir(dir);
    assert.equal(files.filter(file => /^[a-f0-9]{32}\.json$/u.test(file)).length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledgeStore ignores interrupted temporary writes and keeps atomic entries readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-interrupted-"));
  try {
    const store = new KnowledgeStore(dir);
    const original = capabilityMap("http://interrupted.test", 1);
    await store.save(original);
    const key = createHash("sha256")
      .update(JSON.stringify([original.origin, null, null]))
      .digest("hex")
      .slice(0, 32);
    const interruptedPath = join(dir, `.${key}.interrupted.tmp`);
    await writeFile(interruptedPath, "{partial", { mode: 0o600 });

    await store.save(capabilityMap(original.origin, 2));
    assert.equal((await store.load(original.origin)).revision, 2);
    assert.equal(await readFile(interruptedPath, "utf8"), "{partial");
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("knowledgeStore retention and clear preserve unrelated JSON files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-knowledge-unrelated-"));
  const unrelatedPath = join(dir, "operator-notes.json");
  const unrelatedContents = JSON.stringify({ keep: true });
  try {
    const store = new KnowledgeStore(dir);
    await writeFile(unrelatedPath, unrelatedContents, { mode: 0o600 });
    await Promise.all(Array.from({ length: 66 }, (_, index) =>
      store.save(capabilityMap(`http://retention-${index}.test`, index + 1))));
    assert.equal((await store.list()).length, 64);
    assert.equal(await readFile(unrelatedPath, "utf8"), unrelatedContents);

    await store.clear();
    assert.deepEqual(await readdir(dir), ["operator-notes.json"]);
    assert.equal(await readFile(unrelatedPath, "utf8"), unrelatedContents);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
