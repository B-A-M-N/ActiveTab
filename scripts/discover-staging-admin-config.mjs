#!/usr/bin/env node
/** Read-only inventory of an operator-opened account Admin Settings/Config page. */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { connectChromeAuto, listChromeTargets, resolveChromeTarget } from "../src/browser/chrome-autoconnect.js";
import { BrowserSession } from "../src/browser/session.js";
import { ProfileLoader, loadEnvironmentBinding } from "../src/testing/profiles.js";
import { discoverStagingAdminConfig } from "../src/testing/stagingAdminConfigDiscovery.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profileId = arg("profile", "freeinference-staging");
const browserProfileId = arg("browser-profile", "cloud-agent-staging");

async function main() {
  const profilesDir = join(root, "profiles");
  const loader = new ProfileLoader(profilesDir);
  const profile = await loader.loadProfile(profileId);
  if (!profile) throw new Error(`No profile named '${profileId}'.`);
  const browserProfile = await loader.loadProfile(browserProfileId);
  if (!browserProfile) throw new Error(`No owned browser profile named '${browserProfileId}'.`);
  if (!browserProfileId || browserProfileId === "." || browserProfileId === ".."
      || browserProfileId.includes("/") || browserProfileId.includes("\\")) {
    throw new Error("The browser profile must be a single ActiveTab profile identifier.");
  }
  const environment = await loadEnvironmentBinding(profilesDir, profileId);
  if (!profile.settings_config_discovery) throw new Error("The selected profile has no Settings/Config discovery contract.");

  const targetId = process.env.ACTIVETAB_AUTHORIZED_TARGET_ID;
  if (!targetId) throw new Error("Set ACTIVETAB_AUTHORIZED_TARGET_ID to the exact tab authorized through ActiveTab's Attach action.");
  const userDataDir = join(root, ".activetab", "qualification", "browser-profiles", browserProfileId);
  let connection;
  let session;
  try {
    connection = await connectChromeAuto({ userDataDir });
    const selected = (await listChromeTargets(connection)).find(value => value.id === targetId);
    if (!selected) throw new Error("The explicitly authorized target is unavailable in the selected ActiveTab-owned browser profile.");
    session = await new BrowserSession(await resolveChromeTarget(connection, selected.id, targetId)).attach();
    const report = await discoverStagingAdminConfig({ session, environment, profile, evidenceSource: "live_browser" });
    report.generatedAt = new Date().toISOString();
    report.target = { targetId: selected.id };
    const reportDir = join(root, ".activetab", "qualification", "staging-admin-config");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await chmod(reportDir, 0o700);
    const reportPath = join(reportDir, `staging-admin-config-${randomUUID()}.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`Account Admin Settings/Config discovery: ${report.status}`);
    console.log(`Evidence source: ${report.evidence?.source ?? "unavailable"}; route: ${report.route ?? "unverified"}; target: ${selected.id}`);
    console.log(`Surface: ${report.surface ?? "unidentified"}; headings: ${(report.headings ?? []).join(", ") || "none"}`);
    console.log(`Controls inventoried: ${report.controls?.length ?? 0}; text values read: ${report.privacy?.freeTextControlValuesRead === true}; controls operated: ${report.privacy?.controlsOperated === true}`);
    for (const control of report.controls ?? []) {
      const kind = [control.tag, control.type].filter(Boolean).join("/");
      const state = typeof control.checked === "boolean" ? `; state=${control.checked ? "on" : "off"}` : "";
      console.log(`- ${control.label || "(unlabeled)"} (${kind})${state}`);
      if (control.options?.length) console.log(`  options: ${control.options.join(", ")}`);
    }
    console.log(`Report: ${reportPath}`);
    if (report.reason) console.log(`Reason: ${report.reason}`);
    process.exitCode = report.status === "COMPLETE" ? 0 : report.status === "BLOCKED" ? 2 : 1;
  } finally {
    await session?.close().catch(() => {});
    await connection?.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Account Admin Settings/Config discovery failed: ${String(error?.message ?? error).slice(0, 500)}`);
  process.exitCode = 2;
});
