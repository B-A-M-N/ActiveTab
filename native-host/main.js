#!/usr/bin/env node
import { createConnection } from "node:net";
import { brokerSocketPath } from "../src/extension/paths.js";
import { EXTENSION_ORIGIN } from "../src/extension/broker.js";
import { encodeNativeMessage, NativeMessageDecoder, MAX_EXTENSION_TO_HOST_MESSAGE_BYTES, MAX_HOST_TO_EXTENSION_MESSAGE_BYTES } from "./protocol.js";

const origin = process.argv[2];
if (origin !== EXTENSION_ORIGIN) {
  process.stderr.write("ActiveTab Native Messaging rejected an unauthorized extension origin.\n");
  process.exit(2);
}

const socket = createConnection(brokerSocketPath());
const fromChrome = new NativeMessageDecoder({ maxMessageBytes: MAX_EXTENSION_TO_HOST_MESSAGE_BYTES });
const fromBroker = new NativeMessageDecoder({ maxMessageBytes: MAX_HOST_TO_EXTENSION_MESSAGE_BYTES });
let ended = false;
function fail(error) {
  if (ended) return;
  ended = true;
  process.stderr.write(`ActiveTab Native Messaging host: ${String(error?.message ?? error).slice(0, 300)}\n`);
  socket.destroy();
  process.exitCode = 1;
}

socket.once("connect", () => {
  process.stdin.on("data", chunk => {
    try {
      for (const message of fromChrome.push(chunk)) socket.write(encodeNativeMessage(message, { maxMessageBytes: MAX_EXTENSION_TO_HOST_MESSAGE_BYTES }));
    } catch (error) { fail(error); }
  });
  process.stdin.once("end", () => {
    try { fromChrome.finish(); } catch (error) { fail(error); }
    socket.end();
  });
  process.stdin.once("error", fail);
  socket.on("data", chunk => {
    try {
      for (const message of fromBroker.push(chunk)) process.stdout.write(encodeNativeMessage(message, { maxMessageBytes: MAX_HOST_TO_EXTENSION_MESSAGE_BYTES }));
    } catch (error) { fail(error); }
  });
});
socket.once("error", fail);
socket.once("close", () => { if (!ended) { ended = true; process.stdin.pause(); } });
