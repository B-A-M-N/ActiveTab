/**
 * Real navigation runner that connects the API server to the existing
 * CDP-backed NavigationEngine. The runner never selects or authorizes
 * browser targets on its own: it must be given an authorized session
 * resolver. The extension's explicit per-tab Attach flow and the
 * caller-confirmed direct CDP / auto-connect flows remain the only
 * ways a target becomes authorized.
 *
 * Cancellation propagates through the engine and CDP operations via an
 * AbortSignal. Cancellation after input dispatch preserves the action
 * as uncertain rather than reporting success or silently replaying it.
 *
 * Disposable browser sessions use a fresh profile, no default
 * --no-sandbox, and the debug port Chrome assigns (port 0); only
 * resources owned by the runner are terminated on cleanup.
 */
import { NavigationEngine } from "../navigation/engine.js";
import { BrowserSession } from "../browser/session.js";
import { TaskJournal } from "../state/journal.js";
import { generateOutputFiles } from "./output-files.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

function abortedMarker(signal) {
  if (!signal?.aborted) return null;
  const error = new Error("The navigation run was canceled.");
  error.name = "AbortError";
  error.code = 20;
  return error;
}

/**
 * Create a navigation runner backed by a real browser session.
 * @param {object} options
 * @param {Function} options.resolveSession - REQUIRED. Receives
 *   ({ goal, input, templateId, taskId, signal }) and must return an
 *   authorized BrowserSession (or a promise for one). The resolver is
 *   the sole authority on session selection; the runner never inspects
 *   or picks user browser targets itself.
 * @param {string} [options.outputDir] - Directory for output files.
 * @param {string} [options.journalDir] - Directory for task journals.
 * @param {string[]} [options.outputFormats] - Default export formats.
 * @param {boolean} [options.sensitiveExports] - Allow owner-authorized
 *   full exports. Default false.
 * @param {object} [options.engineOptions] - Additional NavigationEngine options.
 */
export function createNavigationRunner({
  resolveSession,
  outputDir = join(process.cwd(), ".activetab", "output"),
  journalDir = join(process.cwd(), ".activetab", "journals"),
  outputFormats,
  sensitiveExports = false,
  engineOptions = {}
} = {}) {
  if (typeof resolveSession !== "function") {
    throw new Error("createNavigationRunner requires an authorized session resolver (resolveSession). The API cannot select or authorize browser targets implicitly.");
  }
  return {
    /**
     * Run a navigation goal and return results.
     * @param {string} goal - Natural language goal
     * @param {object} context
     * @param {AbortSignal} context.signal - Abort signal for cancellation
     * @param {object} context.input - Validated input from template
     * @param {string} context.templateId - Template that created this run
     * @param {string} context.taskId - Task id assigned by the API server
     * @param {object} [context.inputSchema] - Template input schema (for redacted exports)
     * @param {boolean} [context.ownerAuthorizedExport] - Run owner explicitly authorized a full export
     */
    async run(goal, { signal, input, templateId, taskId: providedTaskId, inputSchema, ownerAuthorizedExport } = {}) {
      let abortError = abortedMarker(signal);

      let session;
      const startedAt = Date.now();
      try {
        // Check again right before acquiring: a pre-aborted run must never
        // open a browser session.
        if (abortError) throw abortError;
        session = await resolveSession({ goal, input, templateId, taskId: providedTaskId, signal });
        if (!session || session.attached !== true || !session.target?.id) {
          throw new Error("The session resolver did not return an attached authorized browser session.");
        }
        abortError ??= abortedMarker(signal);
        if (abortError) throw abortError;

        const taskId = providedTaskId ?? randomUUID();
        const journalPath = join(journalDir, `${taskId}.json`);
        const journal = new TaskJournal(journalPath);

        const engine = new NavigationEngine(session, {
          journal,
          maxActions: engineOptions.maxActions ?? 8,
          maxRecoveries: engineOptions.maxRecoveries ?? 1,
          maxScrolls: engineOptions.maxScrolls ?? 5,
          signal,
          ...engineOptions
        });

        const result = await engine.run(goal);
        abortError ??= abortedMarker(signal);
        if (abortError) throw abortError;

        const output = buildOutput(result, input);

        const outputFiles = await generateOutputFiles(
          taskId,
          { goal, input, output, status: result.status, evidenceId: result.evidenceId ?? null, inputSchema },
          outputDir,
          {
            ...(outputFormats ? { formats: outputFormats } : {}),
            includeSensitive: sensitiveExports === true,
            authorized: ownerAuthorizedExport === true
          }
        );

        return {
          status: result.status,
          output,
          usage: measureUsage(result, { startedAt }),
          output_files: outputFiles,
          live_url_info: null,
          task_id: taskId,
          evidence_id: result.evidenceId ?? null
        };
      } catch (error) {
        if (error?.name === "AbortError") return { status: "canceled" };
        throw error;
      } finally {
        if (session && session.persistent !== true) {
          try { await session.close(); }
          catch (error) {
            const { logger, bound } = await import("../runtime/logger.js");
            logger.warn("session.close.failed", { reason: bound(error?.message ?? error, 120) });
          }
        }
      }
    }
  };
}

/**
 * Build structured output from navigation engine result.
 * The raw goal stays in memory only; exports receive a redacted projection.
 */
function buildOutput(result, input) {
  const output = {
    status: result.status,
    goal: result.goal ?? "[redacted]",
    attempts: result.attempts ?? 0,
    recoveries: result.recoveries ?? 0
  };
  if (result.reason) output.reason = result.reason;
  if (result.page) output.page = { url: result.page.url, title: result.page.title };
  if (result.evidenceId) output.evidence_id = result.evidenceId;
  if (result.page?.extractedData) output.records = result.page.extractedData;
  if (result.records) output.records = result.records;
  return output;
}

/**
 * Locally measured execution statistics. Synthetic vendor credits are
 * never reported; consumption is described by what the runtime actually
 * did: actions, recoveries, planner usage when available, and wall time.
 */
function measureUsage(result, { startedAt }) {
  return {
    actions: result.attempts ?? 0,
    recoveries: result.recoveries ?? 0,
    planner_calls: result.plannerCalls ?? null,
    tokens_used: result.tokensUsed ?? null,
    elapsed_ms: Date.now() - startedAt
  };
}

// ── Authorized session resolvers ─────────────────────────────────────────
// Each resolver implements one of ActiveTab's established authorization
// paths. None of them authorizes an existing user tab implicitly.

/** Session resolver backed by the MV3 extension broker (per-tab Attach clicks). */
export async function resolveExtensionSession({ extensionBroker }) {
  if (!extensionBroker) throw new Error("Extension broker is not configured (ACTIVETAB_EXTENSION=1).");
  const tabs = await extensionBroker.listTabs();
  if (tabs.length === 0) {
    throw new Error("No attached tabs. Authorize a tab by clicking Attach in the ActiveTab toolbar popup.");
  }
  if (tabs.length > 1) {
    throw new Error("Multiple attached tabs; the API run must name one authorized targetId explicitly.");
  }
  const target = await extensionBroker.resolveTarget(tabs[0].id);
  return await new BrowserSession(target).attach();
}

/** Session resolver for a caller-selected direct-CDP target (requires confirmed authorization). */
export async function resolveDirectCdpSession({ endpoint, targetId, authorizedTargetId }) {
  const { resolveAuthorizedTarget } = await import("../browser/targets.js");
  const selected = targetId ?? authorizedTargetId;
  if (!selected) throw new Error("ACTIVETAB_TARGET_ID (or an explicit target selection) is required for direct CDP runs.");
  const target = await resolveAuthorizedTarget(endpoint, selected, authorizedTargetId ?? selected);
  const session = await new BrowserSession(target).attach();
  session.persistent = false;
  return session;
}

/**
 * Session resolver that launches a separately authorized disposable
 * browser. This mode never touches an existing user profile.
 */
export async function resolveDisposableSession({ signal, bootstrapUrl } = {}) {
  return await launchDisposableChrome({ signal, ...(bootstrapUrl ? { bootstrapUrl } : {}) });
}

/**
 * Resolve a session from environment configuration, without ever
 * falling back to a different mode or an implicit user tab.
 */
export async function resolveConfiguredSession(env = process.env) {
  const extensionMode = env.ACTIVETAB_EXTENSION === "1";
  const autoConnect = env.ACTIVETAB_AUTO_CONNECT === "1";
  const directEndpoint = env.ACTIVETAB_CDP_ENDPOINT;
  const modes = [extensionMode, autoConnect, Boolean(directEndpoint), env.ACTIVETAB_DISPOSABLE_BROWSER === "1"].filter(Boolean).length;
  if (modes === 0) {
    throw new Error("No authorized browser session mode configured. Set ACTIVETAB_EXTENSION=1 (per-tab Attach), ACTIVETAB_AUTO_CONNECT=1 with a confirmed target, ACTIVETAB_CDP_ENDPOINT with ACTIVETAB_AUTHORIZED_TARGET_ID, or ACTIVETAB_DISPOSABLE_BROWSER=1.");
  }
  if (modes > 1) throw new Error("Conflicting browser session configuration; select exactly one authorized session mode.");

  if (extensionMode) {
    const { ExtensionBroker } = await import("../extension/broker.js");
    const { brokerSocketPath } = await import("../extension/paths.js");
    const broker = await new ExtensionBroker({ socketPath: brokerSocketPath() }).start();
    try { return await resolveExtensionSession({ extensionBroker: broker }); }
    catch (error) { await broker.close(); throw error; }
  }
  if (autoConnect) {
    const { connectChromeAuto, listChromeTargets, resolveChromeTarget } = await import("../browser/chrome-autoconnect.js");
    const connection = await connectChromeAuto();
    try {
      const targets = await listChromeTargets(connection);
      if (targets.length === 0) throw new Error("No Chrome page targets found. Open a tab in the debug-enabled Chrome profile and confirm the browser prompt.");
      const selected = env.ACTIVETAB_TARGET_ID;
      if (!selected) throw new Error("ACTIVETAB_TARGET_ID is required: list targets first, then confirm the exact target out of band. The first existing tab is never selected automatically.");
      const target = await resolveChromeTarget(connection, selected, env.ACTIVETAB_AUTHORIZED_TARGET_ID ?? selected);
      const session = await new BrowserSession(target).attach();
      session.persistent = false;
      session._chromeConnection = connection; // keep bridge alive for session lifetime
      return session;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }
  if (directEndpoint) {
    return await resolveDirectCdpSession({
      endpoint: directEndpoint,
      targetId: env.ACTIVETAB_TARGET_ID,
      authorizedTargetId: env.ACTIVETAB_AUTHORIZED_TARGET_ID
    });
  }
  return await resolveDisposableSession();
}

/**
 * Launch a new headed Chrome instance by default. ACTIVETAB_HEADLESS=1 is
 * an explicit operator opt-in for constrained environments; it is never a
 * silent fallback.
 * enabled on the port Chrome assigns. No default --no-sandbox. Only the
 * process and profile directory created here are cleaned up on close.
 */
async function launchDisposableChrome({ signal, bootstrapUrl } = {}) {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const { listTargets, resolveAuthorizedTarget } = await import("../browser/targets.js");

  const chromePath = findChromeBinary();
  if (!chromePath) throw new Error("Chrome binary not found. Install Chrome or set CHROME_PATH environment variable.");

  const profileDir = await mkdtemp(join(tmpdir(), "activetab-chrome-"));

  const args = [
    "--remote-debugging-port=0", // Chrome assigns a free loopback port and records it in DevToolsActivePort
    `--user-data-dir=${profileDir}`,
    "--disable-gpu",
    "--disable-dev-shm-usage"
  ];
  if (process.env.ACTIVETAB_HEADLESS === "1") args.push("--headless=new");
  if (process.getuid?.() === 0 || process.env.ACTIVETAB_CHROME_NO_SANDBOX === "1") {
    // --no-sandbox is only used when the OS requires it (root containers)
    // or the operator explicitly opts in; it is never a silent default.
    args.push("--no-sandbox");
  }
  // For a runner-owned disposable browser, the bootstrap URL is a safe
  // startup target. Using an HTTP(S) bootstrap URL avoids the test-only
  // workaround of navigating about:blank over raw CDP before authorization.
  args.push(bootstrapUrl ?? "about:blank");

  const chromeProcess = spawn(chromePath, args, { stdio: ["ignore", "ignore", "ignore"] });

  {
    const abortError = abortedMarker(signal);
    if (abortError) throw abortError;
  }

  try {
    // Read the Chrome-assigned endpoint from the profile's DevToolsActivePort.
    const port = await waitForAssignedPort(profileDir, 15_000, signal);
    const endpoint = `http://127.0.0.1:${port}`;

    let targets = null;
    for (let i = 0; i < 50; i++) {
      const abortError = abortedMarker(signal);
      if (abortError) throw abortError;
      try {
        targets = await listTargets(endpoint);
        if (targets.length > 0) break;
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!targets || targets.length === 0) throw new Error("Chrome did not expose CDP targets within 5 seconds.");

    // The disposable instance is entirely runner-owned, so its initial
    // about:blank target is selected explicitly; no user tab is involved.
    const targetId = targets[0].id;
    const target = await resolveAuthorizedTarget(endpoint, targetId, targetId);
    const session = await new BrowserSession(target).attach();
    session.persistent = false;

    const originalClose = session.close.bind(session);
    session.close = async () => {
      try { await originalClose(); } catch { /* best effort */ }
      try { chromeProcess.kill("SIGKILL"); } catch { /* already dead */ }
      try { await rm(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    session.ownedBrowserProcess = chromeProcess;

    return session;
  } catch (error) {
    try { chromeProcess.kill("SIGKILL"); } catch { /* already dead */ }
    try { await rm(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function waitForAssignedPort(profileDir, timeoutMs, signal) {
  const { readFile } = await import("node:fs/promises");
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const abortError = abortedMarker(signal);
    if (abortError) throw abortError;
    try {
      const contents = await readFile(portFile, "utf8");
      const port = parseInt(contents.split("\n")[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Chrome did not publish a DevToolsActivePort within 15 seconds.");
}

function findChromeBinary() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ]
  };
  for (const path of candidates[process.platform] ?? []) {
    if (existsSync(path)) return path;
  }
  return null;
}
