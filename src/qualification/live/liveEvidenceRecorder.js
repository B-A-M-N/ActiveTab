import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";

export async function writeLiveQualificationReceipt(result, { path } = {}) {
  if (typeof path !== "string" || !path) throw new Error("A live qualification receipt path is required.");
  const destination = resolve(path);
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) {
    throw new Error("Live qualification receipt directory must be a real, owner-owned directory.");
  }
  await chmod(directory, 0o700);
  const contents = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > 128 * 1024) throw new Error("Live qualification receipt exceeds 128 KiB.");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  return destination;
}

export function liveQualificationReceiptPath(directory, runId) {
  if (typeof runId !== "string" || !/^[0-9a-f-]{36}$/u.test(runId)) throw new Error("Live qualification run ID is invalid.");
  return join(resolve(directory), `${runId}.json`);
}
