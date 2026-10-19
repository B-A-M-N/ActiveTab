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
import { listTargets, resolveAuthorizedTarget, resolveOwnedBlankTarget } from "./targets.js";
import { BrowserSession } from "./session.js";
import { CdpClient } from "../cdp/client.js";
import { readChromeDebugEndpoint } from "./chrome-autoconnect.js";
import { createBrowserEnvironmentProfile, initializeOwnedBrowserEnvironment } from "./browserEnvironment.js";
import { resolveChromeWindowPosition } from "./chromeWindowPlacement.js";

export { parseChromeWindowPosition } from "./chromeWindowPlacement.js";

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

async function applyOwnedWindowPosition(client, targetId, position) {
  const current = await client.send("Browser.getWindowForTarget", { targetId });
  if (!Number.isInteger(current.windowId)) throw new Error("Chrome did not expose the owned window ID for display placement.");
  await client.send("Browser.setWindowBounds", {
    windowId: current.windowId,
    bounds: { left: position.x, top: position.y, windowState: "normal" }
  });
  const moved = await client.send("Browser.getWindowForTarget", { targetId });
  if (moved.bounds?.left !== position.x || moved.bounds?.top !== position.y) {
    throw new Error("Chrome did not place the owned window at the requested desktop coordinates.");
  }
  return moved.bounds;
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
 * @param {object} [options.environmentProfile] - Explicit compatibility settings for a new owned target only.
 * @param {string} [options.windowPosition] - Explicit Chrome desktop coordinates; otherwise uses the display environment settings.
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
  allowedExistingOrigins = [],
  environmentProfile: requestedEnvironmentProfile = {},
  windowPosition: requestedWindowPosition
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
  const environmentProfile = createBrowserEnvironmentProfile(requestedEnvironmentProfile);
  const windowPosition = resolveChromeWindowPosition({ position: requestedWindowPosition });
  const environmentConfigured = Boolean(environmentProfile.locale || environmentProfile.timeZone
    || environmentProfile.viewport || environmentProfile.geolocation);
  if (environmentConfigured && (reuseExisting || attachExistingTargetId !== null || keepBrowserOpen)) {
    throw new Error("Browser environment overrides apply only to a newly created owned target, never an attached or persistent browser.");
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
        const observation = await session.observe({ profile: "lightweight" });
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
  if (environmentProfile.locale) args.push(`--lang=${environmentProfile.locale}`);
  if (process.getuid?.() === 0 || process.env.ACTIVETAB_CHROME_NO_SANDBOX === "1") {
    // --no-sandbox only when the OS requires it (root containers) or the
    // operator explicitly opts in; never a silent default.
    args.push("--no-sandbox");
  }
  if (windowPosition) args.push(`--window-position=${windowPosition.x},${windowPosition.y}`);
  // Start at an owned blank document so explicit settings take effect before
  // the application receives its first request.
  args.push("about:blank");

  const launchMode = headed === false ? "headless (explicit opt-in)" : "headed";
  let endpoint = null;
  let browserVersion = null;
  let targetId = null;
  let windowBounds = null;
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
    // Select only the blank page created for this invocation. A new profile
    // has no pre-existing application target to adopt.
    let expectedOrigin = null;
    try { expectedOrigin = new URL(startupUrl).origin; } catch { /* validated above */ }
    const ownedTarget = targets?.find(t => t.type === "page" && t.url === "about:blank");
    if (!ownedTarget) {
      await browserClient.close().catch(() => {});
      throw new Error("Chrome did not expose the blank page target owned by this invocation.");
    }
    targetId = ownedTarget.id;
    const target = await resolveOwnedBlankTarget(endpoint, targetId, chromeProcess);
    target.browserClient = browserClient;
    target.ownsBrowserClient = true;
    session = await new BrowserSession(target).attach();
    session.persistent = preserveProfile;
    readiness = { phase: "attached", targetId };

    if (windowPosition && headed !== false) {
      windowBounds = await applyOwnedWindowPosition(browserClient, targetId, windowPosition);
      readiness = { phase: "window-positioned", targetId, windowBounds };
    }

    const browserEnvironment = await initializeOwnedBrowserEnvironment(session.client, {
      browserVersion,
      headed,
      profile: environmentProfile,
      startupOrigin: expectedOrigin
    });
    readiness = { phase: "environment-initialized", targetId };

    const navigation = await session.client.send("Page.navigate", { url: startupUrl });
    if (navigation?.errorText) throw new Error(`Chrome could not navigate to the validated startup URL: ${String(navigation.errorText).slice(0, 200)}`);

    // 7. Verify the browser actually loaded the intended URL.
    const deadline = Date.now() + 20_000;
    let observed = null;
    while (Date.now() < deadline) {
      observed = await session.observe({ profile: "lightweight" }).catch(() => null);
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
    if (windowPosition && headed !== false) {
      const positioned = await browserClient.send("Browser.getWindowForTarget", { targetId });
      if (positioned.bounds?.left !== windowPosition.x || positioned.bounds?.top !== windowPosition.y) {
        throw new Error("The owned Chrome window moved away from the requested desktop position during startup.");
      }
      windowBounds = positioned.bounds;
    }
    readiness = { phase: "loaded", url: observedUrl, environment: browserEnvironment };

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
    if (session) await session.close().catch(() => {});
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
    const outcome = { graceful: false, forced: false, processStopped: false, exitCode: null, profileRemoved: false, profilePreserved: preserveProfile, browserPreserved: false, error: null };
    const processStopped = () => Boolean(chromeProcess
      && (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null));
    const waitForExit = async timeoutMs => {
      if (processStopped()) return true;
      await Promise.race([
        once(chromeProcess, "exit").catch(() => {}),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);
      return processStopped();
    };
    try {
      if (keepBrowserOpen) {
        if (session) await session.close().catch(() => {});
        chromeProcess?.unref();
        outcome.graceful = true;
        outcome.browserPreserved = true;
      } else {
        // Ask the owned browser to close through its browser-level CDP client
        // before falling back to process signals. This avoids routine forced
        // termination and lets Chrome flush its temporary profile cleanly.
        if (session && !processStopped()) {
          await Promise.race([
            Promise.resolve(session.target?.browserClient?.send?.("Browser.close")).catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 2_000))
          ]);
        }
        if (session) await session.close().catch(() => {});
        let stopped = processStopped();
        if (chromeProcess && !stopped) stopped = await waitForExit(5_000);
        if (chromeProcess && !stopped) {
          chromeProcess.kill("SIGTERM");
          stopped = await waitForExit(5_000);
        }
        if (chromeProcess && !stopped) {
          chromeProcess.kill("SIGKILL");
          outcome.forced = true;
          stopped = await waitForExit(3_000);
        }
        outcome.processStopped = stopped;
        outcome.graceful = stopped && !outcome.forced;
        outcome.exitCode = chromeProcess.exitCode;
        if (chromeProcess && !stopped) outcome.error = "chrome_exit_unconfirmed";
      }
    } catch (error) {
      outcome.error = String(error?.message ?? error).slice(0, 300);
    } finally {
      if (chromeProcess && processStopped()) outcome.processStopped = true;
      if (!preserveProfile && (!chromeProcess || outcome.processStopped)) {
        try { await rm(profileDir, { recursive: true, force: true }); outcome.profileRemoved = true; }
        catch (error) { outcome.error = outcome.error ?? String(error?.message ?? error).slice(0, 300); }
      } else if (!preserveProfile && !outcome.processStopped) {
        outcome.error = outcome.error ?? "chrome_exit_unconfirmed";
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
    windowBounds,
    browserEnvironment: readiness.environment ?? null,
    launchMode,
    displayMode,
    profileDir,
    readiness,
    reusedExisting: false,
    signal,
    close
  };
}
