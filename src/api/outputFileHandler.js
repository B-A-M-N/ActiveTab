import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_OUTPUT_FILE_BYTES = 5 * 1024 * 1024;
const OUTPUT_EXTENSIONS = new Set(["json", "md", "csv", "xml"]);
const MIME_TYPES = Object.freeze({
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
  xml: "application/xml"
});

/** Compose bounded output-file reads from the server-owned task store. */
export function createOutputFileHandler({ sendError } = {}) {
  return async function handleOutputFile(res, { store, path }) {
    const parts = path.split("/");
    const taskId = parts[2];
    const filename = parts[3];
    const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
    if (!/^[0-9a-f-]{36}$/.test(taskId) || !OUTPUT_EXTENSIONS.has(ext) || filename.includes("..")) {
      sendError(res, 403, 99403, "Forbidden");
      return;
    }
    let filePath;
    try {
      const outputDirectory = resolve(join(store.baseDir, "..", "output"));
      filePath = resolve(outputDirectory, taskId, filename);
      if (!filePath.startsWith(outputDirectory + "/")) throw new Error("path escape");
    } catch {
      sendError(res, 403, 99403, "Forbidden");
      return;
    }
    try {
      const file = await open(filePath, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_OUTPUT_FILE_BYTES) {
          sendError(res, 404, 99404, "Output file not found.");
          return;
        }
        const content = await file.readFile("utf8");
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext], "Content-Length": Buffer.byteLength(content) });
        res.end(content);
      } finally { await file.close(); }
    } catch {
      sendError(res, 404, 99404, `Output file not found: ${filename}`);
    }
  };
}
