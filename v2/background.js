const CONTEXT_MENU_ID = "gig-inspect-component";
const PENDING_CONTEXT_PREFIX = "gigPendingContextInspect.";
const PENDING_CONTEXT_MAX_AGE_MS = 30000;

// ─── Side Panel ────────────────────────────────────────────────────────────────

// Open the side panel when the user clicks the extension icon.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Tab Tracking ──────────────────────────────────────────────────────────────
// We track the most-recently activated tab so the eval relay can target it
// reliably even when the side panel (not a tab) has focus.

/** @type {Map<number, number>} windowId → tabId */
const activeTabByWindow = new Map();

// Seed the active tab map immediately when the service worker starts.
chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
  void chrome.runtime.lastError;
  const tab = tabs?.[0];
  if (tab?.id && tab?.windowId) {
    activeTabByWindow.set(tab.windowId, tab.id);
  }
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  activeTabByWindow.set(windowId, tabId);
  chrome.tabs.get(tabId, (tab) => {
    void chrome.runtime.lastError;
    chrome.runtime.sendMessage({ type: "gig-tab-navigated", tabId, url: tab?.url || "" }).catch(() => {});
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    void chrome.runtime.lastError;
    if (tabs?.[0]) activeTabByWindow.set(windowId, tabs[0].id);
  });
});

/**
 * Returns the ID of the active tab in the target window.
 * @param {number|null} windowId  optional hint from the panel
 * @returns {Promise<number|null>}
 */
function resolveActiveTabId(windowId) {
  if (typeof windowId === "number") {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, windowId }, (tabs) => {
        void chrome.runtime.lastError;
        const foundId = tabs?.[0]?.id ?? activeTabByWindow.get(windowId) ?? null;
        if (foundId) activeTabByWindow.set(windowId, foundId);
        resolve(foundId);
      });
    });
  }
  if (activeTabByWindow.size > 0) {
    const tabId = [...activeTabByWindow.values()].at(-1);
    if (tabId) return Promise.resolve(tabId);
  }
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs?.[0]?.id ?? null);
    });
  });
}

// ─── Context Menu ──────────────────────────────────────────────────────────────

function installContextMenu() {
  chrome.contextMenus.remove(CONTEXT_MENU_ID, () => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      { id: CONTEXT_MENU_ID, title: "Find Component in GNG DevTools", contexts: ["all"] },
      () => void chrome.runtime.lastError,
    );
  });
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || typeof tab?.id !== "number") return;
  // Open the Side Panel automatically on right-click inspect if it isn't open yet.
  if (chrome.sidePanel?.open && typeof tab.windowId === "number") {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
  chrome.storage.session.set({ [`${PENDING_CONTEXT_PREFIX}${tab.id}`]: Date.now() }, () => {
    chrome.runtime.sendMessage({ type: "gig-context-inspect", tabId: tab.id }, () => void chrome.runtime.lastError);
  });
});

// ─── Navigation relay ─────────────────────────────────────────────────────────
// Replaces chrome.devtools.network.onNavigated which is only available in DevTools panels.

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  chrome.runtime.sendMessage({ type: "gig-tab-navigated", tabId, url: tab.url || "" }).catch(() => {
    // Side panel may not be open — ignore.
  });
});

// ─── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ── Bridge file injection ──────────────────────────────────────────────────
  if (message?.type === "gig-inject-bridge") {
    resolveActiveTabId(message.windowId ?? null).then((tabId) => {
      if (!tabId) { sendResponse({ error: "No active tab found." }); return null; }
      return chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["eval-relay.js", "inspected-bridge.js"],
      });
    }).then((results) => {
      if (results !== null && results !== undefined) sendResponse({ ok: true });
    }).catch((err) => {
      sendResponse({ error: err?.message || String(err) });
    });
    return true;
  }

  // ── Eval relay: panel.js → background → scripting → page ──────────────────
  if (message?.type === "gig-eval") {
    resolveActiveTabId(message.windowId ?? null).then(async (tabId) => {
      if (!tabId) { sendResponse({ error: "No active tab found." }); return; }

      let results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: callGigEval,
        args: [message.expression],
      });

      let raw = results?.[0]?.result;
      if (raw?.__gigEvalNotInstalled) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          files: ["eval-relay.js"],
        });
        results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: callGigEval,
          args: [message.expression],
        });
        raw = results?.[0]?.result;
      }

      if (raw?.__gigEvalError) {
        sendResponse({ error: raw.message });
      } else {
        sendResponse({ result: raw ?? null });
      }
    }).catch((err) => {
      sendResponse({ error: err?.message || String(err) });
    });
    return true; // keep sendResponse alive for async response
  }

  // ── Pending context inspect query ─────────────────────────────────────────
  if (message?.type !== "gig-panel-ready" || typeof message.tabId !== "number") return false;

  const key = `${PENDING_CONTEXT_PREFIX}${message.tabId}`;
  chrome.storage.session.get(key).then((values) => {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Serialised and injected into the page by chrome.scripting.executeScript.
 * Calls the pre-installed window.__gigEval helper with the given expression.
 * @param {string} expression
 */
function callGigEval(expression) {
  if (typeof window.__gigEval !== "function") {
    return { __gigEvalNotInstalled: true };
  }
  return window.__gigEval(expression);
}
