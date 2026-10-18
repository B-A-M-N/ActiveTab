/**
 * Owned Chrome lifecycle component (P0-1).
 *
 * Qualification invocations own the browser lifetime: child Chrome, the
 * CDP connection, ActiveTab execution, and cleanup. The explicit manual
 * open-only path can detach after launch and leave its persistent Chrome
 * profile available for authentication without keeping a command alive.
 *
 * Launch contract:
 *   --remote-debugging-port=0   (Chrome assigns a free loopback port)
 *   --user-data-dir=<caller-selected profile>
 *   --no-first-run --no-default-browser-check
 * No --headless unless explicitly requested. No --no-sandbox unless a
 * documented environment restriction requires it. GPU rendering is not
 * disabled by default.
 *
 * CDP readiness is proven from the profile's DevToolsActivePort file:
 * the owned process is alive, the assigned port is reachable, the
 * browser reports a usable CDP version, page targets are enumerated, and
 * only the target owned by this invocation is selected — never an
 * unrelated pre-existing tab, never port 9222. Open-only reuse attaches
 * at browser level and does not select or navigate a page. A qualification
 * may reattach to an existing target only when its exact ID is supplied and
 * its current origin is in the caller's allowlist; that path never navigates.
 *
 * Cleanup is idempotent: stop admission, cancel in-progress actions,
 * flush receipts/diagnostics, close the CDP session, request graceful
 * termination, wait for the owned process to exit, force-terminate only
 * that owned process if necessary, and preserve or remove the profile
 * according to the explicit caller option.
 */

import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { listTargets, resolveAuthorizedTarget } from "./targets.js";
import { BrowserSession } from "./session.js";
import { CdpClient } from "../cdp/client.js";
import { readChromeDebugEndpoint } from "./chrome-autoconnect.js";

export async function chromeProfileLockPresent(profileDir) {
  try {
    await lstat(join(profileDir, "SingletonLock"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function connectExistingChrome(profileDir) {
  const portFile = join(profileDir, "DevToolsActivePort");
  const portFileStat = await lstat(portFile).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const profileLocked = await chromeProfileLockPresent(profileDir);

  if (!portFileStat) {
    if (profileLocked) {
      throw new Error("Chrome already owns this profile, but its DevTools endpoint is missing. Refusing to launch another Chrome or forward a startup URL into the open browser.");
    }
    return null;
  }

  // Parse and validate the handoff before considering it stale. Malformed or
  // symlinked endpoint metadata is never removed as part of launch recovery.
  const endpointInfo = await readChromeDebugEndpoint(profileDir);
  const client = await new CdpClient(endpointInfo.webSocketDebuggerUrl, { commandTimeoutMs: 5_000 }).connect().catch(() => null);
  if (client) {
    const version = await client.send("Browser.getVersion").catch(() => null);
    if (version) {
      const endpointUrl = new URL(endpointInfo.webSocketDebuggerUrl);
      const existing = {
        client,
        endpoint: `http://127.0.0.1:${endpointUrl.port}`,
        browserVersion: version.product ?? version.revision ?? null,
        close: () => client.close()
      };
      if (existing.browserVersion) return existing;
    }
    await client.close().catch(() => {});
  }

  if (profileLocked) {
    throw new Error("Chrome owns this profile but its DevTools endpoint is not reachable. Refusing to remove live profile metadata or launch a second Chrome.");
  }

  // A validly shaped endpoint with no owning Chrome is stale. Only this
  // confirmed inactive case may clear it before a fresh launch.
  await rm(portFile, { force: true });
  return null;
}

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
 *   runner-owned browsers an HTTP(S) URL is a safe startup
 *   target; it is chosen from the validated environment binding by the
 *   caller, never from a diagnostic adapter URL.
 * @param {boolean} [options.headed=true] - Headed is the default;
 *   headless requires an explicit opt-in (headed: false).
 * @param {"current-display"|"xvfb"} [options.displayMode] - Display
 *   source recorded for the run. This module never overwrites DISPLAY;
 *   the caller/operator provides a valid display session for headed runs.
 * @param {AbortSignal} [options.signal] - Cancellation during launch.
 * @param {string|null} [options.userDataDir] - Optional explicit Chrome profile directory.
 * @param {boolean} [options.preserveProfile=false] - Keep an explicit profile for later runs.
 * @param {boolean} [options.reuseExisting=false] - Allow a live profile to be reused without page control.
 * @param {boolean} [options.keepBrowserOpen=false] - Detach after startup while preserving the explicit profile and Chrome process.
 * @param {string|null} [options.attachExistingTargetId=null] - Explicit exact page target to reattach without navigation.
 * @param {string[]} [options.allowedExistingOrigins=[]] - Exact origins authorized for an existing target.
 */
export async function launchOwnedChrome({
  initialUrl,
  headed = true,
  displayMode = "current-display",
  signal,
  userDataDir = null,
  preserveProfile = false,
  reuseExisting = false,
  keepBrowserOpen = false,
  attachExistingTargetId = null,
  allowedExistingOrigins = []
} = {}) {
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

  if (preserveProfile && !userDataDir) {
    throw new Error("preserveProfile requires an explicit userDataDir.");
  }
  if (keepBrowserOpen && (!userDataDir || !preserveProfile)) {
    throw new Error("keepBrowserOpen requires an explicit persistent profile.");
  }
  if (attachExistingTargetId !== null && (typeof attachExistingTargetId !== "string" || !attachExistingTargetId.trim())) {
    throw new Error("attachExistingTargetId must be a non-empty exact page target ID.");
  }
  if (attachExistingTargetId !== null && (reuseExisting || !userDataDir || !preserveProfile || !Array.isArray(allowedExistingOrigins) || allowedExistingOrigins.length === 0)) {
    throw new Error("Attaching an existing target requires a persistent profile, an exact target ID, and an origin allowlist; it cannot be combined with open-only reuse.");
  }
  const existingOriginAllowlist = new Set();
  for (const value of allowedExistingOrigins) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("Existing target origin allowlists must contain exact HTTP(S) origins."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) {
      throw new Error("Existing target origin allowlists must contain exact HTTP(S) origins.");
    }
    existingOriginAllowlist.add(parsed.origin);
  }
  let profileDir;
  if (userDataDir) {
    profileDir = resolve(userDataDir);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(profileDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Chrome userDataDir must be a real directory, not a symlink or file.");
    }
    if (await realpath(profileDir) !== profileDir) {
      throw new Error("Chrome userDataDir resolves through a symlink; refusing to use it.");
    }
    await chmod(profileDir, 0o700);
  } else {
    profileDir = await mkdtemp(join(tmpdir(), "activetab-owned-chrome-"));
  }
  const existingChrome = await connectExistingChrome(profileDir);
  if (existingChrome) {
    if (attachExistingTargetId !== null) {
      let session = null;
      try {
        const targets = await listTargets(existingChrome.endpoint);
        const existingTarget = targets.find(target => target.id === attachExistingTargetId && target.type === "page") ?? null;
        if (!existingTarget) throw new Error(`The exact existing page target '${attachExistingTargetId}' is unavailable.`);
        let origin = null;
        try { origin = new URL(existingTarget.url).origin; } catch { /* rejected below */ }
        if (!origin || !existingOriginAllowlist.has(origin)) {
          throw new Error(`The exact existing page target is outside the authorized origin allowlist (${origin ?? "unavailable"}).`);
        }
        const target = await resolveAuthorizedTarget(existingChrome.endpoint, attachExistingTargetId, attachExistingTargetId);
        target.browserClient = existingChrome.client;
        target.ownsBrowserClient = true;
        session = await new BrowserSession(target).attach();
        session.persistent = true;

        // Recheck after CDP attachment to close the target-list/attach race.
        const observation = await session.observe();
        let observedOrigin = null;
        try { observedOrigin = new URL(observation?.page?.url ?? "").origin; } catch { /* rejected below */ }
        if (!observedOrigin || !existingOriginAllowlist.has(observedOrigin)) {
          throw new Error(`The existing page changed to an unauthorized origin while attaching (${observedOrigin ?? "unavailable"}).`);
        }
        let closed = false;
        let closeResult = null;
        return {
          session,
          endpoint: existingChrome.endpoint,
          targetId: attachExistingTargetId,
          chromeProcess: null,
          browserVersion: existingChrome.browserVersion,
          launchMode: "reattached to exact existing headed Chrome target",
          displayMode,
          profileDir,
          readiness: { phase: "reattached-existing-target", targetId: attachExistingTargetId, origin: observedOrigin },
          reusedExisting: false,
          attachedExisting: true,
          signal,
          async close() {
            if (closed) return closeResult;
            closed = true;
            await session.close().catch(() => {});
            closeResult = { graceful: true, forced: false, exitCode: null, profileRemoved: false, profilePreserved: true, browserPreserved: true, error: null };
            return closeResult;
          }
        };
      } catch (error) {
        if (session) await session.close().catch(() => {});
        else await existingChrome.close().catch(() => {});
        throw error;
      }
    }
    if (!reuseExisting) {
      await existingChrome.close().catch(() => {});
      throw new Error("Chrome is already running with this profile. Refusing to navigate or replace the open browser; select its exact authorized page with attachExistingTargetId, or use open-only reuse.");
    }
    let pageTargets;
    try { pageTargets = await listTargets(existingChrome.endpoint); }
    catch (error) {
      await existingChrome.close().catch(() => {});
      throw error;
    }
    let closed = false;
    let closeResult = null;
    return {
      session: null,
      endpoint: existingChrome.endpoint,
      targetId: null,
      chromeProcess: null,
      browserVersion: existingChrome.browserVersion,
      launchMode: "reused existing headed Chrome",
      displayMode,
      profileDir,
      readiness: { phase: "reused-existing-browser" },
      reusedExisting: true,
      pageTargets,
      signal,
      async close() {
        if (closed) return closeResult;
        closed = true;
        await existingChrome.close().catch(() => {});
        closeResult = { graceful: true, forced: false, exitCode: null, profileRemoved: false, profilePreserved: true, browserPreserved: true, error: null };
        return closeResult;
      }
    };
  }

  if (attachExistingTargetId !== null) {
    throw new Error("The requested exact target is not running in the selected persistent profile. Refusing to launch a replacement browser or apply its startup URL.");
  }

  // connectExistingChrome has proved the profile is inactive before stale
  // DevTools metadata is cleared. Never unlink an endpoint belonging to a
  // running Chrome: its process-singleton would otherwise forward the
  // startup URL into that browser and exit without publishing a new port.
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
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
    chromeProcess = spawn(chromePath, args, {
      stdio: keepBrowserOpen ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "pipe"],
      ...(keepBrowserOpen ? { detached: true } : {})
    });
    if (keepBrowserOpen) chromeProcess.unref();
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
    // Select the target that matches the intended startup URL origin.
    // Chrome may create other page targets (e.g. NTP) during launch; the
    // first page target is not necessarily the intended one.
    let expectedOrigin = null;
    try { expectedOrigin = new URL(startupUrl).origin; } catch { /* validated above */ }
    const ownedTarget = targets?.find(t => t.type === "page" && (
      (() => { try { return new URL(t.url).origin === expectedOrigin; } catch { return false; } })()
    )) ?? targets?.find(t => t.type === "page");
    if (!ownedTarget) {
      await browserClient.close().catch(() => {});
      throw new Error("Chrome did not expose a page target owned by this invocation.");
    }
    targetId = ownedTarget.id;
    const targetUrlOrigin = (() => { try { return new URL(ownedTarget.url).origin; } catch { return null; } })();
    if (expectedOrigin && targetUrlOrigin !== expectedOrigin) {
      // Do not adopt a target that did not load the intended entry origin.
      await browserClient.close().catch(() => {});
      throw new Error(`Chrome launched to unexpected origin '${targetUrlOrigin ?? ownedTarget.url}' instead of '${expectedOrigin}'. No target was adopted.`);
    }
    const target = await resolveAuthorizedTarget(endpoint, targetId, targetId);
    target.browserClient = browserClient;
    target.ownsBrowserClient = true;
    session = await new BrowserSession(target).attach();
    session.persistent = preserveProfile;
    readiness = { phase: "attached", targetId };

    // 7. Verify the browser actually loaded the intended URL.
    const deadline = Date.now() + 20_000;
    let observed = null;
    while (Date.now() < deadline) {
      observed = await session.observe().catch(() => null);
      const url = observed?.page?.url;
      if (url && url !== "about:blank" && url !== "chrome-error://chromewebdata/") {
        try {
          const origin = new URL(url).origin;
          if (expectedOrigin && origin === expectedOrigin) break;
          if (!expectedOrigin) break;
        } catch { /* keep waiting */ }
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const observedUrl = observed?.page?.url ?? null;
    const observedOrigin = (() => { try { return new URL(observedUrl ?? "").origin; } catch { return null; } })();
    if (expectedOrigin && observedOrigin !== expectedOrigin) {
      throw new Error(`Chrome loaded unexpected origin '${observedOrigin ?? observedUrl}' instead of '${expectedOrigin}'.`);
    }
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
    if (!preserveProfile) {
      try { await rm(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    throw error;
  }

  /**
   * Idempotent cleanup (P0-1): stop admission, cancel in-progress owned
   * actions, close the CDP session, request graceful termination, wait for
   * the owned process, force-terminate only that process if necessary,
   * remove a disposable profile or preserve an explicit reusable profile,
   * and record the shutdown outcome.
   */
  async function close() {
    if (closed) return closeResult;
    closed = true;
    const outcome = { graceful: false, forced: false, exitCode: null, profileRemoved: false, profilePreserved: preserveProfile, browserPreserved: false, error: null };
    try {
      // Close the CDP session first (this also detaches owned targets).
      if (session) await session.close().catch(() => {});
      if (keepBrowserOpen) {
        chromeProcess?.unref();
        outcome.graceful = true;
        outcome.browserPreserved = true;
      } else if (chromeProcess && chromeProcess.exitCode === null) {
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
      if (!preserveProfile) {
        try { await rm(profileDir, { recursive: true, force: true }); outcome.profileRemoved = true; }
        catch (error) { outcome.error = outcome.error ?? String(error?.message ?? error).slice(0, 300); }
      }
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
    reusedExisting: false,
    signal,
    close
  };
}
