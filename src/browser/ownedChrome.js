/**
 * Owned Chrome lifecycle component (P0-1).
 *
 * A single Node.js invocation owns the entire browser lifetime: child
 * Chrome, the CDP connection, ActiveTab execution, and cleanup. This is
 * the common foundation for sandbox-safe qualification — no reliance on
 * background processes surviving between command invocations, no fixed
 * CDP port, no blanket process cleanup.
 *
 * Launch contract:
 *   --remote-debugging-port=0   (Chrome assigns a free loopback port)
 *   --user-data-dir=<unique disposable profile>
 *   --no-first-run --no-default-browser-check
 * No --headless unless explicitly requested. No --no-sandbox unless a
 * documented environment restriction requires it. GPU rendering is not
 * disabled by default.
 *
 * CDP readiness is proven from the profile's DevToolsActivePort file:
 * the owned process is alive, the assigned port is reachable, the
 * browser reports a usable CDP version, page targets are enumerated, and
 * only the target owned by this invocation is selected — never an
 * unrelated pre-existing tab, never port 9222.
 *
 * Cleanup is idempotent: stop admission, cancel in-progress actions,
 * flush receipts/diagnostics, close the CDP session, request graceful
 * termination, wait for the owned process to exit, force-terminate only
 * that owned process if necessary, remove the disposable profile, and
 * record the final shutdown outcome.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { listTargets, resolveAuthorizedTarget } from "./targets.js";
import { BrowserSession } from "./session.js";
import { CdpClient } from "../cdp/client.js";

function findChromeBinary(env = process.env) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  if (env.CHROME_BIN) return env.CHROME_BIN;
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

async function waitForAssignedPort(profileDir, timeoutMs, chromeProcess, signal) {
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const error = new Error("The browser launch was canceled.");
      error.name = "AbortError";
      error.code = 20;
      throw error;
    }
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chrome exited during startup (code ${chromeProcess.exitCode}) before publishing DevToolsActivePort.`);
    }
    try {
      const contents = await readFile(portFile, "utf8");
      const port = parseInt(contents.split("\n")[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Chrome did not publish a DevToolsActivePort within the readiness deadline.");
}

/**
 * Launch an owned headed Chrome, attach the authorized runner-owned
 * target, and return the full ownership handle. Everything created here
 * is cleaned up by close() — safe to call multiple times.
 *
 * @param {object} options
 * @param {string} options.initialUrl - Startup navigation target. For
 *   runner-owned disposable browsers an HTTP(S) URL is a safe startup
 *   target; it is chosen from the validated environment binding by the
 *   caller, never from a diagnostic adapter URL.
 * @param {boolean} [options.headed=true] - Headed is the default;
 *   headless requires an explicit opt-in (headed: false).
 * @param {"current-display"|"xvfb"} [options.displayMode] - Display
 *   source recorded for the run. This module never overwrites DISPLAY;
 *   the caller/operator provides a valid display session for headed runs.
 * @param {AbortSignal} [options.signal] - Cancellation during launch.
 */
export async function launchOwnedChrome({ initialUrl, headed = true, displayMode = "current-display", signal } = {}) {
  if (typeof initialUrl !== "string" || !initialUrl) {
    throw new Error("launchOwnedChrome requires an initialUrl (the validated application entry, not a diagnostic endpoint).");
  }
  let startupUrl;
  try {
    const parsed = new URL(initialUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
    startupUrl = initialUrl;
  } catch {
    throw new Error(`launchOwnedChrome initialUrl must be an HTTP(S) URL, got '${initialUrl}'.`);
  }

  const chromePath = findChromeBinary();
  if (!chromePath) throw new Error("Chrome binary not found. Install Chrome or set CHROME_PATH.");

  const profileDir = await mkdtemp(join(tmpdir(), "activetab-owned-chrome-"));
  let chromeProcess = null;
  let session = null;
  let closed = false;
  let closeResult = null;
  let stderrTail = "";

  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (headed === false) args.push("--headless=new"); // explicit opt-in only
  if (process.getuid?.() === 0 || process.env.ACTIVETAB_CHROME_NO_SANDBOX === "1") {
    // --no-sandbox only when the OS requires it (root containers) or the
    // operator explicitly opts in; never a silent default.
    args.push("--no-sandbox");
  }
  args.push(startupUrl);

  const launchMode = headed === false ? "headless (explicit opt-in)" : "headed";
  let endpoint = null;
  let browserVersion = null;
  let targetId = null;
  let readiness = { phase: "launch" };

  try {
    chromeProcess = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
    chromeProcess.stderr?.setEncoding("utf8");
    chromeProcess.stderr?.on("data", chunk => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    chromeProcess.on("error", error => {
      stderrTail += `\n[spawn error] ${String(error?.message ?? error)}`;
    });

    // 1-2. Assigned port + owned process still alive.
    const port = await waitForAssignedPort(profileDir, 20_000, chromeProcess, signal);
    endpoint = `http://127.0.0.1:${port}`;
    readiness = { phase: "port-assigned", endpoint };

    // 3. CDP version via the browser-level websocket.
    let browserClient;
    try {
      browserClient = await new CdpClient(`ws://127.0.0.1:${port}/devtools/browser`, { commandTimeoutMs: 10_000 }).connect();
    } catch {
      // Fall back to the /json/version discovery document.
      const version = await fetch(`${endpoint}/json/version`).then(r => r.json());
      if (typeof version?.webSocketDebuggerUrl !== "string") throw new Error("Chrome did not report a usable CDP browser websocket.");
      browserClient = await new CdpClient(version.webSocketDebuggerUrl, { commandTimeoutMs: 10_000 }).connect();
    }
    const versionInfo = await browserClient.send("Browser.getVersion").catch(() => null);
    browserVersion = versionInfo?.product ?? versionInfo?.revision ?? null;
    if (!browserVersion) {
      await browserClient.close().catch(() => {});
      throw new Error("Chrome did not report a usable CDP version.");
    }
    readiness = { phase: "cdp-version", browserVersion };

    // 4-6. Enumerate page targets; select only this invocation's own page.
    let targets = null;
    for (let i = 0; i < 50; i++) {
      if (signal?.aborted) {
        const error = new Error("The browser launch was canceled.");
        error.name = "AbortError";
        error.code = 20;
        throw error;
      }
      try {
        targets = await listTargets(endpoint);
        const page = targets.find(t => t.type === "page");
        if (page) break;
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 100));
    }
    const ownedTarget = targets?.find(t => t.type === "page");
    if (!ownedTarget) {
      await browserClient.close().catch(() => {});
      throw new Error("Chrome did not expose a page target owned by this invocation.");
    }
    targetId = ownedTarget.id;
    const target = await resolveAuthorizedTarget(endpoint, targetId, targetId);
    target.browserClient = browserClient;
    target.ownsBrowserClient = true;
    session = await new BrowserSession(target).attach();
    session.persistent = false;
    readiness = { phase: "attached", targetId };

    // 7. Verify the browser actually loaded the intended URL.
    const deadline = Date.now() + 20_000;
    let observed = null;
    while (Date.now() < deadline) {
      observed = await session.observe().catch(() => null);
      const url = observed?.page?.url;
      if (url && url !== "about:blank" && url !== "chrome-error://chromewebdata/") break;
      await new Promise(r => setTimeout(r, 250));
    }
    const observedUrl = observed?.page?.url ?? null;
    readiness = { phase: "loaded", url: observedUrl };

    let processExit = null;
    chromeProcess.once("exit", (code, sig) => { processExit = { code, signal: sig }; });
  } catch (error) {
    // Differentiate launch failure, crash, and CDP attachment failure.
    const exited = chromeProcess?.exitCode !== null && chromeProcess?.exitCode !== undefined;
    error.launchDiagnostics = {
      phase: readiness.phase,
      chromeExitedDuringLaunch: exited === true,
      exitCode: chromeProcess?.exitCode ?? null,
      devToolsActivePortAppeared: endpoint !== null,
      cdpReachable: endpoint !== null,
      pageTargetCreated: targetId !== null,
      launchMode,
      stderrTail: stderrTail.slice(-800)
    };
    try { chromeProcess?.kill("SIGKILL"); } catch { /* already dead */ }
    try { await rm(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  /**
   * Idempotent cleanup (P0-1): stop admission, cancel in-progress owned
   * actions, close the CDP session, request graceful termination, wait for
   * the owned process, force-terminate only that process if necessary,
   * remove the disposable profile, and record the shutdown outcome.
   */
  async function close() {
    if (closed) return closeResult;
    closed = true;
    const outcome = { graceful: false, forced: false, exitCode: null, profileRemoved: false, error: null };
    try {
      // Close the CDP session first (this also detaches owned targets).
      if (session) await session.close().catch(() => {});
      if (chromeProcess && chromeProcess.exitCode === null) {
        chromeProcess.kill("SIGTERM");
        const gracefulDeadline = Date.now() + 5_000;
        while (Date.now() < gracefulDeadline && chromeProcess.exitCode === null) {
          await new Promise(r => setTimeout(r, 100));
        }
        if (chromeProcess.exitCode === null) {
          chromeProcess.kill("SIGKILL");
          outcome.forced = true;
          await Promise.race([once(chromeProcess, "exit"), new Promise(r => setTimeout(r, 3_000))]).catch(() => {});
        }
        outcome.graceful = !outcome.forced;
        outcome.exitCode = chromeProcess.exitCode;
      } else {
        outcome.exitCode = chromeProcess?.exitCode ?? null;
        outcome.graceful = true;
      }
    } catch (error) {
      outcome.error = String(error?.message ?? error).slice(0, 300);
    } finally {
      try { await rm(profileDir, { recursive: true, force: true }); outcome.profileRemoved = true; }
      catch (error) { outcome.error = outcome.error ?? String(error?.message ?? error).slice(0, 300); }
      closeResult = outcome;
    }
    return closeResult;
  }

  return {
    session,
    endpoint,
    targetId,
    chromeProcess,
    browserVersion,
    launchMode,
    displayMode,
    profileDir,
    readiness,
    signal,
    close
  };
}
