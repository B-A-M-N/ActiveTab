import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../cdp/client.js";
import { sanitizeUrl } from "./urlPrivacy.js";

const CHANNEL_DIRS = {
  stable: { linux: ".config/google-chrome", darwin: "Library/Application Support/Google/Chrome", win32: "Google/Chrome/User Data" },
  beta: { linux: ".config/google-chrome-beta", darwin: "Library/Application Support/Google/Chrome Beta", win32: "Google/Chrome Beta/User Data" },
  dev: { linux: ".config/google-chrome-unstable", darwin: "Library/Application Support/Google/Chrome Dev", win32: "Google/Chrome Dev/User Data" },
  canary: { linux: ".config/google-chrome-canary", darwin: "Library/Application Support/Google/Chrome Canary", win32: "Google/Chrome SxS/User Data" },
  chromium: { linux: ".config/chromium", darwin: "Library/Application Support/Chromium", win32: "Chromium/User Data" }
};

export function defaultChromeUserDataDir({ channel = "stable", platform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  const paths = CHANNEL_DIRS[channel];
  if (!paths) throw new Error("Unsupported Chrome channel: " + channel + ".");
  if (platform === "win32") {
    if (!localAppData) throw new Error("LOCALAPPDATA is required to locate Chrome on Windows.");
    return join(localAppData, paths.win32);
  }
  if (platform !== "linux" && platform !== "darwin") throw new Error("Unsupported platform for Chrome auto-connect: " + platform + ".");
  return join(home, paths[platform]);
}

export async function readChromeDebugEndpoint(userDataDir = defaultChromeUserDataDir()) {
  const filePath = join(userDataDir, "DevToolsActivePort");
  const stat = await lstat(filePath).catch(error => {
    if (error.code === "ENOENT") throw new Error("Chrome remote debugging is not enabled for this profile. Open chrome://inspect/#remote-debugging and enable it first.");
    throw new Error("Could not inspect Chrome's remote debugging endpoint file (" + (error.code ?? "filesystem error") + ").");
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Chrome's remote debugging endpoint must be a regular file.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Chrome's remote debugging endpoint belongs to a different local user.");
  const contents = await readFile(filePath, "utf8");
  const [portText, websocketPath] = contents.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(websocketPath ?? "")) {
    throw new Error("Chrome's remote debugging endpoint file has an invalid format.");
  }
  return { webSocketDebuggerUrl: "ws://127.0.0.1:" + port + websocketPath, filePath };
}

export async function connectChromeAuto({ userDataDir = process.env.ACTIVETAB_CHROME_USER_DATA_DIR ?? defaultChromeUserDataDir(), commandTimeoutMs = 120_000 } = {}) {
  const endpoint = await readChromeDebugEndpoint(userDataDir);
  const client = await new CdpClient(endpoint.webSocketDebuggerUrl, { commandTimeoutMs }).connect();
  return { client, userDataDir, close: () => client.close() };
}

function safeDisplayUrl(value) {
  return sanitizeUrl(value);
}

export async function listChromeTargets(connection) {
  const { targetInfos = [] } = await connection.client.send("Target.getTargets");
  return targetInfos.filter(target => target?.type === "page" && typeof target.targetId === "string").map(target => ({
    id: target.targetId,
    title: String(target.title ?? ""),
    url: safeDisplayUrl(target.url ?? ""),
    type: "page"
  }));
}

export async function resolveChromeTarget(connection, targetId, confirmedTargetId) {
  if (!targetId || targetId !== confirmedTargetId) throw new Error("Explicit target authorization is required and must match the selected target id.");
  const { targetInfo } = await connection.client.send("Target.getTargetInfo", { targetId });
  if (targetInfo?.targetId !== targetId || targetInfo.type !== "page") throw new Error("The selected Chrome page target is no longer available.");
  const pageUrl = new URL(targetInfo.url);
  if (!new Set(["http:", "https:"]).has(pageUrl.protocol)) throw new Error("Only HTTP(S) page targets can be controlled.");
  return { id: targetInfo.targetId, title: String(targetInfo.title ?? ""), url: safeDisplayUrl(targetInfo.url), type: "page", endpoint: "chrome-auto-connect", browserClient: connection.client };
}
