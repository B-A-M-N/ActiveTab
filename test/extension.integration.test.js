import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { BrowserSession } from "../src/browser/session.js";
import { ExtensionBroker, EXTENSION_ID } from "../src/extension/broker.js";
import { NavigationEngine } from "../src/navigation/engine.js";
import { DeterministicPlanner } from "../src/navigation/planner.js";
import { TaskJournal } from "../src/state/journal.js";
import { WorkflowStore } from "../src/state/workflows.js";
import { startBenchmarkSites } from "./fixtures/benchmark-sites.js";

const chromePath = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const projectRoot = new URL("../", import.meta.url).pathname;
const installer = join(projectRoot, "scripts", "install-native-host.js");

function countingPlanner() {
  const local = new DeterministicPlanner();
  return {
    calls: 0,
    async plan(...args) { this.calls++; return await local.plan(...args); }
  };
}

class CdpPipeClient {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #buffer = "";
  #closed = false;

  constructor(chrome) {
    this.input = chrome.stdio[4];
    this.output = chrome.stdio[3];
    this.input.setEncoding("utf8");
    this.input.on("data", chunk => this.#onData(chunk));
    this.input.on("end", () => this.#close(new Error("Chrome CDP pipe closed.")));
    this.input.on("error", error => this.#close(error));
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}, sessionId = null) {
    if (this.#closed) return Promise.reject(new Error("Chrome CDP pipe is closed."));
    const id = this.#nextId++;
    const body = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP pipe command timed out: ${method}`));
      }, 20_000);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.output.write(`${body}\0`, error => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async close() {
    this.#close();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let boundary;
    while ((boundary = this.#buffer.indexOf("\0")) >= 0) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      let message;
      try { message = JSON.parse(frame); } catch { continue; }
      if (Number.isInteger(message.id)) {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP pipe command failed: ${pending.method}: ${message.error.message ?? "unknown error"}`));
        else pending.resolve(message.result ?? {});
      } else if (typeof message.method === "string") {
        for (const listener of this.#listeners.get(message.method) ?? []) {
          try { listener(message.params ?? {}, message.sessionId ?? null); } catch { /* Event consumers are isolated. */ }
        }
      }
    }
  }

  #close(error = new Error("Chrome CDP pipe closed.")) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function startProcessGroupSampler() {
  const rootPids = new Set();
  const cpuTicksByProcess = new Map();
  const clockTicks = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout?.trim()) || 100;
  let peakAggregateRssBytes = 0;
  let samplingError;
  let sampling = false;
  let stopPromise;
  const sample = async () => {
    if (sampling || process.platform !== "linux") return;
    sampling = true;
    let aggregateRssBytes = 0;
    const visit = async (rootPid, pid, visited) => {
      if (visited.has(pid)) return;
      visited.add(pid);
      try {
        const [stat, status, children] = await Promise.all([
          readFile(`/proc/${pid}/stat`, "utf8"),
          readFile(`/proc/${pid}/status`, "utf8"),
          readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => "")
        ]);
        const closeParen = stat.lastIndexOf(")");
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
        const cpuTicks = Number(fields[11]) + Number(fields[12]);
        if (Number.isFinite(cpuTicks)) {
          const key = `${rootPid}:${pid}`;
          cpuTicksByProcess.set(key, Math.max(cpuTicksByProcess.get(key) ?? 0, cpuTicks));
        }
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]);
        if (Number.isFinite(rssKb)) aggregateRssBytes += rssKb * 1024;
        for (const childPid of children.trim().split(/\s+/).filter(Boolean)) await visit(rootPid, childPid, visited);
      } catch { /* Processes may exit between parent and child snapshots. */ }
    };
    try {
      for (const rootPid of rootPids) await visit(rootPid, rootPid, new Set());
      peakAggregateRssBytes = Math.max(peakAggregateRssBytes, aggregateRssBytes);
    } catch (error) {
      samplingError = String(error.message).slice(0, 200);
    } finally { sampling = false; }
  };
  const timer = setInterval(() => { void sample(); }, 1000);
  timer.unref();
  return {
    add(pid) { rootPids.add(String(pid)); void sample(); },
    stop() {
      if (stopPromise) return stopPromise;
      clearInterval(timer);
      stopPromise = (async () => {
        await sample();
        return {
          processGroups: rootPids.size,
          sampledPeakSummedRssMb: Math.round(peakAggregateRssBytes / 1024 / 1024),
          approximateCumulativeCpuSeconds: Number(([...cpuTicksByProcess.values()].reduce((sum, value) => sum + value, 0) / clockTicks).toFixed(2)),
          clockTicksPerSecond: clockTicks,
          samplingIntervalMs: 1000,
          ...(process.platform !== "linux" ? { samplingError: "procfs sampling is available only on Linux" } : {}),
          ...(samplingError ? { samplingError } : {}),
          caveat: "asynchronous procfs snapshots can miss short-lived children and transient RSS peaks; summed RSS double-counts shared pages"
        };
      })();
      return stopPromise;
    }
  };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const completed = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]);
  clearTimeout(timer);
  return completed;
}

async function attachThroughPopup(client, broker, extensionId, tabTargetId, popupAlreadyOpened = false) {
  if (!popupAlreadyOpened) await client.send("Extensions.triggerAction", { id: extensionId, targetId: tabTargetId });
  const popupDeadline = Date.now() + 10_000;
  let popupTarget;
  while (Date.now() < popupDeadline) {
    const { targetInfos = [] } = await client.send("Target.getTargets");
    popupTarget = targetInfos.find(target => target.type === "page" && target.url === `chrome-extension://${extensionId}/popup.html`);
    if (popupTarget) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(popupTarget, "Chrome opens the extension action popup for the selected tab");
  const { sessionId } = await client.send("Target.attachToTarget", { targetId: popupTarget.targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const readyDeadline = Date.now() + 10_000;
  let bounds;
  while (Date.now() < readyDeadline) {
    const { result } = await client.send("Runtime.evaluate", {
      expression: "(()=>{const e=document.querySelector('#attach');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
      returnByValue: true
    }, sessionId);
    if (result?.value) { bounds = result.value; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(bounds, "the selected tab popup offers an explicit Attach control");
  const attached = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("A popup Attach click did not authorize the selected tab.")), 8_000);
    broker.once("attached", target => { clearTimeout(timer); resolve(target); });
  });
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bounds.x, y: bounds.y }, sessionId);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bounds.x, y: bounds.y, button: "left", clickCount: 1 }, sessionId);
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bounds.x, y: bounds.y, button: "left", clickCount: 1 }, sessionId);
  const target = await attached;
  await client.send("Target.closeTarget", { targetId: popupTarget.targetId }).catch(() => {});
  return target;
}

test("visible extension attaches, observes, navigates, and recovers its disposable Chrome tab", { timeout: 120_000 }, async t => {
  if (process.env.ACTIVETAB_VISIBLE_CHROME !== "1") { t.skip("set ACTIVETAB_VISIBLE_CHROME=1 to launch the real Chrome window for extension integration"); return; }
  if (process.env.ACTIVETAB_HEADLESS === "1") { t.skip("the visible extension fixture requires headed Chrome; unset ACTIVETAB_HEADLESS=1 to run it"); return; }
  if (!process.env.DISPLAY) { t.skip("extension integration requires a visible desktop display"); return; }
  let chrome;
  let connection;
  let session;
  let secondSession;
  let secondPageTargetId;
  let broker;
  let site;
  let childSite;
  let benchmarkSites;
  let root;
  let stderr = "";
  const benchmarkRuns = [];
  const processFamilySampler = startProcessGroupSampler();
  const recordBenchmark = (name, startedAt, result, oracle) => {
    benchmarkRuns.push({
      name,
      oraclePassed: Boolean(oracle(result)),
      actions: Number(result.attempts ?? 0),
      recoveries: Number(result.recoveries ?? 0),
      elapsedMs: Math.round(performance.now() - startedAt),
      plannerCalls: Number(result.plannerCalls ?? 0)
    });
  };
  const runMeasured = async (name, run, oracle) => {
    const startedAt = performance.now();
    const result = await run();
    recordBenchmark(name, startedAt, result, oracle);
    return result;
  };
  try {
    root = await mkdtemp(join(tmpdir(), "activetab-extension-chrome-"));
    const profileDir = join(root, "profile");
    const stateDir = join(root, "state");
    const manifestDir = join(profileDir, "NativeMessagingHosts");
    const install = spawnSync(process.execPath, [installer, "--apply", "--manifest-dir", manifestDir], { encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);

    let parentPort;
    let authenticatedProfileRequests = 0;
    childSite = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>Cross-origin controls</title><h1>Cross-origin controls</h1><button onclick="parent.postMessage({kind:'frame-settings'}, '*')">Open frame settings</button><iframe src="http://127.0.0.1:${parentPort}/nested"></iframe>`);
    });
    childSite.listen(0, "127.0.0.1");
    await once(childSite, "listening");
    const childPort = childSite.address().port;
    site = createServer((request, response) => {
      if (request.url?.startsWith("/fixture-login")) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": "activetab-fixture-session=valid; HttpOnly; SameSite=Lax; Path=/"
        });
        response.end("<!doctype html><title>Signed-in session ready</title><h1>Session ready</h1><a href='/private-profile'>Open private profile</a>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (request.url?.startsWith("/private-profile")) {
        const authenticated = (request.headers.cookie ?? "").split(";").some(item => item.trim() === "activetab-fixture-session=valid");
        if (authenticated) authenticatedProfileRequests++;
        response.end(authenticated
          ? "<!doctype html><title>Private profile</title><h1>Private profile</h1><a href='/details'>Open details page</a>"
          : "<!doctype html><title>Sign in required</title><h1>Sign in to continue</h1>");
      } else if (request.url?.startsWith("/details")) {
        response.end("<!doctype html><title>Details</title><h1>Details</h1>");
      } else if (request.url?.startsWith("/account/security")) {
        response.end("<!doctype html><title>Security settings</title><h1>Security settings</h1>");
      } else if (request.url?.startsWith("/account")) {
        response.end("<!doctype html><title>Account</title><h1>Account</h1><a id=security-link href='/account/security'>Security settings</a>");
      } else if (request.url?.startsWith("/nested")) {
        response.end("<!doctype html><title>Nested controls</title><h1>Nested controls</h1><button onclick=\"parent.parent.postMessage({kind:'nested-preferences'}, '*')\">Open nested preferences</button>");
      } else {
        response.end(`<!doctype html><title>Extension start</title><h1>Extension start</h1><button id=next onclick="location.href='/details'">Open details</button><a id=account-link href='/account'>Open account</a><button id=delayed-render onclick="setTimeout(()=>{history.pushState(null,'','/delayed-dashboard');document.querySelector('h1').textContent='Delayed dashboard';document.title='Delayed dashboard'},350)">Open delayed dashboard</button><form id=search-form onsubmit="event.preventDefault();document.querySelector('h1').textContent='Search results';document.title='Search results'"><label for=search-query>Search products</label><input id=search-query type=search><button type=submit>Search</button></form><section><h2>Invoices</h2><div id=invoice-list role=list aria-label='Invoice list' style='height:168px;overflow-y:auto;position:relative;border:1px solid #999'><div id=invoice-spacer style='height:1120px;position:relative'></div></div></section><iframe src="http://localhost:${childPort}/cross?token=private-frame"></iframe><script>addEventListener('message',event=>{if(event.origin==='http://localhost:${childPort}'&&event.data?.kind==='frame-settings'){document.querySelector('h1').textContent='Frame settings';document.title='Frame settings'}if(event.origin==='http://127.0.0.1:${parentPort}'&&event.data?.kind==='nested-preferences'){document.querySelector('h1').textContent='Nested preferences';document.title='Nested preferences'}});(()=>{const list=document.querySelector('#invoice-list'),space=document.querySelector('#invoice-spacer'),rows=Array.from({length:6},()=>{const button=document.createElement('button');button.type='button';button.style.cssText='position:absolute;left:0;right:0;height:26px';space.append(button);return button});function render(){const first=Math.max(0,Math.floor(list.scrollTop/28));rows.forEach((button,offset)=>{const invoice=first+offset+1;button.textContent='Open invoice '+invoice;button.style.top=(invoice-1)*28+'px';button.onclick=()=>{document.querySelector('h1').textContent='Invoice '+invoice;document.title='Invoice '+invoice}})}list.addEventListener('scroll',render,{passive:true});render()})()</script>`);
      }
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    parentPort = site.address().port;
    benchmarkSites = await startBenchmarkSites();
    const siteUrl = `http://127.0.0.1:${site.address().port}/?token=private#section`;

    broker = await new ExtensionBroker({ socketPath: join(stateDir, "extension-broker.sock"), requestTimeoutMs: 20_000 }).start();
    const displayEnv = { ...process.env, ACTIVETAB_STATE_DIR: stateDir };
    chrome = spawn(chromePath, [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-default-apps",
      "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--site-per-process", `--user-data-dir=${profileDir}`,
      siteUrl
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true, env: displayEnv });
    chrome.on("exit", (code, signal) => { if (code !== 0 && signal !== "SIGTERM") t.diagnostic(`Disposable Chrome exited: code=${code} signal=${signal}; stderr=${stderr.slice(-2_000)}`); });
    processFamilySampler.add(chrome.pid);
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-10_000); });
    connection = { client: new CdpPipeClient(chrome), close: () => connection.client.close() };
    let connected = false;
    const startupDeadline = Date.now() + 15_000;
    while (Date.now() < startupDeadline) {
      try { await connection.client.send("Browser.getVersion"); connected = true; break; }
      catch {
        if (chrome.exitCode !== null) throw new Error(`Chrome exited during startup (${chrome.exitCode}). ${stderr.slice(-2_000)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(connected, `Chrome did not start the native CDP pipe. ${stderr.slice(-2_000)}`);
    const { id: installedId } = await connection.client.send("Extensions.loadUnpacked", { path: join(projectRoot, "extension") });
    assert.equal(installedId, EXTENSION_ID, "Chrome loaded the development extension into the disposable profile");
    const pageDeadline = Date.now() + 10_000;
    let page;
    while (Date.now() < pageDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      page = targetInfos.find(target => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${site.address().port}/`));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(page, `Chrome loaded the local fixture page. ${stderr.slice(-1_000)}`);
    const visibleWindowDeadline = Date.now() + 5_000;
    let visibleWindowId;
    while (Date.now() < visibleWindowDeadline) {
      const windows = spawnSync("xdotool", ["search", "--onlyvisible", "--name", "^Extension start"], { encoding: "utf8" });
      visibleWindowId = windows.status === 0 ? windows.stdout.trim().split(/\s+/)[0] : undefined;
      if (visibleWindowId) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(visibleWindowId, `The disposable Chrome fixture is shown in a real desktop window. ${stderr.slice(-1_000)}`);
    const activateWindow = spawnSync("xdotool", ["windowactivate", "--sync", visibleWindowId], { encoding: "utf8" });
    assert.equal(activateWindow.status, 0, activateWindow.stderr);
    const tabTargets = await connection.client.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
    const tab = tabTargets.targetInfos?.find(target => target.type === "tab" && target.url.startsWith(`http://127.0.0.1:${site.address().port}/`));
    assert.ok(tab, `Chrome exposed a tab target for the fixture page: ${JSON.stringify(tabTargets.targetInfos)}`);
    await connection.client.send("Target.activateTarget", { targetId: page.targetId });
    await connection.client.send("Extensions.triggerAction", { id: installedId, targetId: tab.targetId });
    const popupTargetDeadline = Date.now() + 10_000;
    let popupTarget;
    while (Date.now() < popupTargetDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      popupTarget = targetInfos.find(target => target.type === "page" && target.url === `chrome-extension://${installedId}/popup.html`);
      if (popupTarget) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(popupTarget, "Chrome opened the extension action popup for the selected fixture tab");
    const { sessionId: popupSessionId } = await connection.client.send("Target.attachToTarget", { targetId: popupTarget.targetId, flatten: true });
    await connection.client.send("Page.enable", {}, popupSessionId);
    await connection.client.send("Runtime.enable", {}, popupSessionId);
    const popupDeadline = Date.now() + 10_000;
    let popupReady = false;
    while (Date.now() < popupDeadline) {
      const { result } = await connection.client.send("Runtime.evaluate", { expression: "Boolean(document.querySelector('#attach'))", returnByValue: true }, popupSessionId);
      if (result?.value === true) { popupReady = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!popupReady) {
      const targetInfo = await connection.client.send("Target.getTargetInfo", { targetId: popupTarget.targetId }).catch(error => ({ error: error.message }));
      const pageState = await connection.client.send("Runtime.evaluate", { expression: "JSON.stringify({href:location.href,title:document.title,text:document.body?.innerText?.slice(0,300)})", returnByValue: true }, popupSessionId).catch(error => ({ error: error.message }));
      const targets = await connection.client.send("Target.getTargets").catch(error => ({ targetInfos: [], error: error.message }));
      const extensionInfo = await connection.client.send("Target.createTarget", { url: "chrome://extensions/", background: true }).then(async created => {
        const { sessionId } = await connection.client.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
        await connection.client.send("Page.enable", {}, sessionId);
        await connection.client.send("Runtime.enable", {}, sessionId);
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const { result } = await connection.client.send("Runtime.evaluate", { expression: "JSON.stringify({ready:document.readyState,text:(function walk(root){let value=root.innerText||'';for(const node of root.querySelectorAll('*'))if(node.shadowRoot)value+=' '+walk(node.shadowRoot);return value})(document)})", returnByValue: true }, sessionId);
        return result?.value ?? "";
      }).catch(error => error.message);
      assert.fail(`Chrome did not load the extension popup. target=${JSON.stringify(targetInfo)} page=${JSON.stringify(pageState.result?.value ?? pageState)} workers=${JSON.stringify((targets.targetInfos ?? []).filter(info => info.type === "service_worker"))} extensions=${String(extensionInfo).slice(0,2_000)} stderr=${stderr.slice(-2_000)}`);
    }

    const brokerSignals = [];
    for (const name of ["ready", "disconnected", "attached", "protocolError"]) {
      broker.on(name, payload => brokerSignals.push({ name, payload: payload ?? null }));
    }
    let attachedTarget;
    broker.once("attached", target => { attachedTarget = target; });
    const attachBounds = await connection.client.send("Runtime.evaluate", {
      expression: "(()=>{const r=document.querySelector('#attach').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
      returnByValue: true
    }, popupSessionId);
    const { x: attachX, y: attachY } = attachBounds.result.value;
    await connection.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: attachX, y: attachY }, popupSessionId);
    await connection.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: attachX, y: attachY, button: "left", clickCount: 1 }, popupSessionId);
    await connection.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: attachX, y: attachY, button: "left", clickCount: 1 }, popupSessionId);
    const attachDeadline = Date.now() + 8_000;
    let popupState;
    while (Date.now() < attachDeadline && !attachedTarget) {
      const result = await connection.client.send("Runtime.evaluate", {
        expression: "(async()=>{const [lastFocused,current,all]=await Promise.all([chrome.tabs.query({active:true,lastFocusedWindow:true}),chrome.tabs.query({active:true,currentWindow:true}),chrome.tabs.query({})]);const slim=tabs=>tabs.map(({id,active,windowId,url})=>({id,active,windowId,origin:(()=>{try{return new URL(url).origin}catch{return ''}})()}));return JSON.stringify({page:document.querySelector('#page')?.innerText,status:document.querySelector('#status')?.innerText,attachHidden:document.querySelector('#attach')?.hidden,attachDisabled:document.querySelector('#attach')?.disabled,lastFocused:slim(lastFocused),current:slim(current),all:slim(all)})})()",
        returnByValue: true,
        awaitPromise: true
      }, popupSessionId);
      popupState = result.result?.value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(attachedTarget, `Extension did not attach through Native Messaging. popup=${JSON.stringify(popupState ?? "unavailable")} broker=${JSON.stringify(brokerSignals)} stderr=${stderr.slice(-2_000)}`);
    const target = attachedTarget;
    assert.equal(target.url, `http://127.0.0.1:${site.address().port}/`);
    assert.equal((await broker.listTabs())[0].id, page.targetId);

    session = await new BrowserSession(await broker.resolveTarget(page.targetId)).attach();
    const secondPage = await connection.client.send("Target.createTarget", { url: `http://127.0.0.1:${site.address().port}/fixture-login?multi=second` });
    secondPageTargetId = secondPage.targetId;
    const secondTabDeadline = Date.now() + 5_000;
    let secondTab;
    while (Date.now() < secondTabDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
      secondTab = targetInfos.find(target => target.type === "tab" && target.url.includes("?multi=second"));
      if (secondTab) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(secondTab, "Chrome exposes the second page as a tab target for the extension action click");
    const secondAuthorization = await attachThroughPopup(connection.client, broker, installedId, secondTab.targetId);
    assert.equal(secondAuthorization.id, secondPage.targetId, "the second tab receives a separate explicit popup grant");
    assert.deepEqual((await broker.listTabs()).map(target => target.id).sort(), [page.targetId, secondPage.targetId].sort(), "the broker retains both user-authorized page targets");
    try {
      secondSession = await new BrowserSession(await broker.resolveTarget(secondPage.targetId)).attach();
      const secondObservation = await secondSession.observe({ includeScreenshot: false });
      assert.equal(secondObservation.page.title, "Signed-in session ready", "the selected tab retains the fixture's preexisting authenticated page state");
      const authenticatedPlanner = countingPlanner();
      const authenticatedProfileRun = await runMeasured("authenticated existing-tab navigation", async () => {
        const result = await new NavigationEngine(secondSession, { maxActions: 2, maxRecoveries: 1, planner: authenticatedPlanner }).run("Open the private profile page");
        return { ...result, plannerCalls: authenticatedPlanner.calls };
      }, result => result.status === "succeeded" && result.page?.title === "Private profile");
      assert.equal(authenticatedProfileRun.status, "succeeded", JSON.stringify(authenticatedProfileRun));
      assert.equal(authenticatedProfileRun.page.title, "Private profile", "the server grants access only when the tab's HTTP-only session cookie survives attachment");
      assert.ok(authenticatedProfileRequests >= 1, "the independent server oracle received the authenticated session without exposing its cookie to the planner");
      const secondRun = await new NavigationEngine(secondSession, { maxActions: 2, maxRecoveries: 1 }).run("Open the details page");
      assert.equal(secondRun.status, "succeeded", JSON.stringify(secondRun));
      assert.equal(secondRun.page.title, "Details", "navigation executes and verifies against the selected second tab");
      const firstStillUsable = await session.observe({ includeScreenshot: false });
      assert.equal(firstStillUsable.page.title, "Extension start", "activity in the second tab does not redirect the first session");
    } finally {
      await connection.client.send("Target.activateTarget", { targetId: page.targetId }).catch(() => {});
    }
    assert.deepEqual((await broker.listTabs()).map(target => target.id).sort(), [page.targetId, secondPage.targetId].sort(), "both independent tab leases remain active before lifecycle recovery");
    const frameDeadline = Date.now() + 5_000;
    let attachedFrames = await session.getOutOfProcessFrames();
    while (attachedFrames.length < 2 && Date.now() < frameDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      attachedFrames = await session.getOutOfProcessFrames();
    }
    assert.equal(attachedFrames.length, 2, `the extension debugger transport recursively attaches to both OOPIF levels: ${session.frameAttachmentError ?? "no attachment error"}`);
    const observation = await session.observe({ includeScreenshot: true });
    assert.equal(observation.page.title, "Extension start");
    assert.equal(observation.page.url, `http://127.0.0.1:${site.address().port}/`);
    const next = observation.candidates.find(candidate => candidate.name === "Open details");
    assert.ok(next, "native DOMSnapshot produced the fixture's interactable button");
    const frameCandidate = observation.candidates.find(candidate => candidate.name === "Open frame settings");
    const nestedCandidate = observation.candidates.find(candidate => candidate.name === "Open nested preferences");
    assert.ok(frameCandidate && nestedCandidate, "native observations expose controls from both OOPIF levels");
    assert.ok(attachedFrames.some(frame => frame.targetId === frameCandidate.frameTargetId), "the direct OOPIF candidate has its attached target identity");
    assert.ok(attachedFrames.some(frame => frame.targetId === nestedCandidate.frameTargetId), "the nested OOPIF candidate has its attached target identity");
    const detailed = session.observer.getEvidence(observation.evidenceId, { facets: ["domSnapshot", "accessibilityTree", "frameTree", "outOfProcessFrames", "scrollTargets"], includeScreenshot: true });
    assert.ok(detailed.domSnapshot.documents.length, "the full native DOMSnapshot remains available behind the compact candidates");
    assert.ok(detailed.accessibilityTree, "the full native accessibility tree remains available by evidence ID");
    assert.ok(detailed.domSnapshot.documents[0].layout, "native layout rectangles remain available in the detailed snapshot");
    assert.ok(detailed.screenshotBase64, "the screenshot is retained and returned only when explicitly requested");
    assert.equal(detailed.outOfProcessFrames.length, 2, "full DOMSnapshot and accessibility evidence remain available for both OOPIFs");
    assert.ok(detailed.scrollTargets.some(target => target.kind === "container" && target.name === "Invoice list"), "the visible extension retains the labeled virtualized list as scroll evidence");
    assert.equal(JSON.stringify(detailed.outOfProcessFrames).includes("private-frame"), false, "OOPIF query data is redacted in retained evidence by default");
    const directPlanner = countingPlanner();
    const directFrameRun = await runMeasured("direct OOPIF navigation", async () => {
      const result = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1, planner: directPlanner }).run("Open frame settings page");
      return { ...result, plannerCalls: directPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Frame settings");
    assert.equal(directFrameRun.status, "succeeded", "the extension transport executes and verifies a direct OOPIF action");
    assert.equal(directFrameRun.page.title, "Frame settings");
    const nestedPlanner = countingPlanner();
    const nestedFrameRun = await runMeasured("nested OOPIF navigation", async () => {
      const result = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1, planner: nestedPlanner }).run("Open nested preferences page");
      return { ...result, plannerCalls: nestedPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Nested preferences");
    assert.equal(nestedFrameRun.status, "succeeded", "the extension transport executes and verifies a nested OOPIF action");
    assert.equal(nestedFrameRun.page.title, "Nested preferences");
    const startUrl = `http://127.0.0.1:${site.address().port}/`;
    const returnToStart = async () => {
      await session.client.send("Page.navigate", { url: startUrl });
      await session.waitForChange();
      return await session.observe();
    };
    await returnToStart();
    const virtualizedPlanner = countingPlanner();
    const virtualizedWorkflowStore = new WorkflowStore(join(root, "virtualized-workflows", "verified.json"));
    const visibleVirtualizedRun = await runMeasured("virtualized list navigation", async () => {
      const result = await new NavigationEngine(session, { maxActions: 8, maxScrolls: 5, maxRecoveries: 0, planner: virtualizedPlanner, workflowStore: virtualizedWorkflowStore }).run("Open invoice 24 page");
      return { ...result, plannerCalls: virtualizedPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Invoice 24");
    assert.equal(visibleVirtualizedRun.status, "succeeded", `visible extension navigation reveals the virtualized invoice through native wheel events: ${JSON.stringify(visibleVirtualizedRun)}`);
    assert.equal(visibleVirtualizedRun.page.title, "Invoice 24");
    assert.equal(visibleVirtualizedRun.workflowReplay.status, "recorded", "the virtualized trace stores hashed scroll-position and visible-row assumptions");
    await returnToStart();
    let virtualizedReplayPlannerCalls = 0;
    const replayedVirtualizedRun = await runMeasured("virtualized workflow replay", () => new NavigationEngine(session, {
      maxActions: 8,
      maxScrolls: 5,
      maxRecoveries: 0,
      workflowStore: virtualizedWorkflowStore,
      planner: { async plan() { virtualizedReplayPlannerCalls++; throw new Error("A fresh virtualized workflow should replay without planning."); } }
    }).run("Open invoice 24 page"), result => result.status === "succeeded" && result.page?.title === "Invoice 24");
    benchmarkRuns.at(-1).plannerCalls = virtualizedReplayPlannerCalls;
    assert.equal(replayedVirtualizedRun.status, "succeeded");
    assert.equal(replayedVirtualizedRun.workflowReplay.status, "replayed");
    assert.ok(replayedVirtualizedRun.workflowReplay.actions >= 2 && replayedVirtualizedRun.workflowReplay.actions <= 6);
    assert.equal(virtualizedReplayPlannerCalls, 0, "freshly validated virtualized scroll steps replay without planning");
    await returnToStart();
    const delayedPlanner = countingPlanner();
    const delayedJournal = new TaskJournal(join(root, "delayed-spa", "task.json"));
    const delayedRun = await runMeasured("delayed SPA rendering", async () => {
      const result = await new NavigationEngine(session, { journal: delayedJournal, maxActions: 2, maxRecoveries: 1, planner: delayedPlanner }).run("Open the delayed dashboard view");
      return { ...result, plannerCalls: delayedPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Delayed dashboard");
    const delayedBrowserOracle = await session.client.send("Runtime.evaluate", {
      expression: "JSON.stringify({title:document.title,heading:document.querySelector('h1')?.textContent?.trim()??'',urlPath:location.pathname})",
      returnByValue: true
    });
    assert.equal(delayedRun.status, "succeeded", JSON.stringify({ result: delayedRun, browser: JSON.parse(delayedBrowserOracle.result.value), task: await delayedJournal.read() }));
    assert.deepEqual(JSON.parse(delayedBrowserOracle.result.value), { title: "Delayed dashboard", heading: "Delayed dashboard", urlPath: "/delayed-dashboard" });
    assert.equal(delayedRun.recoveries, 0);
    await returnToStart();
    const searchJournal = new TaskJournal(join(root, "search-resume", "task.json"));
    const unusedExternalPlanner = { calls: 0, async plan() { this.calls++; throw new Error("Search goals must stay on the local deterministic planner."); } };
    const searchTask = await runMeasured("native search fill and submission", async () => {
      const result = await new NavigationEngine(session, {
        journal: searchJournal,
        workflowStore: new WorkflowStore(join(root, "search-workflows", "verified.json")),
        planner: unusedExternalPlanner
      }).run("Search for benchmark sample");
      return { ...result, plannerCalls: result.attempts, remotePlannerCalls: unusedExternalPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Search results");
    const nativeSearchState = await session.client.send("Runtime.evaluate", {
      expression: "JSON.stringify({title:document.title,heading:document.querySelector('h1')?.textContent?.trim()??'',inputMatches:document.querySelector('#search-query')?.value==='benchmark sample',urlPath:location.pathname})",
      returnByValue: true
    });
    assert.equal(searchTask.status, "succeeded", `visible Chrome receives native search text and submits the form: ${JSON.stringify({ result: searchTask, browser: JSON.parse(nativeSearchState.result.value), journal: await searchJournal.read() })}`);
    assert.equal(searchTask.attempts, 2, "one native input action is followed by one submit click");
    assert.equal(searchTask.recoveries, 0);
    assert.equal(searchTask.remotePlannerCalls, 0, "the query never reaches the configured planner boundary");
    assert.equal(searchTask.workflowReplay.status, "skipped_form_input", "search phrases are excluded from reusable workflow records");
    assert.equal(await session.verifySearchOutcome("benchmark sample"), true, "the browser still has the requested search and a results state");
    assert.equal(JSON.stringify(await searchJournal.read()).includes("benchmark sample"), false, "task persistence redacts the search phrase");
    assert.equal(JSON.stringify(searchTask).includes("benchmark sample"), false, "navigation output redacts the search phrase");
    await returnToStart();
    const workflowStore = new WorkflowStore(join(root, "workflows", "verified.json"));
    await returnToStart();
    const recordPlanner = { calls: 0, async plan(goal, current, options) { this.calls++; return await new DeterministicPlanner().plan(goal, current, options); } };
    const recordedWorkflow = await runMeasured("workflow record", async () => {
      const result = await new NavigationEngine(session, { workflowStore, maxActions: 2, planner: recordPlanner }).run("Open the details page");
      return { ...result, plannerCalls: recordPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Details");
    assert.equal(recordedWorkflow.status, "succeeded", "a real visible Chrome task records a verified route");
    assert.equal(recordedWorkflow.workflowReplay.status, "recorded");
    assert.equal(recordedWorkflow.page.title, "Details");
    await returnToStart();
    let replayPlannerCalls = 0;
    const replayedWorkflow = await runMeasured("workflow replay", () => new NavigationEngine(session, {
      workflowStore,
      maxActions: 2,
      planner: { async plan() { replayPlannerCalls++; throw new Error("A fresh workflow replay should not call the planner."); } }
    }).run("Open the details page"), result => result.status === "succeeded" && result.page?.title === "Details");
    const replayMeasurement = benchmarkRuns.at(-1);
    replayMeasurement.plannerCalls = replayPlannerCalls;
    assert.equal(replayedWorkflow.status, "succeeded", "the same visible Chrome task replays from a fresh native observation");
    assert.equal(replayedWorkflow.workflowReplay.status, "replayed");
    assert.equal(replayedWorkflow.workflowReplay.actions, 1);
    assert.equal(replayedWorkflow.page.title, "Details");
    await returnToStart();

    const multiStepGoal = "Open the account security page";
    const seedPlanner = countingPlanner();
    const seededMultiStep = await runMeasured("multi-step workflow record", async () => {
      const result = await new NavigationEngine(session, { workflowStore, maxActions: 3, planner: seedPlanner }).run(multiStepGoal);
      return { ...result, plannerCalls: seedPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Security settings");
    assert.equal(seededMultiStep.status, "succeeded");
    assert.equal(seededMultiStep.attempts, 2, "the account and security pages require two native navigation actions");
    assert.equal(seededMultiStep.workflowReplay.status, "recorded");
    await returnToStart();

    const clickBeforeRepair = session.click.bind(session);
    let injectIntermediateStaleNode = true;
    session.click = async target => {
      if (injectIntermediateStaleNode && target.name === "Security settings") {
        injectIntermediateStaleNode = false;
        await session.client.send("Runtime.evaluate", {
          expression: "const link=document.querySelector('#security-link');link.replaceWith(link.cloneNode(true))"
        });
      }
      return clickBeforeRepair(target);
    };
    const repairPlanner = countingPlanner();
    const repairedMultiStep = await runMeasured("intermediate workflow recovery", async () => {
      const result = await new NavigationEngine(session, { workflowStore, maxActions: 4, maxRecoveries: 1, planner: repairPlanner }).run(multiStepGoal);
      return { ...result, plannerCalls: repairPlanner.calls };
    }, result => result.status === "succeeded" && result.page?.title === "Security settings" && result.recoveries === 1);
    session.click = clickBeforeRepair;
    assert.equal(injectIntermediateStaleNode, false, "the stale native node was replaced during step two");
    assert.equal(repairedMultiStep.status, "succeeded", "fresh CDP evidence lets the planner repair the interrupted replay");
    assert.equal(repairedMultiStep.workflowReplay.status, "repaired-and-recorded");
    assert.equal(repairedMultiStep.workflowReplay.actions, 2, "the engine recorded the successful first replay step and the failed second replay step");
    assert.equal(repairedMultiStep.recoveries, 1);
    assert.equal(repairPlanner.calls, 1, "only the failed intermediate step needs fresh planning");
    assert.equal(repairedMultiStep.page.url, `http://127.0.0.1:${site.address().port}/account/security`);

    await returnToStart();
    let repairedReplayPlannerCalls = 0;
    const repairedReplay = await runMeasured("repaired workflow replay", () => new NavigationEngine(session, {
      workflowStore,
      maxActions: 3,
      planner: { async plan() { repairedReplayPlannerCalls++; throw new Error("The repaired workflow should replay without planning."); } }
    }).run(multiStepGoal), result => result.status === "succeeded" && result.page?.title === "Security settings");
    benchmarkRuns.at(-1).plannerCalls = repairedReplayPlannerCalls;
    assert.equal(repairedReplay.status, "succeeded");
    assert.equal(repairedReplay.workflowReplay.status, "replayed");
    assert.equal(repairedReplay.workflowReplay.actions, 2);
    assert.equal(repairedReplayPlannerCalls, 0);
    await returnToStart();

    const journal = new TaskJournal(join(root, "resume", "task.json"));
    const click = session.click.bind(session);
    let injectStaleIdentity = true;
    session.click = async candidate => {
      if (injectStaleIdentity) {
        injectStaleIdentity = false;
        await session.client.send("Runtime.evaluate", { expression: "const button=document.querySelector('#next');button.replaceWith(button.cloneNode(true))" });
      }
      return click(candidate);
    };
    const resumedTaskStartedAt = performance.now();
    const recoveryPlanner = countingPlanner();
    const firstRun = await new NavigationEngine(session, { journal, maxActions: 1, maxRecoveries: 1, planner: recoveryPlanner }).run("Open the details page");
    assert.equal(firstRun.status, "unresolved", "the first run records the injected stale-element failure without repeating it");
    assert.equal(firstRun.attempts, 1);
    assert.equal(firstRun.recoveries, 1);
    const savedState = await journal.read();
    assert.equal(savedState.attempts.length, 1, "task continuation is persisted outside the live navigation engine");
    assert.ok(savedState.attempts[0].error, "the deliberately injected native CDP failure is recorded");
    const resumed = await new NavigationEngine(session, { journal, maxActions: 3, maxRecoveries: 1, planner: recoveryPlanner }).run("Open the details page", { resumeState: savedState });
    recordBenchmark("stale identity recovery and resume", resumedTaskStartedAt, { ...resumed, plannerCalls: recoveryPlanner.calls }, result => result.status === "succeeded" && result.page?.title === "Details" && result.recoveries === 1);
    assert.equal(resumed.status, "succeeded", "a fresh engine instance replans from new native evidence and verifies the goal");
    assert.equal(resumed.attempts, 2);
    assert.equal(resumed.recoveries, 1);
    assert.equal(resumed.page.title, "Details");
    assert.equal(resumed.page.url, `http://127.0.0.1:${site.address().port}/details`);
    const interruptedBroker = broker;
    const interruptedServer = interruptedBroker.server;
    const interruptedSocket = interruptedBroker.socket;
    assert.ok(interruptedServer && interruptedSocket, "the authorized extension session has a live local broker connection");
    const brokerStopped = new Promise(resolve => interruptedServer.close(resolve));
    interruptedSocket.destroy();
    await brokerStopped;
    const replacementBroker = new ExtensionBroker({ socketPath: join(stateDir, "extension-broker.sock"), requestTimeoutMs: 20_000 });
    const reattachedTargetPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The extension did not restore its authorized tab after the broker restarted.")), 15_000);
      replacementBroker.once("attached", target => { clearTimeout(timer); resolve(target); });
    });
    broker = await replacementBroker.start();
    const reattachedTarget = await reattachedTargetPromise;
    assert.equal(reattachedTarget.id, page.targetId, "the restarted broker receives the same explicitly authorized tab");
    const interruptedSession = session;
    session = undefined;
    await interruptedSession.close().catch(() => {});
    session = await new BrowserSession(await broker.resolveTarget(page.targetId)).attach();
    const afterRestart = await session.observe({ includeScreenshot: false });
    assert.equal(afterRestart.page.title, "Details", "the authorized browser tab remains controllable after the local broker restarts");
    assert.equal((await broker.listTabs())[0].url, `http://127.0.0.1:${site.address().port}/details`, "reattachment refreshes current tab metadata");
    const restoredAfterWorkerRestart = new Promise((resolve, reject) => {
      const restoredIds = new Set();
      const timer = setTimeout(() => reject(new Error(`The service worker did not restore every authorized tab: ${JSON.stringify([...restoredIds])}`)), 15_000);
      broker.on("attached", target => {
        restoredIds.add(target.id);
        if (restoredIds.has(page.targetId) && restoredIds.has(secondPageTargetId)) {
          clearTimeout(timer);
          resolve([...restoredIds]);
        }
      });
    });
    const workerRestartLeaseEvents = [];
    broker.on("detached", payload => workerRestartLeaseEvents.push({ kind: "detached", ...payload }));
    broker.on("disconnected", payload => workerRestartLeaseEvents.push({ kind: "disconnected", ...payload }));
    const { targetInfos: beforeWorkerStop = [] } = await connection.client.send("Target.getTargets");
    const serviceWorker = beforeWorkerStop.find(target => target.type === "service_worker" && target.url === `chrome-extension://${installedId}/service-worker.js`);
    assert.ok(serviceWorker, "Chrome exposes the running extension service worker");
    const stoppedWorker = await connection.client.send("Target.closeTarget", { targetId: serviceWorker.targetId });
    assert.equal(stoppedWorker.success, true, "the disposable extension service worker target can be stopped for recovery testing");
    await connection.client.send("Extensions.triggerAction", { id: installedId, targetId: tab.targetId });
    const workerPopupDeadline = Date.now() + 10_000;
    let workerPopup;
    while (Date.now() < workerPopupDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      workerPopup = targetInfos.find(target => target.type === "page" && target.url === `chrome-extension://${installedId}/popup.html`);
      if (workerPopup) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(workerPopup, "reopening the extension popup wakes its stopped service worker");
    const restoredTargetIds = await restoredAfterWorkerRestart;
    assert.deepEqual(new Set(restoredTargetIds), new Set([page.targetId, secondPageTargetId]), "the restarted service worker revalidates and restores every explicitly authorized tab");
    const interruptedWorkerSession = session;
    session = undefined;
    await interruptedWorkerSession.close();
    session = await new BrowserSession(await broker.resolveTarget(page.targetId)).attach();
    await secondSession.close();
    secondSession = await new BrowserSession(await broker.resolveTarget(secondPageTargetId)).attach();
    let observationAfterWorkerRestart;
    try { observationAfterWorkerRestart = await session.observe({ includeScreenshot: false }); }
    catch (error) { assert.fail(`${error.message}; broker targets=${JSON.stringify(await broker.listTabs())}; lifecycle events=${JSON.stringify(workerRestartLeaseEvents)}`); }
    assert.equal(observationAfterWorkerRestart.page.title, "Details", "the reconnected broker still controls the authorized tab");
    assert.equal((await secondSession.observe({ includeScreenshot: false })).page.title, "Details", "the second authorized target also resumes through a fresh session");
    await secondSession.close();
    secondSession = undefined;
    await connection.client.send("Target.closeTarget", { targetId: secondPageTargetId }).catch(() => {});
    assert.deepEqual((await broker.listTabs()).map(target => target.id), [page.targetId], "detaching the restored second tab preserves the first grant");
    const keepaliveTarget = await connection.client.send("Target.createTarget", { url: "about:blank", background: true });
    const keepaliveReady = Date.now() + 5_000;
    let keepalivePage;
    while (Date.now() < keepaliveReady) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      keepalivePage = targetInfos.find(target => target.type === "page" && target.targetId === keepaliveTarget.targetId);
      if (keepalivePage) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(keepalivePage, "a background tab keeps the visible Chrome window alive during closure recovery");
    await connection.client.send("Target.closeTarget", { targetId: workerPopup.targetId });
    const detachedFromClosedTab = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome closed the tab without clearing the extension's target lease.")), 5_000);
      broker.once("detached", target => { clearTimeout(timer); resolve(target); });
    });
    const closedTarget = await connection.client.send("Target.closeTarget", { targetId: page.targetId });
    assert.equal(closedTarget.success, true, "the disposable authorized tab closes cleanly");
    const detachedTarget = await detachedFromClosedTab;
    assert.equal(detachedTarget.targetId, page.targetId, "Chrome debugger detachment invalidates the exact old target lease");
    assert.deepEqual(await broker.listTabs(), [], "the broker exposes no tab after Chrome detaches the closed page");

    const createdTarget = await connection.client.send("Target.createTarget", { url: siteUrl });
    const freshPageDeadline = Date.now() + 10_000;
    let freshPage;
    let freshTab;
    while (Date.now() < freshPageDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      freshPage = targetInfos.find(target => target.type === "page" && target.targetId === createdTarget.targetId);
      const tabs = await connection.client.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
      freshTab = tabs.targetInfos?.find(target => target.type === "tab" && target.url.startsWith(`http://127.0.0.1:${site.address().port}/`));
      if (freshPage && freshTab) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(freshPage && freshTab, "Chrome opens a replacement fixture tab after the authorized target closes");
    await connection.client.send("Target.activateTarget", { targetId: freshPage.targetId });
    const freshWindowDeadline = Date.now() + 5_000;
    let freshWindowId;
    while (Date.now() < freshWindowDeadline) {
      const windows = spawnSync("xdotool", ["search", "--onlyvisible", "--name", "^Extension start"], { encoding: "utf8" });
      freshWindowId = windows.status === 0 ? windows.stdout.trim().split(/\s+/)[0] : undefined;
      if (freshWindowId) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(freshWindowId, "the replacement fixture page is visibly shown in Chrome");
    const activatedFreshWindow = spawnSync("xdotool", ["windowactivate", "--sync", freshWindowId], { encoding: "utf8" });
    assert.equal(activatedFreshWindow.status, 0, activatedFreshWindow.stderr);
    await connection.client.send("Extensions.triggerAction", { id: installedId, targetId: freshTab.targetId });
    const freshPopupDeadline = Date.now() + 10_000;
    let freshPopup;
    while (Date.now() < freshPopupDeadline) {
      const { targetInfos = [] } = await connection.client.send("Target.getTargets");
      freshPopup = targetInfos.find(target => target.type === "page" && target.url === `chrome-extension://${installedId}/popup.html`);
      if (freshPopup) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(freshPopup, "the user can reopen the ActiveTab popup on the replacement tab");
    const { sessionId: freshPopupSessionId } = await connection.client.send("Target.attachToTarget", { targetId: freshPopup.targetId, flatten: true });
    await connection.client.send("Page.enable", {}, freshPopupSessionId);
    await connection.client.send("Runtime.enable", {}, freshPopupSessionId);
    const freshPopupReadyDeadline = Date.now() + 10_000;
    let freshAttachBounds;
    while (Date.now() < freshPopupReadyDeadline) {
      const { result } = await connection.client.send("Runtime.evaluate", {
        expression: "(()=>{const e=document.querySelector('#attach');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
        returnByValue: true
      }, freshPopupSessionId);
      if (result?.value) { freshAttachBounds = result.value; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(freshAttachBounds, "the replacement tab popup offers an explicit Attach control");
    const freshAttachedTarget = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("A new explicit popup click did not authorize the replacement tab.")), 8_000);
      broker.once("attached", target => { clearTimeout(timer); resolve(target); });
    });
    const freshAttachX = freshAttachBounds.x;
    const freshAttachY = freshAttachBounds.y;
    await connection.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: freshAttachX, y: freshAttachY }, freshPopupSessionId);
    await connection.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: freshAttachX, y: freshAttachY, button: "left", clickCount: 1 }, freshPopupSessionId);
    await connection.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: freshAttachX, y: freshAttachY, button: "left", clickCount: 1 }, freshPopupSessionId);
    const newlyAuthorizedTarget = await freshAttachedTarget;
    assert.equal(newlyAuthorizedTarget.id, freshPage.targetId, "the replacement tab receives a new grant only after the user clicks Attach");
    assert.equal((await broker.listTabs())[0].id, freshPage.targetId, "the broker now controls only the newly authorized target");
    const brokerDisconnected = new Promise(resolve => broker.once("disconnected", resolve));
    const previousChrome = chrome;
    const previousClient = connection.client;
    const browserExit = once(previousChrome, "exit").then(([code, signal]) => ({ code, signal }));
    await previousClient.send("Browser.close").catch(() => {});
    let browserExitTimer;
    const browserExitResult = await Promise.race([browserExit, new Promise(resolve => { browserExitTimer = setTimeout(() => resolve(null), 10_000); })]);
    clearTimeout(browserExitTimer);
    assert.ok(browserExitResult, "the visible disposable Chrome process exits before restart");
    let brokerDisconnectTimer;
    const brokerDisconnectResult = await Promise.race([brokerDisconnected, new Promise(resolve => { brokerDisconnectTimer = setTimeout(() => resolve(null), 10_000); })]);
    clearTimeout(brokerDisconnectTimer);
    assert.ok(brokerDisconnectResult, "Chrome shutdown disconnects the Native Messaging lease");
    assert.deepEqual(await broker.listTabs(), [], "the broker forgets the old target when Chrome exits");
    previousClient.close();

    chrome = spawn(chromePath, [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-default-apps",
      "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--site-per-process", `--user-data-dir=${profileDir}`,
      siteUrl
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true, env: displayEnv });
    chrome.on("exit", (code, signal) => { if (code !== 0 && signal !== "SIGTERM") t.diagnostic(`Restarted disposable Chrome exited: code=${code} signal=${signal}; stderr=${stderr.slice(-2_000)}`); });
    processFamilySampler.add(chrome.pid);
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-10_000); });
    const restartedClient = new CdpPipeClient(chrome);
    connection = { client: restartedClient, close: () => restartedClient.close() };
    let restartedBrowserReady = false;
    const browserStartupDeadline = Date.now() + 15_000;
    while (Date.now() < browserStartupDeadline) {
      try { await restartedClient.send("Browser.getVersion"); restartedBrowserReady = true; break; }
      catch {
        if (chrome.exitCode !== null) throw new Error(`Chrome exited during restart (${chrome.exitCode}). ${stderr.slice(-2_000)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(restartedBrowserReady, `Chrome restarted with the same disposable profile. ${stderr.slice(-2_000)}`);
    const { id: restartedExtensionId } = await restartedClient.send("Extensions.loadUnpacked", { path: join(projectRoot, "extension") });
    assert.equal(restartedExtensionId, installedId, "the same unpacked extension can attach after Chrome restarts with the same profile");
    assert.deepEqual(await broker.listTabs(), [], "browser restart does not restore the previous tab authorization");
    const restartedPageDeadline = Date.now() + 10_000;
    let restartedPage;
    let restartedTab;
    while (Date.now() < restartedPageDeadline) {
      const { targetInfos = [] } = await restartedClient.send("Target.getTargets");
      restartedPage = targetInfos.find(target => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${site.address().port}/`));
      const tabs = await restartedClient.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
      restartedTab = tabs.targetInfos?.find(target => target.type === "tab" && target.url.startsWith(`http://127.0.0.1:${site.address().port}/`));
      if (restartedPage && restartedTab) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(restartedPage && restartedTab, "the loopback fixture page is available in the restarted browser");
    await restartedClient.send("Target.activateTarget", { targetId: restartedPage.targetId });
    const restartedWindowDeadline = Date.now() + 5_000;
    let restartedWindowId;
    while (Date.now() < restartedWindowDeadline) {
      const windows = spawnSync("xdotool", ["search", "--onlyvisible", "--name", "^Extension start"], { encoding: "utf8" });
      restartedWindowId = windows.status === 0 ? windows.stdout.trim().split(/\s+/)[0] : undefined;
      if (restartedWindowId) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(restartedWindowId, "the restarted fixture is visible in a real Chrome window");
    const activatedRestartedWindow = spawnSync("xdotool", ["windowactivate", "--sync", restartedWindowId], { encoding: "utf8" });
    assert.equal(activatedRestartedWindow.status, 0, activatedRestartedWindow.stderr);
    await restartedClient.send("Extensions.triggerAction", { id: installedId, targetId: restartedTab.targetId });
    assert.deepEqual(await broker.listTabs(), [], "opening the restored extension popup does not grant browser control");
    const afterBrowserRestartTarget = await attachThroughPopup(restartedClient, broker, installedId, restartedTab.targetId, true);
    assert.equal(afterBrowserRestartTarget.id, restartedPage.targetId, "browser restart requires a fresh popup click before any target is attached");
    const priorSession = session;
    session = undefined;
    await priorSession.close().catch(() => {});
    session = await new BrowserSession(await broker.resolveTarget(restartedPage.targetId)).attach();
    const afterBrowserRestart = await session.observe({ includeScreenshot: false });
    assert.equal(afterBrowserRestart.page.title, "Extension start", "the reauthorized Chrome tab provides native observations after browser restart");
    assert.equal((await broker.listTabs())[0].id, restartedPage.targetId, "the broker controls only the freshly authorized post-restart target");
    let devtoolsDetachedTarget;
    const onDevtoolsDetach = target => { devtoolsDetachedTarget = target; };
    broker.once("detached", onDevtoolsDetach);
    const focusedBeforeDevtools = spawnSync("xdotool", ["windowactivate", "--sync", restartedWindowId], { encoding: "utf8" });
    assert.equal(focusedBeforeDevtools.status, 0, focusedBeforeDevtools.stderr);
    const focusedWindowName = spawnSync("xdotool", ["getwindowfocus", "getwindowname"], { encoding: "utf8" });
    assert.match(focusedWindowName.stdout, /Extension start/, `the fixture Chrome window has focus: ${focusedWindowName.stdout}`);
    const openDevtools = spawnSync("xdotool", ["key", "--clearmodifiers", "ctrl+shift+i"], { encoding: "utf8" });
    assert.equal(openDevtools.status, 0, openDevtools.stderr);
    await Promise.race([new Promise(resolve => setTimeout(resolve, 1_500)), new Promise(resolve => broker.once("detached", resolve))]);
    const { targetInfos: targetsWithDevtools = [] } = await restartedClient.send("Target.getTargets");
    const devtoolsTargets = targetsWithDevtools.filter(target => target.url.startsWith("devtools://"));
    assert.ok(devtoolsTargets.length > 0, "the DevTools keyboard shortcut opens the visible Chrome DevTools frontend for the attached fixture");
    const detachedWhileDevtoolsOpen = Boolean(devtoolsDetachedTarget);
    const leaseWhileDevtoolsOpen = await broker.listTabs();
    let observationWhileDevtoolsOpen;
    if (!detachedWhileDevtoolsOpen) observationWhileDevtoolsOpen = await session.observe({ includeScreenshot: false });
    const closeDevtoolsResults = await Promise.all(devtoolsTargets.map(target => restartedClient.send("Target.closeTarget", { targetId: target.targetId })));
    assert.ok(closeDevtoolsResults.every(result => result.success), "the test closes only the DevTools frontend targets it opened");
    await new Promise(resolve => setTimeout(resolve, 250));
    const leaseAfterDevtoolsClosed = await broker.listTabs();
    broker.off("detached", onDevtoolsDetach);
    if (devtoolsDetachedTarget) {
      assert.equal(devtoolsDetachedTarget.targetId, restartedPage.targetId, "DevTools detachment identifies the exact page target");
      assert.deepEqual(leaseAfterDevtoolsClosed, [], "the broker revokes the tab when Chrome emits a debugger detach");
      const previousSession = session;
      session = undefined;
      await previousSession.close().catch(() => {});
      const afterDevtoolsTarget = await attachThroughPopup(restartedClient, broker, installedId, restartedTab.targetId);
      assert.equal(afterDevtoolsTarget.id, restartedPage.targetId, "control resumes only after a new popup click after DevTools closes");
    } else {
      assert.equal(leaseWhileDevtoolsOpen[0]?.id, restartedPage.targetId, "this Chrome build retains the extension lease while DevTools is visibly docked");
      assert.equal(observationWhileDevtoolsOpen.page.title, "Extension start", "native CDP observation remains available while DevTools is open");
      assert.equal(leaseAfterDevtoolsClosed[0]?.id, restartedPage.targetId, "closing DevTools leaves the existing extension lease intact on this Chrome build");
      t.diagnostic("Observed on Google Chrome 150.0.7871.114: DevTools opened visibly and the extension lease remained active; Chrome did not emit debugger.onDetach while it was open or after it closed.");
    }
    assert.equal((await broker.listTabs())[0]?.id, restartedPage.targetId, "the broker controls only the exact authorized page after DevTools closes");
    if (!session?.attached) session = await new BrowserSession(await broker.resolveTarget(restartedPage.targetId)).attach();
    const matrixRuns = [];
    for (const site of benchmarkSites.sites) {
      for (let repeat = 1; repeat <= 3; repeat++) {
        await session.client.send("Page.navigate", { url: site.url });
        await session.waitForChange();
        const tracedPlanner = {
          calls: 0,
          selected: [],
          async plan(...args) {
            this.calls++;
            const decision = await new DeterministicPlanner().plan(...args);
            if (decision.status === "planned") this.selected.push(decision.action.target.name ?? "");
            return decision;
          }
        };
        const startedAt = performance.now();
        const result = await new NavigationEngine(session, { maxActions: 2, maxRecoveries: 1, planner: tracedPlanner }).run(site.goal);
        const engineElapsedMs = Math.round(performance.now() - startedAt);
        const live = await session.client.send("Runtime.evaluate", {
          expression: "JSON.stringify({title:document.title,heading:document.querySelector('h1')?.textContent?.trim()??'',url:location.href})",
          returnByValue: true
        });
        const browserState = JSON.parse(live.result?.value ?? "{}");
        const expectedTitle = site.slug[0].toUpperCase() + site.slug.slice(1);
        const normalizeOracleText = value => String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
        const observedPath = new URL(browserState.url).pathname;
        const oraclePassed = result.status === "succeeded"
          && normalizeOracleText(browserState.title) === normalizeOracleText(expectedTitle)
          && normalizeOracleText(browserState.heading) === normalizeOracleText(expectedTitle)
          && observedPath === site.expectedPath;
        const actionCorrect = result.status === "succeeded" && tracedPlanner.selected.length === 1
          && tracedPlanner.selected[0].toLocaleLowerCase().includes(site.slug);
        matrixRuns.push({
          siteId: site.id,
          origin: new URL(site.url).origin,
          variant: site.variant,
          repeat,
          oraclePassed,
          actionCorrect,
          resultStatus: result.status,
          selectedTargetName: tracedPlanner.selected[0] ?? null,
          browserTitle: browserState.title,
          browserHeading: browserState.heading,
          browserPath: observedPath,
          actions: result.attempts,
          recoveries: result.recoveries,
          plannerCalls: tracedPlanner.calls,
          remoteModelCalls: 0,
          engineElapsedMs
        });
      }
    }
    assert.equal(matrixRuns.length, 30, "the controlled-site matrix executes three tasks on each of ten distinct fixture origins");
    const matrixSuccesses = matrixRuns.filter(run => run.oraclePassed).length;
    assert.equal(matrixSuccesses, matrixRuns.length, `every controlled task must satisfy the independent browser-state oracle: ${JSON.stringify(matrixRuns.filter(run => !run.oraclePassed))}`);
    const matrixCorrectActions = matrixRuns.filter(run => run.actionCorrect).length;
    const matrixSiteResults = benchmarkSites.sites.map(site => {
      const runs = matrixRuns.filter(run => run.siteId === site.id);
      return {
        siteId: site.id,
        origin: new URL(site.url).origin,
        variant: site.variant,
        tasks: runs.length,
        oraclePasses: runs.filter(run => run.oraclePassed).length,
        correctActions: runs.filter(run => run.actionCorrect).length,
        meanEngineLatencyMs: Math.round(runs.reduce((sum, run) => sum + run.engineElapsedMs, 0) / runs.length)
      };
    });
    const processFamilyMetrics = await processFamilySampler.stop();
    if (process.platform === "linux") {
      assert.equal(processFamilyMetrics.processGroups, 2, "the sampler tracks the original and restarted disposable Chrome process groups");
      assert.ok(processFamilyMetrics.sampledPeakSummedRssMb > 0, "the process-family RSS sampler observes live Chrome memory");
      assert.ok(processFamilyMetrics.approximateCumulativeCpuSeconds > 0, "the process-family CPU sampler observes Chrome CPU time");
    }
    const benchmarkSuccesses = benchmarkRuns.filter(run => run.oraclePassed).length;
    const measuredLatency = benchmarkRuns.reduce((total, run) => total + run.elapsedMs, 0);
    const measuredActions = benchmarkRuns.reduce((total, run) => total + run.actions, 0);
    const measuredRecoveries = benchmarkRuns.reduce((total, run) => total + run.recoveries, 0);
    const measuredPlannerCalls = benchmarkRuns.reduce((total, run) => total + run.plannerCalls, 0);
    t.diagnostic(`Visible Chrome smoke-task metrics: ${JSON.stringify({ fixtureOriginCount: 1, correlatedTaskInstances: benchmarkRuns.length, oraclePasses: benchmarkSuccesses, actions: measuredActions, recoveries: measuredRecoveries, meanLatencyMs: Math.round(measuredLatency / benchmarkRuns.length), plannerCalls: measuredPlannerCalls, remoteModelCalls: 0, workflowReplayPlannerCalls: replayPlannerCalls + repairedReplayPlannerCalls, workflowRepairPlannerCalls: repairPlanner.calls, confidenceInterval: "not calculated: correlated task instances on one fixture origin" })}`);
    t.diagnostic(`Controlled-site navigation matrix: ${JSON.stringify({ fixtureOriginCount: benchmarkSites.sites.length, taskInstances: matrixRuns.length, tasksPerOrigin: 3, oraclePasses: matrixSuccesses, completionRate: matrixSuccesses / matrixRuns.length, correctActions: matrixCorrectActions, actionAccuracy: matrixCorrectActions / matrixRuns.length, recoveryEvents: matrixRuns.reduce((sum, run) => sum + run.recoveries, 0), humanHandoffs: 0, meanEngineLatencyMs: Math.round(matrixRuns.reduce((sum, run) => sum + run.engineElapsedMs, 0) / matrixRuns.length), plannerCalls: matrixRuns.reduce((sum, run) => sum + run.plannerCalls, 0), remoteModelCalls: 0, confidenceInterval: "not calculated: these are fixed controlled fixtures with repeated runs per origin", sites: matrixSiteResults })}`);
    t.diagnostic(`Disposable Chrome process-family resources for the complete visible integration run: ${JSON.stringify(processFamilyMetrics)}`);
    t.diagnostic("Visible Chrome E2E passed: separate explicit grants for two tabs, authenticated-cookie preservation across attach and protected navigation, independent target-scoped navigation and one-tab detach, two-target restoration after service-worker restart, nested OOPIF evidence/actions, delayed SPA rendering, verified workflow recording/replay without planner calls, intermediate stale-step recovery and repaired replay, broker restart recovery, tab-close lease invalidation, fresh-consent attachment, full Chrome process restart with reauthorization, visible DevTools behavior, requested screenshot retrieval, natural-language goals, injected stale-identity recovery, journal resume, native CDP input, and verified outcomes.");
  } finally {
    await processFamilySampler.stop();
    if (secondSession && !await settleWithin(secondSession.close(), 5_000)) t.diagnostic("Second BrowserSession close exceeded 5 seconds; terminating the disposable Chrome process before broker cleanup.");
    if (secondPageTargetId && connection) await connection.client.send("Target.closeTarget", { targetId: secondPageTargetId }).catch(() => {});
    if (session && !await settleWithin(session.close(), 5_000)) t.diagnostic("BrowserSession close exceeded 5 seconds; terminating the disposable Chrome process before broker cleanup.");
    if (connection) await connection.close().catch(() => {});
    if (chrome && chrome.exitCode === null) {
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill("SIGTERM"); }
      await Promise.race([once(chrome, "exit"), new Promise(resolve => setTimeout(resolve, 2_000))]);
      if (chrome.exitCode === null) {
        try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
      }
    }
    if (broker && !await settleWithin(broker.close(), 5_000)) t.diagnostic("Broker close exceeded 5 seconds after the disposable Chrome process exited.");
    if (site?.listening) {
      site.closeAllConnections();
      await new Promise(resolve => site.close(resolve));
    }
    if (childSite?.listening) {
      childSite.closeAllConnections();
      await new Promise(resolve => childSite.close(resolve));
    }
    if (benchmarkSites) await benchmarkSites.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
