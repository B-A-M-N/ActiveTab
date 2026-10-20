export function jsonByteLength(root) {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null) { bytes += 4; continue; }
    if (typeof value === "string") { bytes += Buffer.byteLength(JSON.stringify(value)); continue; }
    if (typeof value === "number") { bytes += Buffer.byteLength(Number.isFinite(value) ? String(value) : "null"); continue; }
    if (typeof value === "boolean") { bytes += value ? 4 : 5; continue; }
    if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index] ?? null);
      continue;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol");
      bytes += 2 + Math.max(0, entries.length - 1);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, item] = entries[index];
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push(item);
      }
    }
  }
  return bytes;
}
