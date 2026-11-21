import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createApiServer } from "../src/api/local-server.js";

const [mode, taskStoreDir, tokenFile, effectFile] = process.argv.slice(2);
if (!new Set(["crash-after-dispatch", "serve"]).has(mode) || !taskStoreDir || !tokenFile || !effectFile) {
  process.stderr.write("usage: apiPeerWorker.js <crash-after-dispatch|serve> <taskStoreDir> <tokenFile> <effectFile>\n");
  process.exitCode = 2;
} else {
  process.env.ACTIVETAB_REMOTE_TOKEN_FILE = tokenFile;
  const api = createApiServer({
    port: 0,
    taskStoreDir,
    navigationRunner: {
      async run(goal, { taskId }) {
        await appendFile(effectFile, `${JSON.stringify({ taskId, goal })}\n`, { mode: 0o600 });
        process.stdout.write(`${JSON.stringify({ event: "dispatched", taskId })}\n`);
        if (mode === "crash-after-dispatch") await new Promise(() => {});
        return { status: "succeeded", output: { status: "succeeded", goal }, usage: { actions: 1 } };
      }
    }
  });

  try {
    const { url } = await api.start();
    process.stdout.write(`${JSON.stringify({ event: "listening", url })}\n`);
    if (mode === "crash-after-dispatch") await new Promise(() => {});
    else {
      const lines = createInterface({ input: process.stdin });
      await new Promise(resolve => lines.on("line", line => {
        if (line === "stop") resolve();
      }));
      lines.close();
      await api.stop();
      process.stdout.write(`${JSON.stringify({ event: "stopped" })}\n`);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ event: "startup-rejected", code: error?.code ?? null, message: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
