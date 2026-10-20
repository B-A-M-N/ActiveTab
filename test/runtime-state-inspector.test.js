import test from "node:test";
import assert from "node:assert/strict";
import { BrowserObserver } from "../src/observe/observer.js";
import { jsonByteLength } from "../src/observe/evidenceSizing.js";

test("runtime state inspection stays read-only and retains bounded sensitive values", async () => {
  const commands = [];
  const longValue = "x".repeat(16_385);
  const session = {
    target: { id: "runtime-target" },
    documentGeneration: 4,
    client: {
      async send(method, params) {
        commands.push({ method, params });
        if (method === "Runtime.evaluate") return { result: { objectId: "global-object" } };
        if (method === "Runtime.callFunctionOn") return { result: { type: "string", value: longValue } };
        return {};
      }
    }
  };
  const observer = new BrowserObserver(session);
  const evidence = {
    id: "runtime-evidence",
    documentGeneration: session.documentGeneration,
    runtimeStateRecords: [],
    runtimeStateBytes: 0
  };
  const serializedByteLength = jsonByteLength(evidence);
  const stored = { evidence, byteLength: serializedByteLength, serializedByteLength, lookupIndexBytes: 0 };
  observer.evidenceStore.retain(evidence.id, stored);

  const result = await observer.inspectRuntimeState(evidence.id, {
    path: ["application", "publicLabel"],
    includeSensitiveValues: true
  });

  assert.equal(result.status, "available");
  assert.equal(result.result.selected.valueRedacted, true);
  assert.equal(result.result.selected.valueLength, longValue.length);
  assert.equal(Object.hasOwn(result.result.selected, "value"), false);
  assert.equal(result.retained, true);
  assert.equal(commands[0].method, "Runtime.evaluate");
  assert.equal(commands[1].method, "Runtime.callFunctionOn");
  assert.equal(commands[1].params.throwOnSideEffect, true);
  assert.equal(commands[1].params.userGesture, false);
  assert.equal(commands.at(-1).method, "Runtime.releaseObjectGroup");
  assert.equal(observer.evidenceBytes, stored.byteLength);
});
