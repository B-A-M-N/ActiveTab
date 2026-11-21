import { createApiServer } from "../src/api/local-server.js";

const [mode, taskStoreDir] = process.argv.slice(2);
if (!new Set(["hold", "probe"]).has(mode) || !taskStoreDir) {
  process.stderr.write("usage: apiWriterWorker.js <hold|probe> <taskStoreDir>\n");
  process.exitCode = 2;
} else {
  const api = createApiServer({
    port: 0,
    taskStoreDir,
    apiToken: "writer-test-api-token",
    navigationRunner: { async run() { return { status: "succeeded", output: { status: "succeeded" } }; } }
  });
  try {
    const { url } = await api.start();
    process.stdout.write(`${JSON.stringify({ event: "listening", url })}\n`);
    if (mode === "hold") await new Promise(() => {});
    else await api.stop();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ event: "startup-rejected", code: error?.code ?? null, message: String(error?.message ?? error) })}\n`);
    process.exitCode = error?.code === "TASK_STORE_WRITER_HELD" ? 23 : 1;
  }
}
