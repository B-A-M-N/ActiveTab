#!/usr/bin/env node
/**
 * Run a selected read-only Admin dashboard recipe on one explicitly
 * authorized, already-authenticated Cloud Agent tab. This entrypoint is
 * intentionally separate from Cloud Agent task execution/qualification.
 */

import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { listTargets, resolveAuthorizedTarget } from "../src/browser/targets.js";
import { BrowserSession } from "../src/browser/session.js";
import { ProfileLoader, loadEnvironmentBinding } from "../src/testing/profiles.js";
import { discoverAdminDashboard } from "../src/testing/adminDashboardDiscovery.js";
import { verifyObservedUrl } from "../src/environments/model.js";

const args = process.argv.slice(2);
function valueOf(name, fallback = null) {
  const prefix = "--" + name + "=";
  const value = args.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profileId = valueOf("profile", "cloud-agent-staging");
const recipeArg = valueOf("recipe");
const recipeId = recipeArg ?? "admin-dashboard-inventory";
const areaArg = valueOf("area");
if (recipeArg && areaArg) {
  console.error("Use either --recipe=... or --area=..., not both.");
  process.exit(2);
}
async function main() {
  const profilesDir = join(root, "profiles");
  const loader = new ProfileLoader(profilesDir);
  const profile = await loader.loadProfile(profileId);
  if (!profile) throw new Error("No profile named " + profileId + ".");
  const environment = await loadEnvironmentBinding(profilesDir, profileId);
  const config = profile.staging_ui_diagnostics;
  if (!config) throw new Error("The selected profile has no Admin discovery contract.");

  let areas = areaArg;
  if (!areaArg) {
    const recipe = (config.recipes ?? []).find(item => item.recipe_id === recipeId);
    if (!recipe) throw new Error("No recipe named " + recipeId + " is declared in the profile.");
    areas = recipe.areas;
  }

  const targetId = process.env.ACTIVETAB_AUTHORIZED_TARGET_ID;
  if (!targetId) throw new Error("Set ACTIVETAB_AUTHORIZED_TARGET_ID to the exact tab authorized through ActiveTab's Attach action.");
  const endpoint = process.env.ACTIVETAB_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
  const targets = await listTargets(endpoint);
  const selected = targets.find(target => target.id === targetId);
  if (!selected) throw new Error("The explicitly authorized browser target is not available at the configured CDP endpoint.");
  const identity = verifyObservedUrl(environment, selected.url);
  if (!identity.ok || identity.origin !== config.application_origin) {
    throw new Error("The selected target is not on the profile's observed Cloud Agent origin: " + (identity.reason ?? identity.origin));
  }

  const target = await resolveAuthorizedTarget(endpoint, selected.id, targetId);
  const session = await new BrowserSession(target).attach();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const report = await discoverAdminDashboard({
      session,
      environment,
      profile,
      areas,
      signal: controller.signal,
      onEvent: message => console.log("  " + message)
    });
    report.generatedAt = new Date().toISOString();
    report.target = { targetId: selected.id, origin: identity.origin };
    const reportDir = join(root, ".activetab", "qualification", "admin-discovery");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await chmod(reportDir, 0o700);
    const reportPath = join(reportDir, "admin-discovery-" + randomUUID() + ".json");
    await writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log("Admin discovery: " + report.status);
    console.log("Areas: " + (report.selectedAreas ?? []).join(", "));
    console.log("Report: " + reportPath);
    for (const limitation of report.limitations ?? []) console.log("Limitation: " + limitation);
    process.exitCode = report.status === "COMPLETE" ? 0 : report.status === "BLOCKED" ? 2 : 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await session.close().catch(() => {});
  }
}

main().catch(error => {
  console.error("Admin discovery failed: " + String(error?.message ?? error).slice(0, 500));
  process.exitCode = 2;
});
