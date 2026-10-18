#!/usr/bin/env node
/**
 * Start the ActiveTab local API server.
 *
 * The server refuses to start unless a real, authorized navigation
 * execution service is available: the API must never acknowledge an
 * executable task when no executor exists (fail closed).
 *
 * Browser session selection is explicit and never authorizes an
 * existing tab implicitly:
 * - ACTIVETAB_EXTENSION=1            per-tab Attach grants via the MV3 broker
 * - ACTIVETAB_AUTO_CONNECT=1         Chrome opt-in bridge; requires a
 *                                    confirmed ACTIVETAB_TARGET_ID
 * - ACTIVETAB_CDP_ENDPOINT + ACTIVETAB_TARGET_ID
 *                                    caller-selected dedicated target with
 *                                    out-of-band authorization
 * - ACTIVETAB_DISPOSABLE_BROWSER=1   separately authorized disposable browser
 *
 * Usage:
 *   node src/api/start-server.js [--port N]
 *
 * Environment:
 *   ACTIVETAB_API_PORT        Port to listen on (default: 9377)
 *   ACTIVETAB_TASK_DIR        Directory for task persistence (default: .activetab/tasks)
 *   ACTIVETAB_API_TOKEN       Local bearer token for state-changing requests
 *   ACTIVETAB_SESSION_MODE    Optional: extension | auto-connect | direct | disposable
 *                             (exactly one; overrides the env-flag detection)
 *   ACTIVETAB_OUTPUT_FORMATS  Optional comma-separated export formats
 *                             (json,md,csv,xml; default json+md[+csv])
 */
import { createApiServer } from "./local-server.js";
import { createNavigationRunner, resolveConfiguredSession } from "./navigation-runner.js";
import { createRemoteExecutor } from "../runtime/remote-executor.js";
import { join } from "node:path";
import { createDecisionRuntime } from "../decisions/runtime.js";

const port = parseInt(process.env.ACTIVETAB_API_PORT ?? "9377", 10);
const taskStoreDir = process.env.ACTIVETAB_TASK_DIR;

const outputFormats = process.env.ACTIVETAB_OUTPUT_FORMATS
  ? process.env.ACTIVETAB_OUTPUT_FORMATS.split(",").map(value => value.trim()).filter(Boolean)
  : undefined;

// Executor selection:
// - ACTIVETAB_REMOTE_PEER_URL set → this node forwards redacted run
//   requests to a LAN peer that executes them (heavy work offloaded).
//   Browser authorization, evidence, and control stay on this machine's
//   API/MCP surface; the peer does the navigation execution.
// - Otherwise → this node executes locally and requires an explicit,
//   authorized session mode (fail closed when none is configured).
let navigationRunner;
const decisionRuntime = createDecisionRuntime();
if (process.env.ACTIVETAB_REMOTE_PEER_URL) {
  navigationRunner = createRemoteExecutor({
    peerUrl: process.env.ACTIVETAB_REMOTE_PEER_URL,
    peerTokenFile: process.env.ACTIVETAB_REMOTE_TOKEN_FILE,
    ...(process.env.ACTIVETAB_REMOTE_TIMEOUT_MS ? { timeoutMs: parseInt(process.env.ACTIVETAB_REMOTE_TIMEOUT_MS, 10) } : {})
  });
  console.log(`Remote execution mode: runs forward to ${process.env.ACTIVETAB_REMOTE_PEER_URL}`);
} else try {
  navigationRunner = createNavigationRunner({
    resolveSession: context => resolveConfiguredSession({
      ...process.env,
      ...(process.env.ACTIVETAB_SESSION_MODE === "extension" ? { ACTIVETAB_EXTENSION: "1" } : {}),
      ...(process.env.ACTIVETAB_SESSION_MODE === "auto-connect" ? { ACTIVETAB_AUTO_CONNECT: "1" } : {}),
      ...(process.env.ACTIVETAB_SESSION_MODE === "direct" ? { ACTIVETAB_CDP_ENDPOINT: process.env.ACTIVETAB_CDP_ENDPOINT } : {}),
      ...(process.env.ACTIVETAB_SESSION_MODE === "disposable" ? { ACTIVETAB_DISPOSABLE_BROWSER: "1" } : {})
    }).then(session => session, error => {
      throw new Error(`Navigation execution is unavailable: ${String(error.message ?? error)}`);
    }),
    engineOptions: { decisionRuntime },
    ...(outputFormats ? { outputFormats } : {})
  });
} catch (error) {
  console.error(`Refusing to start: ${String(error.message ?? error)}`);
  process.exit(1);
}
if (!navigationRunner) {
  console.error("Refusing to start: no navigation execution service could be initialized.");
  process.exit(1);
}

process.env.ACTIVETAB_REPORT_DIR ??= join(process.env.ACTIVETAB_TASK_DIR ?? join(process.cwd(), ".activetab"), "reports");
const api = createApiServer({
  port, taskStoreDir, navigationRunner, decisionRuntime,
  executorName: process.env.ACTIVETAB_REMOTE_PEER_URL ? "remote-peer" : "local",
  reportDir: process.env.ACTIVETAB_REPORT_DIR
});
await api.start();

process.on("SIGINT", async () => { await api.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await api.stop(); process.exit(0); });
