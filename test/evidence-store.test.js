import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceStore } from "../src/observe/evidenceStore.js";
import { jsonByteLength } from "../src/observe/evidenceSizing.js";

function evidenceEntry(id, { runtimeStateRecords = [], runtimeStateBytes = 0 } = {}) {
  const evidence = { id, runtimeStateRecords, runtimeStateBytes };
  const serializedByteLength = jsonByteLength(evidence);
  return { evidence, byteLength: serializedByteLength, serializedByteLength, lookupIndexBytes: 0 };
}

test("evidence retention enforces entry and byte bounds and reports evictions", () => {
  const evicted = [];
  const store = new EvidenceStore({ limit: 2, maxBytes: 1024 * 1024, onEvict: id => evicted.push(id) });
  assert.equal(store.retain("first", { ...evidenceEntry("first"), byteLength: 700_000 }), true);
  assert.equal(store.retain("second", { ...evidenceEntry("second"), byteLength: 400_000 }), true);

  assert.equal(store.get("first"), null);
  assert.ok(store.get("second"));
  assert.deepEqual(evicted, ["first"]);
  assert.equal(store.bytes, 400_000);
  assert.equal(store.peakBytes, 700_000);

  assert.equal(store.retain("third", { ...evidenceEntry("third"), byteLength: 400_000 }), true);
  assert.equal(store.retain("fourth", { ...evidenceEntry("fourth"), byteLength: 100_000 }), true);
  assert.equal(store.get("second"), null);
  assert.ok(store.get("third"));
  assert.ok(store.get("fourth"));
  assert.equal(store.size, 2);
  assert.equal(store.bytes, 500_000);
  assert.deepEqual(evicted, ["first", "second"]);
});

test("runtime-record retention updates the canonical byte owner and refuses evicted evidence", () => {
  const store = new EvidenceStore({ limit: 1 });
  const entry = evidenceEntry("evidence");
  assert.equal(store.retain("evidence", entry), true);
  assert.throws(() => store.retain("evidence", entry), /already retained/u);

  for (let index = 0; index < 9; index++) {
    assert.equal(store.appendRuntimeRecord("evidence", { id: `record-${index}`, detail: "x" }), true);
  }
  assert.equal(entry.evidence.runtimeStateRecords.length, 8);
  assert.equal(entry.evidence.runtimeStateRecords[0].id, "record-1");
  assert.equal(entry.byteLength, jsonByteLength(entry.evidence));
  assert.equal(store.bytes, entry.byteLength);
  assert.equal(store.peakBytes, entry.byteLength);

  const next = evidenceEntry("next");
  assert.equal(store.retain("next", next), true);
  const bytesBefore = store.bytes;
  assert.equal(store.appendRuntimeRecord("evidence", { id: "stale", detail: "x" }), false);
  assert.equal(store.bytes, bytesBefore);
  assert.equal(store.get("evidence"), null);
});
