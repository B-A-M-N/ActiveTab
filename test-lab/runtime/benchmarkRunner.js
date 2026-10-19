import { randomUUID } from "node:crypto";
import { assertFixtureProvider } from "./fixtureProvider.js";
import { assertValidScenario } from "./scenario.js";
import { scoreScenario } from "../scoring/scoreScenario.js";

/**
 * Run one benchmark episode. The driver receives only the target binding and
 * public task. Oracle access remains in the harness and is queried afterward.
 */
export async function runBenchmarkEpisode({ provider, scenario, driver, signal, automationRunId = randomUUID() } = {}) {
  assertFixtureProvider(provider);
  assertValidScenario(scenario);
  if (typeof driver !== "function") throw new TypeError("Benchmark driver must be a function.");
  const episodeId = randomUUID();
  let provisionAttempted = false;
  let provisioned = false;
  let driverResult = { status: "uncertain", reasonCode: "driver_not_started" };
  let oracle = null;
  let oracleError = null;
  let cleanupError = null;
  let cleanupVerified = false;
  try {
    provisionAttempted = true;
    await provider.provision({ episodeId, scenario, signal });
    provisioned = true;
    await provider.seed({ episodeId, scenario, signal });
    const targetBinding = provider.getTargetBinding();
    const task = Object.freeze({
      scenarioId: scenario.scenario_id,
      episodeId,
      operation: scenario.task.operation,
      modelRef: scenario.task.model_ref,
      promptRef: scenario.task.prompt_ref,
      prompt: scenario.task.prompt,
      goal: scenario.task.goal,
      entryUrl: targetBinding.entryUrl
    });
    driverResult = await driver(Object.freeze({ episodeId, automationRunId, targetBinding, task, signal }));
  } catch (error) {
    driverResult = { status: "failed", reasonCode: "fixture_or_driver_error", errorName: error?.name ?? "Error" };
  } finally {
    if (provisioned) {
      try { oracle = await provider.verifyOutcome({ episodeId, scenario }); }
      catch (error) { oracleError = { errorName: error?.name ?? "Error", reasonCode: "oracle_unavailable" }; }
    }
    // Provisioning can partially allocate resources before rejecting. Always
    // ask the provider to dispose and require explicit evidence of cleanup.
    try {
      const cleanup = await provider.dispose({ episodeId, provisioned });
      cleanupVerified = provisionAttempted && cleanup?.status === "verified";
      if (!cleanupVerified) cleanupError = { reasonCode: provisioned ? "fixture_cleanup_unverified" : "fixture_provision_unverified" };
    } catch (error) {
      cleanupError = { errorName: error?.name ?? "Error", reasonCode: provisioned ? "fixture_cleanup_failed" : "fixture_provision_unverified" };
    }
  }
  let score;
  try {
    score = oracle ? typeof provider.scoreOutcome === "function"
      ? await provider.scoreOutcome({ scenario, driverResult, oracle, cleanupVerified })
      : scoreScenario({ scenario, driverResult, oracle, cleanupVerified }) : {
    status: "INCONCLUSIVE",
    falseSuccess: driverResult?.status === "succeeded",
    driverClaimsSuccess: driverResult?.status === "succeeded",
    reasonCode: "independent_oracle_unavailable"
    };
  } catch {
    score = {
      status: "INCONCLUSIVE",
      falseSuccess: driverResult?.status === "succeeded",
      driverClaimsSuccess: driverResult?.status === "succeeded",
      reasonCode: "independent_scoring_unavailable"
    };
  }
  return Object.freeze({
    schemaVersion: 1,
    episodeId,
    automationRunId,
    scenarioId: scenario.scenario_id,
    siteFamily: scenario.site_family,
    seed: scenario.seed,
    applicationBuild: scenario.application?.build ?? null,
    qualification: Object.freeze({
      level: scenario.qualification.level,
      providerId: scenario.qualification.provider_id,
      providerIdentity: scenario.qualification.provider_identity,
      scenarioSeed: scenario.seed,
      sourceRevision: scenario.qualification.source_revision,
      oracleReference: scenario.qualification.oracle_reference,
      independentApplicationOutcome: Boolean(oracle),
      cleanupResult: Object.freeze({
        status: cleanupVerified ? "verified" : provisionAttempted ? "unverified" : "not_run",
        ...(cleanupError?.reasonCode ? { reasonCode: cleanupError.reasonCode } : {})
      })
    }),
    driver: {
      status: driverResult?.status ?? "uncertain",
      reportedRunId: driverResult?.reportedRunId ?? null,
      reasonCode: driverResult?.reasonCode ?? null
    },
    score,
    cleanupStatus: cleanupVerified ? "verified" : "unverified",
    ...(oracleError ? { oracleError } : {}),
    ...(cleanupError ? { cleanupError } : {})
  });
}
