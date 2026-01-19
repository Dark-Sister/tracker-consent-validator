/* global DEFAULT_TRACKER_DB */

const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatBanner(consent) {
  if (!consent) return "—";
  if (consent.detected) return consent.platform || "Detected";
  return "Not detected";
}

function formatAction(consent) {
  if (!consent) return "—";
  return consent.userAction || "None";
}

function severityColor(sev) {
  if (sev === "critical") return "#d32f2f";
  if (sev === "high") return "#f57c00";
  if (sev === "medium") return "#fbc02d";
  return "#388e3c";
}

function renderViolations(list) {
  const el = $("violations");
  el.innerHTML = "";
  if (!list || list.length === 0) {
    el.textContent = "No violations found.";
    return;
  }
  for (const v of list) {
    const item = document.createElement("div");
    item.style.marginBottom = "6px";
    item.innerHTML = `<strong style="color:${severityColor(v.severity)}">${v.severity.toUpperCase()}</strong> ${v.tracker} — ${v.type}`;
    el.appendChild(item);
  }
}

function setStatus(count, enabled) {
  const el = $("status");
  if (!enabled) {
    el.textContent = "OFF";
    el.style.color = "#888";
    return;
  }
  if (count === 0) {
    el.textContent = "No violations";
    el.style.color = "#2e7d32";
  } else {
    el.textContent = `${count} violation${count > 1 ? "s" : ""}`;
    el.style.color = "#d32f2f";
  }
}

async function refreshUI() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (!res) return;
    const settings = res.settings || {};
    const tabData = res.tabData || {};
    $("toggleGlobal").textContent = settings.globalEnabled ? "On" : "Off";
    $("policy").value = settings.bannerPolicy || "eu_ca";
    $("retention").value = settings.retentionDays || 7;
    $("maxPages").value = settings.maxPagesPerDomain || 50;

    setStatus((tabData.violations || []).length, settings.globalEnabled);
    $("banner").textContent = formatBanner(tabData.consentBanner);
    $("action").textContent = formatAction(tabData.consentBanner);
    renderViolations(tabData.violations || []);
  });
}

async function enableOnThisSite() {
  const tab = await getActiveTab();
  if (!tab || !tab.url) return;
  const origin = new URL(tab.url).origin;
  chrome.permissions.request({ origins: [origin + "/*"] }, (granted) => {
    if (granted) {
      chrome.runtime.sendMessage({ type: "INJECT_CONTENT", tabId: tab.id });
      refreshUI();
    }
  });
}

function exportReport() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, async (res) => {
    const tab = await getActiveTab();
    const report = {
      url: tab?.url || "",
      timestamp: new Date().toISOString(),
      consentBanner: res?.tabData?.consentBanner || {},
      violations: res?.tabData?.violations || [],
      trackers: res?.tabData?.trackers || []
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: "consent-report.json", saveAs: true });
  });
}

function handleImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      chrome.storage.local.set({ customTrackerDb: parsed }, () => {
        alert("Tracker DB imported.");
      });
    } catch (e) {
      alert("Invalid JSON.");
    }
  };
  reader.readAsText(file);
}

function updateSettings(patch) {
  chrome.runtime.sendMessage({ type: "SETTINGS_UPDATE", settings: patch }, refreshUI);
}

document.addEventListener("DOMContentLoaded", () => {
  refreshUI();

  $("toggleGlobal").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      const enabled = !res?.settings?.globalEnabled;
      updateSettings({ globalEnabled: enabled });
    });
  });

  $("enableSite").addEventListener("click", enableOnThisSite);
  $("clearData").addEventListener("click", () => chrome.runtime.sendMessage({ type: "CLEAR_TAB" }, refreshUI));
  $("exportReport").addEventListener("click", exportReport);
  $("importFile").addEventListener("change", (e) => handleImport(e.target.files[0]));

  $("policy").addEventListener("change", (e) => updateSettings({ bannerPolicy: e.target.value }));
  $("retention").addEventListener("change", (e) => updateSettings({ retentionDays: Number(e.target.value) }));
  $("maxPages").addEventListener("change", (e) => updateSettings({ maxPagesPerDomain: Number(e.target.value) }));
});
