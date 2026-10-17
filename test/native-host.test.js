import assert from "node:assert/strict";
import test from "node:test";
import { endianness } from "node:os";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/protocol.js";

function header(length) {
  const value = Buffer.alloc(4);
  if (endianness() === "LE") value.writeUInt32LE(length, 0);
  else value.writeUInt32BE(length, 0);
  return value;
}

test("Native Messaging decoder handles fragmented headers and payloads", () => {
  const frame = encodeNativeMessage({ type: "attach", tabId: 17 });
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(frame.subarray(7)), [{ type: "attach", tabId: 17 }]);
  decoder.finish();
});

test("Native Messaging decoder emits multiple complete messages from one chunk", () => {
  const first = encodeNativeMessage({ id: 1, method: "Page.enable" });
  const second = encodeNativeMessage({ id: 2, method: "DOM.enable" });
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([first, second])), [
    { id: 1, method: "Page.enable" },
    { id: 2, method: "DOM.enable" }
  ]);
  decoder.finish();
});

test("Native Messaging decoder rejects oversized frame lengths before payload allocation", () => {
  const decoder = new NativeMessageDecoder({ maxMessageBytes: 5 });
  assert.throws(() => decoder.push(header(6)), /configured message limit/);
  assert.throws(() => decoder.push(Buffer.alloc(1)), /cannot continue/);
});

test("Native Messaging decoder rejects empty, invalid UTF-8, and invalid JSON frames", () => {
  assert.throws(() => new NativeMessageDecoder().push(header(0)), /cannot be empty/);
  const badUtf8 = Buffer.from([0xc3, 0x28]);
  assert.throws(() => new NativeMessageDecoder().push(Buffer.concat([header(badUtf8.length), badUtf8])), /invalid UTF-8 JSON/);
  const badJson = Buffer.from("{", "utf8");
  assert.throws(() => new NativeMessageDecoder().push(Buffer.concat([header(badJson.length), badJson])), /invalid UTF-8 JSON/);
});

test("Native Messaging decoder reports truncated streams at EOF", () => {
  const frame = encodeNativeMessage({ type: "detach" });
  const decoder = new NativeMessageDecoder();
  decoder.push(frame.subarray(0, frame.length - 1));
  assert.throws(() => decoder.finish(), /truncated frame/);
});

test("Native Messaging encoder enforces the host-to-extension message limit", () => {
  assert.throws(() => encodeNativeMessage({ value: "123456" }, { maxMessageBytes: 5 }), /configured message limit/);
  assert.equal(new NativeMessageDecoder({ maxMessageBytes: 1024 }).push(encodeNativeMessage({ ok: true })).length, 1);
});
