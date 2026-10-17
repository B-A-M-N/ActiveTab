const page = document.querySelector("#page");
const status = document.querySelector("#status");
const attach = document.querySelector("#attach");
const detach = document.querySelector("#detach");
let currentTabId;

function showAttached(value) {
  const isAttached = Boolean(value?.attached);
  status.textContent = isAttached ? "This tab is attached to the local ActiveTab broker." : "No tab is attached.";
  attach.hidden = isAttached;
  detach.hidden = !isAttached;
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  currentTabId = tab?.id;
  page.textContent = tab ? `${tab.title || "Untitled page"}\n${tab.url || ""}` : "No active tab.";
  attach.disabled = !Number.isInteger(currentTabId);
  return chrome.runtime.sendMessage({ type: "activetab.status", tabId: currentTabId });
}).then(showAttached);

attach.addEventListener("click", async () => {
  if (!Number.isInteger(currentTabId)) { status.textContent = "No active Chrome tab is available."; return; }
  attach.disabled = true;
  status.textContent = "Connecting to the local broker…";
  const response = await chrome.runtime.sendMessage({ type: "activetab.attach-current", tabId: currentTabId });
  attach.disabled = false;
  if (response?.error) { status.textContent = response.error; return; }
  showAttached(response);
});

detach.addEventListener("click", async () => {
  detach.disabled = true;
  const response = await chrome.runtime.sendMessage({ type: "activetab.detach", tabId: currentTabId });
  detach.disabled = false;
  if (response?.error) { status.textContent = response.error; return; }
  showAttached(null);
});
