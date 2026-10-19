import { pathToFileURL } from "node:url";
import { loadPublicSearchScenario, listPublicSearchScenarios } from "../src/qualification/live/publicSearchScenario.js";
import { runPublicSearchBrowseQualification } from "../src/qualification/live/publicSearchRunDriver.js";

function parseArguments(args) {
  let scenarioId;
  let list = false;
  let confirmReadOnly = false;
  let enableJevVisual = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--list") { list = true; continue; }
    if (value === "--confirm-readonly") { confirmReadOnly = true; continue; }
    if (value === "--allow-jev-visual") { enableJevVisual = true; continue; }
    if (value === "--scenario-id") {
      if (scenarioId || !args[index + 1]) throw new Error("--scenario-id requires exactly one value.");
      scenarioId = args[++index];
      continue;
    }
    if (value.startsWith("--scenario-id=")) {
      if (scenarioId) throw new Error("--scenario-id may be supplied only once.");
      scenarioId = value.slice("--scenario-id=".length);
      continue;
    }
    throw new Error(`Unsupported qualification option '${value}'.`);
  }
  if (list && (scenarioId || confirmReadOnly || enableJevVisual)) throw new Error("--list cannot be combined with run options.");
  if (enableJevVisual && !confirmReadOnly) throw new Error("--allow-jev-visual requires the explicit read-only run confirmation.");
  return { help: false, list, scenarioId, confirmReadOnly, enableJevVisual };
}

function printHelp() {
  process.stdout.write([
    "ActiveTab live public-web AI qualification",
    "",
    "  npm run qualify:public-sites -- --list",
    "  npm run qualify:public-sites -- --scenario-id ID --confirm-readonly [--allow-jev-visual]",
    "",
    "Runs a random, neutral query through a real search engine in owned headed Chrome.",
    "The configured secondary model selects a visible result; Jev image review is opt-in.",
    "Only anonymous read/search, one admitted Wikipedia result navigation, and optional scrolling are allowed.",
    "Temporary Chrome state is removed; owner-only decision history and qualification receipts persist."
  ].join("\n") + "\n");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.list) {
    const scenarios = await listPublicSearchScenarios();
    process.stdout.write(`${JSON.stringify(scenarios.map(({ scenarioId, siteId, qualificationTier, entryUrl, destinationOrigin, queryPoolId }) => ({ scenarioId, siteId, qualificationTier, entryUrl, destinationOrigin, queryPoolId })), null, 2)}\n`);
    return;
  }
  if (!args.scenarioId) throw new Error("--scenario-id is required; use --list to see registered live scenarios.");
  const scenario = await loadPublicSearchScenario(args.scenarioId);
  const result = await runPublicSearchBrowseQualification(scenario, {
    explicitReadOnlyConfirmation: args.confirmReadOnly,
    enableJevVisual: args.enableJevVisual,
    headed: true
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcomeStatus !== "verified_success") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error?.message ?? "Public-web qualification failed."}\n`);
    process.exitCode = 2;
  });
}
