const CONTEXT_MENU_ID = "gig-inspect-component";
const PENDING_CONTEXT_PREFIX = "gigPendingContextInspect.";
const PENDING_CONTEXT_MAX_AGE_MS = 30000;

function installContextMenu() {
  chrome.contextMenus.remove(CONTEXT_MENU_ID, () => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Find Component in GNG DevTools",
      contexts: ["all"],
    }, () => void chrome.runtime.lastError);
  });
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || typeof tab?.id !== "number") return;
  chrome.storage.session.set({ [`${PENDING_CONTEXT_PREFIX}${tab.id}`]: Date.now() }, () => {
    chrome.runtime.sendMessage({
      type: "gig-context-inspect",
      tabId: tab.id,
    }, () => void chrome.runtime.lastError);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "gig-panel-ready" || typeof message.tabId !== "number") return false;

  const key = `${PENDING_CONTEXT_PREFIX}${message.tabId}`;
  chrome.storage.session.get(key).then(values => {
    const clickedAt = values[key];
    const pending = clickedAt && Date.now() - clickedAt <= PENDING_CONTEXT_MAX_AGE_MS;
    if (!pending) {
      if (clickedAt) chrome.storage.session.remove(key);
      sendResponse({ hasPendingContextInspect: false });
      return;
    }
    chrome.storage.session.remove(key).then(() => {
      sendResponse({ hasPendingContextInspect: true });
    });
  }).catch(() => sendResponse({ hasPendingContextInspect: false }));
  return true;
});
