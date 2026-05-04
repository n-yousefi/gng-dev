const CONTEXT_MENU_ID = 'gig-inspect-component';

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Open in GIG Components',
      contexts: ['all'],
    });
  });
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);
installContextMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  chrome.runtime.sendMessage({
    type: 'gig-context-inspect',
    tabId: tab.id,
  });
});
