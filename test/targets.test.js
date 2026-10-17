import test from "node:test";
import assert from "node:assert/strict";
import { validateLoopbackEndpoint, resolveAuthorizedTarget } from "../src/browser/targets.js";

test("CDP endpoint validation rejects non-loopback and credential-bearing endpoints", () => {
  assert.equal(validateLoopbackEndpoint("http://127.0.0.1:9222").hostname, "127.0.0.1");
  assert.throws(() => validateLoopbackEndpoint("http://192.168.1.4:9222"), /loopback/);
  assert.throws(() => validateLoopbackEndpoint("http://user:pass@localhost:9222"), /loopback/);
  assert.throws(() => validateLoopbackEndpoint("https://localhost:9222"), /loopback/);
});

test("target control requires the explicit selected target id", async () => {
  await assert.rejects(resolveAuthorizedTarget("http://127.0.0.1:1", "target-a", undefined), /authorization/);
  await assert.rejects(resolveAuthorizedTarget("http://127.0.0.1:1", "target-a", "target-b"), /authorization/);
});
