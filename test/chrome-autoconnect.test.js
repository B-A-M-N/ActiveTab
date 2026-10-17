import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChromeUserDataDir, listChromeTargets, readChromeDebugEndpoint, resolveChromeTarget } from "../src/browser/chrome-autoconnect.js";

test("Chrome auto-connect resolves profile directories per channel and platform", () => {
  assert.equal(defaultChromeUserDataDir({ home: "/home/test", platform: "linux" }), "/home/test/.config/google-chrome");
  assert.equal(defaultChromeUserDataDir({ home: "/Users/test", platform: "darwin", channel: "canary" }), "/Users/test/Library/Application Support/Google/Chrome Canary");
  assert.equal(defaultChromeUserDataDir({ platform: "win32", localAppData: "C:/Users/test/AppData/Local" }), "C:/Users/test/AppData/Local/Google/Chrome/User Data");
});

test("Chrome auto-connect accepts only a local browser WebSocket endpoint file", async t => {
  const dir = await mkdtemp(join(tmpdir(), "activetab-autoconnect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "DevToolsActivePort"), "43127\n/devtools/browser/AbC_123-token\n", { mode: 0o600 });
  assert.deepEqual(await readChromeDebugEndpoint(dir), {
    webSocketDebuggerUrl: "ws://127.0.0.1:43127/devtools/browser/AbC_123-token",
    filePath: join(dir, "DevToolsActivePort")
  });
  await writeFile(join(dir, "DevToolsActivePort"), "43127\n/devtools/browser/AbC?token\n", { mode: 0o600 });
  await assert.rejects(readChromeDebugEndpoint(dir), /invalid format/);
});

test("Chrome page attach refuses an unconfirmed target before sending CDP commands", async () => {
  let calls = 0;
  const connection = { client: { send: async () => { calls++; throw new Error("should not be called"); } } };
  await assert.rejects(resolveChromeTarget(connection, "page-a", "page-b"), /authorization/);
  assert.equal(calls, 0);
});

test("tab listings omit URL credentials, query values, and fragments", async () => {
  const connection = { client: { send: async () => ({ targetInfos: [
    { type: "page", targetId: "page-a", title: "Example", url: "https://user:secret@example.test/path?token=private#section" }
  ] }) } };
  assert.deepEqual(await listChromeTargets(connection), [{
    id: "page-a", title: "Example", url: "https://example.test/path", type: "page"
  }]);
});
