import { endianness } from "node:os";

export const MAX_HOST_TO_EXTENSION_MESSAGE_BYTES = 1 * 1024 * 1024;
export const MAX_EXTENSION_TO_HOST_MESSAGE_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 4;
const LITTLE_ENDIAN = endianness() === "LE";

export function encodeNativeMessage(value, { maxMessageBytes = MAX_HOST_TO_EXTENSION_MESSAGE_BYTES } = {}) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new TypeError(`Native Messaging payload is not JSON serializable: ${error.message}`); }
  if (typeof serialized !== "string") throw new TypeError("Native Messaging payload must serialize to JSON.");
  const payload = Buffer.from(serialized, "utf8");
  if (payload.length > maxMessageBytes) throw new RangeError("Native Messaging payload exceeds the configured message limit.");
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  if (LITTLE_ENDIAN) frame.writeUInt32LE(payload.length, 0);
  else frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class NativeMessageDecoder {
  constructor({ maxMessageBytes = MAX_EXTENSION_TO_HOST_MESSAGE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 0xffffffff) {
      throw new RangeError("Native Messaging message limit must be a positive 32-bit byte length.");
    }
    this.maxMessageBytes = maxMessageBytes;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.expectedBytes = null;
    this.closed = false;
    this.failed = false;
  }

  push(input) {
    if (this.closed) throw new Error("Native Messaging decoder is closed.");
    if (this.failed) throw new Error("Native Messaging decoder cannot continue after a protocol error.");
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const messages = [];
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const needed = this.expectedBytes === null
          ? HEADER_BYTES - this.bufferedBytes
          : this.expectedBytes - this.bufferedBytes;
        const count = Math.min(needed, bytes.length - offset);
        this.chunks.push(bytes.subarray(offset, offset + count));
        this.bufferedBytes += count;
        offset += count;

        if (this.expectedBytes === null && this.bufferedBytes === HEADER_BYTES) {
          const header = this.#consume(HEADER_BYTES);
          const length = LITTLE_ENDIAN ? header.readUInt32LE(0) : header.readUInt32BE(0);
          if (length === 0) throw new Error("Native Messaging frame cannot be empty.");
          if (length > this.maxMessageBytes) throw new RangeError("Native Messaging frame exceeds the configured message limit.");
          this.expectedBytes = length;
        }

        if (this.expectedBytes !== null && this.bufferedBytes === this.expectedBytes) {
          const payload = this.#consume(this.expectedBytes);
          this.expectedBytes = null;
          let parsed;
          try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); }
          catch (error) { throw new Error(`Native Messaging frame contains invalid UTF-8 JSON: ${error.message}`); }
          messages.push(parsed);
        }
      }
      return messages;
    } catch (error) {
      this.failed = true;
      this.chunks = [];
      this.bufferedBytes = 0;
      throw error;
    }
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.failed) throw new Error("Native Messaging stream ended after a protocol error.");
    if (this.expectedBytes !== null || this.bufferedBytes !== 0) {
      this.failed = true;
      throw new Error("Native Messaging stream ended with a truncated frame.");
    }
  }

  #consume(count) {
    if (count > this.bufferedBytes) throw new Error("Native Messaging decoder internal length mismatch.");
    let output;
    if (this.chunks[0].length >= count) {
      output = this.chunks[0].subarray(0, count);
      if (this.chunks[0].length === count) this.chunks.shift();
      else this.chunks[0] = this.chunks[0].subarray(count);
    } else {
      output = Buffer.allocUnsafe(count);
      let copied = 0;
      while (copied < count) {
        const chunk = this.chunks[0];
        const take = Math.min(chunk.length, count - copied);
        chunk.copy(output, copied, 0, take);
        copied += take;
        if (take === chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(take);
      }
    }
    this.bufferedBytes -= count;
    return output;
  }
}
