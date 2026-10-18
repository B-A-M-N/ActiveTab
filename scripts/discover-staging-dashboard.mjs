#!/usr/bin/env node
/**
 * Capture a read-only inventory of the main FreeInference staging dashboard.
 * Requires one exact, already-authorized browser target on /dashboard.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { ProfileLoader, loadEnvironmentBinding } from "../src/testing/profiles.js";
import { discoverStagingDashboard } from "../src/testing/stagingDashboardDiscovery.js";
import { RunStateStore, withTargetExecutionLease } from "../src/testing/runState.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileId = process.argv.slice(2).find(value => value.startsWith("--profile="))?.slice(10) ?? "freeinference-staging";

async function main() {
  const profilesDir = join(root, "profiles");
  const loader = new ProfileLoader(profilesDir);
  const profile = await loader.loadProfile(profileId);
  if (!profile) throw new Error(`No profile named '${profileId}'.`);
  const environment = await loadEnvironmentBinding(profilesDir, profileId);
  const contract = profile.dashboard_discovery;
  if (!contract) throw new Error("The selected profile has no account dashboard discovery contract.");

  const targetId = process.env.ACTIVETAB_AUTHORIZED_TARGET_ID;
  if (!targetId) throw new Error("Set ACTIVETAB_AUTHORIZED_TARGET_ID to the exact tab authorized through ActiveTab's Attach action.");
  const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
  const targets = await listTargets(endpoint);
  const selected = targets.find(target => target.id === targetId);
  if (!selected) throw new Error("The explicitly authorized browser target is unavailable at the configured CDP endpoint.");

  const target = await resolveAuthorizedTarget(endpoint, selected.id, targetId);
  const runStateStore = new RunStateStore(join(root, ".activetab", "runs"));
  await runStateStore.init();
  let session;
  try {
    session = await new BrowserSession(target).attach();
    const report = await withTargetExecutionLease(runStateStore, session, `dashboard-discovery-${randomUUID()}`, () =>
      discoverStagingDashboard({ session, environment, profile }));
    report.generatedAt = new Date().toISOString();
    report.target = { targetId: selected.id };

    const reportDir = join(root, ".activetab", "qualification", "staging-dashboard");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await chmod(reportDir, 0o700);
    const reportPath = join(reportDir, `staging-dashboard-${randomUUID()}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`Dashboard discovery: ${report.status}`);
    console.log(`Models: ${report.modelCatalog?.count ?? 0}`);
    if (report.navigation?.agentsLink) console.log(`Agents link: ${report.navigation.agentsLink.origin}${report.navigation.agentsLink.pathname}`);
    if (report.navigation?.adminConsoleLink) console.log(`Admin Console link (not opened): ${report.navigation.adminConsoleLink.origin}${report.navigation.adminConsoleLink.pathname}`);
    console.log(`Report: ${reportPath}`);
    if (report.reason) console.log(`Reason: ${report.reason}`);
    for (const limitation of report.limitations ?? []) console.log(`Limitation: ${limitation}`);
    process.exitCode = report.status === "COMPLETE" ? 0 : report.status === "BLOCKED" ? 2 : 1;
  } finally {
    runStateStore.close();
    await session?.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Dashboard discovery failed: ${String(error?.message ?? error).slice(0, 500)}`);
  process.exitCode = 2;
});
