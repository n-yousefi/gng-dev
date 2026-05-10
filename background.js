const CONTEXT_MENU_ID = "gig-inspect-component";
const pendingContextByTabId = new Map();

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Find Component in GNG DevTools",
      contexts: ["all"],
    });
  });
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);
installContextMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  pendingContextByTabId.set(tab.id, Date.now());
  chrome.runtime.sendMessage({
    type: "gig-context-inspect",
    tabId: tab.id,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "gig-panel-ready" || typeof message.tabId !== "number") return false;

  const clickedAt = pendingContextByTabId.get(message.tabId);
  if (!clickedAt) {
    sendResponse({ hasPendingContextInspect: false });
    return false;
  }

  pendingContextByTabId.delete(message.tabId);
  sendResponse({ hasPendingContextInspect: true });
  return false;
});
