import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("../test-support/apiWriterWorker.js", import.meta.url));

test("one API process owns a task directory and SQLite releases ownership after process death", async t => {
  const directory = await mkdtemp(join(tmpdir(), "activetab-api-writer-"));
  const taskStoreDir = join(directory, "tasks");
  let owner;
  t.after(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await once(owner, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  });

  owner = spawn(process.execPath, [workerPath, "hold", taskStoreDir], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  owner.stderr.setEncoding("utf8");
  let stderr = "";
  owner.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const lines = createInterface({ input: owner.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`API writer did not become ready: ${stderr}`)), 10_000);
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.event === "listening") {
          clearTimeout(timeout);
          resolve(message);
        }
      } catch { /* The API logs its URL separately; wait for the worker event. */ }
    });
    owner.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`API writer exited before readiness (${code}): ${stderr}`));
    });
  });
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:/);

  const competing = spawnSync(process.execPath, [workerPath, "probe", taskStoreDir], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(competing.status, 23, competing.stderr || competing.stdout);
  const refusal = JSON.parse(competing.stdout.trim().split("\n").at(-1));
  assert.equal(refusal.event, "startup-rejected");
  assert.equal(refusal.code, "TASK_STORE_WRITER_HELD");

  const directoryMode = (await stat(taskStoreDir)).mode & 0o777;
  const lockMode = (await stat(join(taskStoreDir, ".api-writer-lock.sqlite"))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(lockMode, 0o600);

  owner.kill("SIGKILL");
  assert.equal((await once(owner, "exit"))[1], "SIGKILL");
  owner = null;

  const recovered = spawnSync(process.execPath, [workerPath, "probe", taskStoreDir], {
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  const recovery = JSON.parse(recovered.stdout.trim().split("\n").at(-1));
  assert.equal(recovery.event, "listening");
});
