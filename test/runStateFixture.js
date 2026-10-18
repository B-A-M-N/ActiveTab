import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStateStore } from "../src/testing/runState.js";

export async function createRunStateFixture(prefix = "activetab-run-state-test-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const store = new RunStateStore(directory);
  await store.init();
  return {
    directory,
    store,
    async cleanup() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}
