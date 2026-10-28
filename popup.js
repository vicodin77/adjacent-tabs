const DEFAULT_SETTINGS = {
  placeNewTabsRight: true,
  focusLeftOnClose: true,
};

const controls = Object.fromEntries(
  Object.keys(DEFAULT_SETTINGS).map((key) => [key, document.getElementById(key)]),
);

function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage().split("-")[0];
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const message = chrome.i18n.getMessage(element.dataset.i18n);
    if (message) {
      element.textContent = message;
    }
  }
}

function updateStatus() {
  const active = Object.values(controls).some((control) => control.checked);
  const status = document.getElementById("status");
  const statusText = document.getElementById("statusText");
  status.classList.toggle("paused", !active);
  statusText.textContent = chrome.i18n.getMessage(active ? "statusActive" : "statusPaused");
}

async function initialize() {
  localize();
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  for (const [key, control] of Object.entries(controls)) {
    control.checked = saved[key];
    control.addEventListener("change", async () => {
      await chrome.storage.local.set({ [key]: control.checked });
      updateStatus();
    });
  }
  updateStatus();
}

void initialize();
