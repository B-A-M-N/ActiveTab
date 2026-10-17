const NATIVE_HOST = "com.activetab.bridge";
const PROTOCOL = "activetab/native/1";
const MAX_AUTHORIZED_TABS = 8;
let nativePort;
let readyPromise;
const attached = new Map();
let persistenceQueue = Promise.resolve();
let reconnectTimer;
let reconnectAttempt = 0;
const pendingAttachmentAcks = new Map();
let nextAttachmentId = 1;

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

function send(message) {
  if (!nativePort) throw new Error("ActiveTab local broker is disconnected.");
  nativePort.postMessage(message);
}

function reportDetached(targetId, reason) {
  const previous = attached.get(targetId);
  attached.delete(targetId);
  if (previous) {
    void persistAuthorizedTargets().catch(() => {});
    try { send({ kind: "detached", targetId: previous.targetId, reason: String(reason ?? "detached") }); } catch { /* broker is already gone */ }
  }
  if (attached.size === 0) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
  }
}

async function persistAuthorizedTargets() {
  const authorizedTargets = [...attached.values()].map(target => ({ tabId: target.tabId, targetId: target.targetId }));
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ authorizedTargets });
    await chrome.storage.session.remove("authorizedTarget").catch(() => {});
  });
  await persistenceQueue;
}

async function detachCurrent(tabId, reason = "user-requested") {
  const previous = [...attached.values()].find(target => target.tabId === tabId);
  if (!previous) return { detached: true };
  try { await chrome.debugger.detach({ tabId: previous.tabId }); }
  catch { /* The browser may already have detached this target. */ }
  reportDetached(previous.targetId, reason);
  return { detached: true };
}

function sendBrokerResponse(id, result, error) {
  try { send({ kind: "response", id, ...(error ? { error: { message: String(error.message ?? error) } } : { result: result ?? {} }) }); }
  catch { /* The broker will observe the lost native host connection. */ }
}

async function handleBrokerRequest(message) {
  if (message.method === "cdp.send") {
    const target = attached.get(message.targetId);
    if (!target) throw new Error("CDP request is outside the extension-authorized tab.");
    const method = message.cdpMethod;
    const namespace = typeof method === "string" ? method.split(".", 1)[0] : "";
    const allowed = new Set(["Page", "DOM", "DOMSnapshot", "Runtime", "Accessibility", "Network", "Input"]);
    const allowedTargetMethods = new Set(["Target.setAutoAttach", "Target.attachToTarget", "Target.detachFromTarget", "Target.getTargets", "Target.getTargetInfo"]);
    if (!allowed.has(namespace) && !allowedTargetMethods.has(method)) throw new Error("CDP method is outside ActiveTab's page-control allowlist.");
    return await chrome.debugger.sendCommand({ tabId: target.tabId, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }, method, message.params ?? {});
  }
  if (message.method === "debugger.detach") {
    const target = attached.get(message.targetId);
    if (!target) return { detached: true };
    return await detachCurrent(target.tabId, "mcp-session-closed");
  }
  throw new Error("Unknown ActiveTab broker request.");
}

async function onNativeMessage(message) {
  if (message?.kind === "ready" && message.protocol === PROTOCOL) return;
  if (message?.kind === "attached-ack" && typeof message.id === "string") {
    const pending = pendingAttachmentAcks.get(message.id);
    if (!pending) return;
    pendingAttachmentAcks.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error.message ?? message.error)));
    else pending.resolve();
    return;
  }
  if (message?.kind === "request" && Number.isInteger(message.id)) {
    try { sendBrokerResponse(message.id, await handleBrokerRequest(message)); }
    catch (error) { sendBrokerResponse(message.id, null, error); }
  }
}

function notifyBrokerAttached(target) {
  const id = `attached-${Date.now()}-${nextAttachmentId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAttachmentAcks.delete(id);
      reject(new Error("Timed out waiting for the local broker to authorize this tab."));
    }, 5_000);
    pendingAttachmentAcks.set(id, { resolve, reject, timer });
    try { send({ kind: "attached", id, extensionId: chrome.runtime.id, target }); }
    catch (error) {
      clearTimeout(timer);
      pendingAttachmentAcks.delete(id);
      reject(error);
    }
  });
}

function scheduleBrokerReconnect() {
  if (attached.size === 0 || nativePort || reconnectTimer || reconnectAttempt >= 8) return;
  const delay = Math.min(250 * (2 ** reconnectAttempt), 8_000);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (attached.size === 0 || nativePort) return;
    void connectBroker().catch(() => scheduleBrokerReconnect());
  }, delay);
}

async function refreshAttachedTarget(targetId) {
  const current = attached.get(targetId);
  if (!current) return;
  const [{ targetInfo }, tab] = await Promise.all([
    chrome.debugger.sendCommand({ tabId: current.tabId }, "Target.getTargetInfo", {}),
    chrome.tabs.get(current.tabId)
  ]);
  if (targetInfo?.type !== "page" || targetInfo.targetId !== current.targetId || !Number.isInteger(tab?.id)) {
    throw new Error("The previously authorized Chrome tab is no longer attached.");
  }
  if (attached.get(targetId) !== current) throw new Error("The previously authorized Chrome tab was detached during broker restoration.");
  const url = safeUrl(targetInfo.url ?? tab.url ?? "");
  if (!url) throw new Error("The previously authorized tab is no longer an HTTP(S) page.");
  attached.set(targetId, { ...current, title: String(targetInfo.title ?? tab.title ?? ""), url });
  await persistAuthorizedTargets();
}

function connectBroker() {
  if (nativePort && readyPromise) return readyPromise;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out connecting to the local ActiveTab broker."));
      port.disconnect();
    }, 5_000);
    port.onMessage.addListener(message => {
      if (message?.kind === "ready" && message.protocol === PROTOCOL) {
        clearTimeout(timer);
        void (async () => {
          try {
            for (const targetId of [...attached.keys()]) {
              try {
                await refreshAttachedTarget(targetId);
                await notifyBrokerAttached({ ...attached.get(targetId), id: targetId, userAuthorized: true });
              } catch (error) {
                if (nativePort !== port) throw error;
                const stale = attached.get(targetId);
                if (stale) {
                  await chrome.debugger.detach({ tabId: stale.tabId }).catch(() => {});
                  reportDetached(targetId, "broker-rejected-restoration");
                }
              }
            }
            if (!settled) {
              settled = true;
              reconnectAttempt = 0;
              resolve();
            }
          } catch (error) {
            if (!settled) { settled = true; reject(error); }
            port.disconnect();
          }
        })();
        return;
      }
      if (message?.kind === "error") return;
      void onNativeMessage(message);
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError?.message ?? "Native host disconnected.";
      if (nativePort === port) {
        nativePort = undefined;
        readyPromise = undefined;
      }
      for (const entry of pendingAttachmentAcks.values()) { clearTimeout(entry.timer); entry.reject(new Error(error)); }
      pendingAttachmentAcks.clear();
      if (!settled) { settled = true; reject(new Error(error)); }
      scheduleBrokerReconnect();
    });
    try { port.postMessage({ kind: "hello", extensionId: chrome.runtime.id, protocol: PROTOCOL }); }
    catch (error) {
      clearTimeout(timer);
      settled = true;
      nativePort = undefined;
      readyPromise = undefined;
      reject(error);
      scheduleBrokerReconnect();
    }
  });
  return readyPromise;
}

async function restoreAuthorizedTarget() {
  const stored = await chrome.storage.session.get(["authorizedTargets", "authorizedTarget"]);
  const targets = Array.isArray(stored.authorizedTargets) ? stored.authorizedTargets : (stored.authorizedTarget ? [stored.authorizedTarget] : []);
  for (const target of targets.slice(0, MAX_AUTHORIZED_TABS)) {
    if (!Number.isInteger(target?.tabId) || typeof target?.targetId !== "string") continue;
    let targetInfo;
    let tab;
    try {
      [targetInfo, tab] = await Promise.all([
        chrome.debugger.sendCommand({ tabId: target.tabId }, "Target.getTargetInfo", {}).then(result => result.targetInfo),
        chrome.tabs.get(target.tabId)
      ]);
    } catch { continue; }
    if (targetInfo?.type !== "page" || targetInfo.targetId !== target.targetId || !Number.isInteger(tab?.id)) continue;
    const url = safeUrl(targetInfo.url ?? tab.url ?? "");
    if (!url) continue;
    attached.set(targetInfo.targetId, { tabId: tab.id, targetId: targetInfo.targetId, title: String(targetInfo.title ?? tab.title ?? ""), url });
  }
  await persistAuthorizedTargets();
  if (attached.size) await connectBroker().catch(() => {});
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const target = [...attached.values()].find(item => source.tabId === item.tabId);
  if (!target || typeof method !== "string") return;
  try { send({ kind: "event", targetId: target.targetId, method, params: params ?? {}, sessionId: source.sessionId ?? null }); }
  catch { /* transport disconnect will trigger detach */ }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const target = [...attached.values()].find(item => source.tabId === item.tabId);
  if (target) reportDetached(target.targetId, reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "activetab.attach-current") {
    void attachCurrentTab(message.tabId).then(sendResponse, error => sendResponse({ error: String(error.message ?? error) }));
    return true;
  }
  if (message?.type === "activetab.detach") {
    void detachCurrent(message.tabId).then(sendResponse, error => sendResponse({ error: String(error.message ?? error) }));
    return true;
  }
  if (message?.type === "activetab.status") {
    const target = [...attached.values()].find(item => item.tabId === message.tabId);
    sendResponse({ attached: target ? { title: target.title, url: target.url } : null });
    return false;
  }
  return false;
});

async function attachCurrentTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("The ActiveTab popup did not identify its active tab.");
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !Number.isInteger(tab.id)) throw new Error("The selected Chrome tab is no longer available.");
  await connectBroker();
  const existing = [...attached.values()].find(target => target.tabId === tab.id);
  if (existing) return { attached: { title: existing.title, url: existing.url } };
  if (attached.size >= MAX_AUTHORIZED_TABS) throw new Error(`ActiveTab supports at most ${MAX_AUTHORIZED_TABS} explicitly attached tabs at once.`);
  await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  try {
    const { targetInfo } = await chrome.debugger.sendCommand({ tabId: tab.id }, "Target.getTargetInfo", {});
    if (targetInfo?.type !== "page" || typeof targetInfo.targetId !== "string") throw new Error("Chrome did not expose a page target for the selected tab.");
    const url = safeUrl(targetInfo.url ?? tab.url ?? "");
    if (!url) throw new Error("ActiveTab can attach only to HTTP(S) pages.");
    const target = { tabId: tab.id, targetId: targetInfo.targetId, title: String(targetInfo.title ?? tab.title ?? ""), url };
    attached.set(target.targetId, target);
    await persistAuthorizedTargets();
    await notifyBrokerAttached({ ...target, id: target.targetId, userAuthorized: true });
    return { attached: { title: target.title, url: target.url } };
  } catch (error) {
    const target = [...attached.values()].find(item => item.tabId === tab.id);
    if (target) attached.delete(target.targetId);
    await persistAuthorizedTargets().catch(() => {});
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    throw error;
  }
}

void restoreAuthorizedTarget().catch(() => {});
