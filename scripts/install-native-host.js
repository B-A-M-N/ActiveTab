import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ORIGIN } from "../src/extension/broker.js";

const NAME = "com.activetab.bridge";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "native-host", "activetab-native-host");
const args = process.argv.slice(2);
let apply = false;
let browser = "chrome";
let customDir;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--apply") apply = true;
  else if (arg === "--dry-run") apply = false;
  else if (arg === "--browser" && args[index + 1]) browser = args[++index];
  else if (arg === "--manifest-dir" && args[index + 1]) customDir = args[++index];
  else throw new Error("Usage: node scripts/install-native-host.js [--browser chrome|chromium] [--manifest-dir ABSOLUTE_DIR] [--dry-run|--apply]");
}
if (!["chrome", "chromium"].includes(browser)) throw new Error("--browser must be chrome or chromium.");
if (customDir && !isAbsolute(customDir)) throw new Error("--manifest-dir must be absolute.");
if (platform() === "win32") throw new Error("Windows Native Messaging registration is not implemented yet.");

const configRoot = process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME)
  ? process.env.XDG_CONFIG_HOME
  : join(homedir(), ".config");
const browserRoot = platform() === "darwin"
  ? join(homedir(), "Library", "Application Support", browser === "chrome" ? "Google/Chrome" : "Chromium")
  : join(configRoot, browser === "chrome" ? "google-chrome" : "chromium");
const manifestDir = customDir ?? join(browserRoot, "NativeMessagingHosts");
const manifestPath = join(manifestDir, `${NAME}.json`);
const manifest = {
  name: NAME,
  description: "ActiveTab local Chrome DevTools Protocol bridge",
  path: launcher,
  type: "stdio",
  allowed_origins: [EXTENSION_ORIGIN]
};
const contents = `${JSON.stringify(manifest, null, 2)}\n`;
const current = await lstat(manifestPath).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
if (current) {
  if (!current.isFile() || current.isSymbolicLink()) throw new Error("Refusing to replace a non-regular Native Messaging host manifest.");
  const existing = await readFile(manifestPath, "utf8");
  if (existing !== contents) throw new Error(`A different Native Messaging manifest already exists at ${manifestPath}; it was left untouched.`);
  process.stdout.write(`Already configured: ${manifestPath}\n`);
} else if (!apply) {
  process.stdout.write(`Dry run. Would create ${manifestPath} with:\n${contents}`);
} else {
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(manifestDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("Native Messaging host directory must be a real directory.");
  await chmod(manifestDir, 0o700);
  await writeFile(manifestPath, contents, { flag: "wx", mode: 0o600 });
  process.stdout.write(`Installed: ${manifestPath}\n`);
}
