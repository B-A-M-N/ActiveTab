import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function stateDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.ACTIVETAB_STATE_DIR) {
    if (!isAbsolute(env.ACTIVETAB_STATE_DIR)) throw new Error("ACTIVETAB_STATE_DIR must be an absolute path.");
    return env.ACTIVETAB_STATE_DIR;
  }
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required to locate ActiveTab state on Windows.");
    return join(env.LOCALAPPDATA, "ActiveTab");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "ActiveTab");
  const stateHome = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(stateHome, "activetab");
}

export function brokerSocketPath(options) {
  return join(stateDirectory(options), "extension-broker.sock");
}
