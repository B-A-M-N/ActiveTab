#!/usr/bin/env node
/** Read-only structural inventory of the already-open account Admin Console. */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { ProfileLoader, loadEnvironmentBinding } from "../src/testing/profiles.js";
import { discoverStagingAdminConsole } from "../src/testing/stagingAdminConsoleDiscovery.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileId = process.argv.slice(2).find(value => value.startsWith("--profile="))?.slice(10) ?? "freeinference-staging";

async function main() {
  const profilesDir = join(root, "profiles");
  const profile = await new ProfileLoader(profilesDir).loadProfile(profileId);
  if (!profile) throw new Error(`No profile named '${profileId}'.`);
  const environment = await loadEnvironmentBinding(profilesDir, profileId);
  if (!profile.admin_console_discovery) throw new Error("The selected profile has no Admin Console discovery contract.");

  const targetId = process.env.ACTIVETAB_AUTHORIZED_TARGET_ID;
  if (!targetId) throw new Error("Set ACTIVETAB_AUTHORIZED_TARGET_ID to the exact tab authorized through ActiveTab's Attach action.");
  const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
  const selected = (await listTargets(endpoint)).find(target => target.id === targetId);
  if (!selected) throw new Error("The explicitly authorized browser target is unavailable at the configured CDP endpoint.");

  const session = await new BrowserSession(await resolveAuthorizedTarget(endpoint, selected.id, targetId)).attach();
  try {
    const report = await discoverStagingAdminConsole({ session, environment, profile });
    report.generatedAt = new Date().toISOString();
    report.target = { targetId: selected.id };
    const reportDir = join(root, ".activetab", "qualification", "staging-admin-console");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await chmod(reportDir, 0o700);
    const reportPath = join(reportDir, `staging-admin-console-${randomUUID()}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`Account Admin Console discovery: ${report.status}`);
    console.log(`Headings: ${(report.headings ?? []).join(", ") || "none"}`);
    console.log(`Tables: ${report.tables?.length ?? 0}; controls: ${report.controls?.length ?? 0}`);
    console.log(`User rows captured: ${report.privacy?.userRowsCaptured === true}`);
    console.log(`Report: ${reportPath}`);
    if (report.reason) console.log(`Reason: ${report.reason}`);
    process.exitCode = report.status === "COMPLETE" ? 0 : report.status === "BLOCKED" ? 2 : 1;
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Account Admin Console discovery failed: ${String(error?.message ?? error).slice(0, 500)}`);
  process.exitCode = 2;
});
