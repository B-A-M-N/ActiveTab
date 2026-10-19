import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QualificationService } from "./qualificationService.js";
import { createNativeCdpQualificationDriver } from "../../test-lab/runtime/nativeCdpDriver.js";
import { createFiAgentTwinProvider } from "../../test-lab/fixtures/fi-agent-twin/provider.js";
import { createWebArenaInfinityGmailProvider } from "../../test-lab/adapters/webarenaInfinityGmailProvider.js";
import { createWebArenaInfinityGmailExtractionDriver } from "../../test-lab/adapters/webarenaInfinityGmailDriver.js";

const scenarioFiles = [
  new URL("../../test-lab/catalog/scenarios/fi-task-recovery-004.json", import.meta.url),
  new URL("../../test-lab/catalog/scenarios/webarena-infinity-gmail-task-001.json", import.meta.url),
  new URL("../../test-lab/catalog/scenarios/webarena-infinity-gmail-extract-001.json", import.meta.url)
];

function loadScenario(url) {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/**
 * Compose the native ActiveTab qualification capability. The FI twin is
 * always available; the independent WebArena-Infinity app is registered
 * only when its explicitly local origin is configured.
 */
export function createQualificationRuntime({
  decisionRuntime,
  externalGmailOrigin = process.env.ACTIVETAB_BENCHMARK_WEBARENA_INFINITY_URL ?? null,
  externalGmailOracleToken = process.env.ACTIVETAB_WEBARENA_ORACLE_TOKEN ?? null,
  headed = process.env.ACTIVETAB_HEADLESS !== "1",
  launchBrowser,
  providers = {},
  drivers = {},
  scenarios = scenarioFiles.map(loadScenario)
} = {}) {
  const nativeDriver = createNativeCdpQualificationDriver({ decisionRuntime, headed, launchBrowser });
  const gmailExtractionDriver = createWebArenaInfinityGmailExtractionDriver({ decisionRuntime, headed, launchBrowser });
  const configuredProviders = {
    fi_agent_twin: () => createFiAgentTwinProvider(),
    ...(externalGmailOrigin && externalGmailOracleToken ? {
      webarena_infinity_gmail: () => createWebArenaInfinityGmailProvider({ origin: externalGmailOrigin, oracleToken: externalGmailOracleToken })
    } : {}),
    ...providers
  };
  const configuredDrivers = {
    fi_agent_twin: nativeDriver,
    ...(externalGmailOrigin && externalGmailOracleToken ? {
      webarena_infinity_gmail: context => context.task?.operation === "extract_inbox_records"
        ? gmailExtractionDriver(context) : nativeDriver(context)
    } : {}),
    ...drivers
  };
  return new QualificationService({ decisionRuntime, scenarioCatalog: scenarios, providers: configuredProviders, drivers: configuredDrivers });
}
