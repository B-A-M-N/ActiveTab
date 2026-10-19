import { spawnSync } from "node:child_process";

const result = spawnSync("bash", ["scripts/test-headed.sh", ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
