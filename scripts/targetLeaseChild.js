import { RunStateStore } from "../src/testing/runState.js";

const [directory, targetId, runId] = process.argv.slice(2);
const store = new RunStateStore(directory);
try {
  await store.init();
  const lease = await store.acquireTargetLease(targetId, runId);
  await lease.release();
} catch (error) {
  if (error.code === "RUN_TARGET_LEASE_HELD") process.exitCode = 23;
  else {
    process.stderr.write(String(error?.stack ?? error));
    process.exitCode = 1;
  }
} finally {
  store.close();
}
