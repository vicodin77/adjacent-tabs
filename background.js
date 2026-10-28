const windowStates = new Map();
const STORAGE_KEY = "windowStates";
const DEFAULT_SETTINGS = {
  placeNewTabsRight: true,
  focusLeftOnClose: true,
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
}

function serializableStates() {
  return Object.fromEntries(windowStates.entries());
}

function persistStates() {
  return chrome.storage.session.set({ [STORAGE_KEY]: serializableStates() });
}

async function restoreStates() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const entries = Object.entries(stored[STORAGE_KEY] ?? {});
    for (const [windowId, state] of entries) {
      windowStates.set(Number(windowId), state);
    }
  } catch (error) {
    console.debug("Не удалось восстановить состояние вкладок", error);
  }
}

function stateFromTabs(tabs) {
  const sortedTabs = [...tabs].sort((a, b) => a.index - b.index);
  const activeTab = sortedTabs.find((tab) => tab.active);

  return {
    tabIds: sortedTabs.map((tab) => tab.id),
    activeTabId: activeTab?.id ?? null,
    lastActivation: null,
  };
}

async function loadWindow(windowId) {
  try {
    const browserWindow = await chrome.windows.get(windowId, { populate: true });
    if (browserWindow.type !== "normal") {
      return null;
    }

    const previousState = windowStates.get(windowId);
    const nextState = stateFromTabs(browserWindow.tabs ?? []);
    nextState.lastActivation = previousState?.lastActivation ?? null;
    windowStates.set(windowId, nextState);
    await persistStates();
    return nextState;
  } catch {
    windowStates.delete(windowId);
    return null;
  }
}

async function loadAllWindows() {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"],
  });

  windowStates.clear();
  for (const browserWindow of windows) {
    windowStates.set(browserWindow.id, stateFromTabs(browserWindow.tabs ?? []));
  }
  await persistStates();
}

async function placeNewTabNextToCurrent(tab) {
  await readyPromise;
  if (!settings.placeNewTabsRight) {
    await loadWindow(tab.windowId);
    return;
  }

  let state = windowStates.get(tab.windowId) ?? (await loadWindow(tab.windowId));
  if (!state) {
    return;
  }

  const referenceTabId =
    tab.openerTabId ??
    (state.activeTabId !== tab.id ? state.activeTabId : state.lastActivation?.fromTabId);

  if (referenceTabId == null || referenceTabId === tab.id) {
    await loadWindow(tab.windowId);
    return;
  }

  try {
    const [referenceTab, allTabs] = await Promise.all([
      chrome.tabs.get(referenceTabId),
      chrome.tabs.query({ windowId: tab.windowId }),
    ]);

    if (referenceTab.windowId !== tab.windowId) {
      return;
    }

    let targetIndex = referenceTab.index + 1;

    // Закреплённые и обычные вкладки образуют отдельные области. Если текущая
    // вкладка закреплена, ставим новую в ближайшую разрешённую позицию справа.
    if (!tab.pinned && referenceTab.pinned) {
      const pinnedCount = allTabs.filter((candidate) => candidate.pinned).length;
      targetIndex = Math.max(targetIndex, pinnedCount);
    }

    await chrome.tabs.move(tab.id, { index: targetIndex });
  } catch (error) {
    console.debug("Не удалось переместить новую вкладку", error);
  } finally {
    await loadWindow(tab.windowId);
  }
}

const readyPromise = Promise.all([restoreStates(), loadSettings()]).then(() => {
  if (windowStates.size === 0) {
    return loadAllWindows();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  void placeNewTabNextToCurrent(tab);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void readyPromise.then(async () => {
    const state = windowStates.get(windowId);
    if (!state) {
      await loadWindow(windowId);
      return;
    }

    if (state.activeTabId !== tabId) {
      state.lastActivation = {
        fromTabId: state.activeTabId,
        toTabId: tabId,
        at: Date.now(),
      };
      state.activeTabId = tabId;
      await persistStates();
    }
  });
});

chrome.tabs.onMoved.addListener((_tabId, { windowId }) => {
  void readyPromise.then(() => loadWindow(windowId));
});

chrome.tabs.onAttached.addListener((_tabId, { newWindowId }) => {
  void readyPromise.then(() => loadWindow(newWindowId));
});

chrome.tabs.onDetached.addListener((_tabId, { oldWindowId }) => {
  void readyPromise.then(() => loadWindow(oldWindowId));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void (async () => {
    await readyPromise;
    if (removeInfo.isWindowClosing) {
      windowStates.delete(removeInfo.windowId);
      return;
    }

    const state = windowStates.get(removeInfo.windowId);
    if (!state) {
      await loadWindow(removeInfo.windowId);
      return;
    }

    const closedIndex = state.tabIds.indexOf(tabId);
    const leftTabId = closedIndex > 0 ? state.tabIds[closedIndex - 1] : null;

    // Обычно onRemoved приходит до автоматической активации соседней вкладки.
    // Короткий fallback также покрывает браузеры с обратным порядком событий.
    const activationJustLeftClosedTab =
      state.lastActivation?.fromTabId === tabId &&
      state.lastActivation.toTabId === state.activeTabId &&
      Date.now() - state.lastActivation.at < 250;
    const closedTabWasActive =
      state.activeTabId === tabId || activationJustLeftClosedTab;

    state.tabIds = state.tabIds.filter((id) => id !== tabId);
    await persistStates();

    if (settings.focusLeftOnClose && closedTabWasActive && leftTabId != null) {
      try {
        await chrome.tabs.update(leftTabId, { active: true });
      } catch (error) {
        console.debug("Не удалось активировать вкладку слева", error);
      }
    }

    await loadWindow(removeInfo.windowId);
  })();
});

chrome.windows.onCreated.addListener((browserWindow) => {
  if (browserWindow.id != null) {
    void readyPromise.then(() => loadWindow(browserWindow.id));
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  windowStates.delete(windowId);
  void persistStates();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) {
      settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void loadAllWindows();
});

chrome.runtime.onStartup.addListener(() => {
  void loadAllWindows();
});

