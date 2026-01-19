importScripts("tracker-database.js");
/* global DEFAULT_TRACKER_DB, DEFAULT_CONSENT_PLATFORMS, DEFAULT_CONSENT_COOKIE_PATTERNS, DEFAULT_ALLOWLIST */

const STORAGE_KEYS = {
  SETTINGS: "settings",
  TAB_DATA: "tabData",
  CUSTOM_TRACKERS: "customTrackerDb"
};

const DEFAULT_SETTINGS = {
  globalEnabled: true,
  bannerPolicy: "eu_ca", // always | eu_ca | off
  retentionDays: 7,
  maxPagesPerDomain: 50,
  allowlist: DEFAULT_ALLOWLIST
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tabData: {}
};

function now() {
  return Date.now();
}

function normalizeDomain(host) {
  return (host || "").toLowerCase();
}

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host || "");
}

function getETLDPlus1(hostname) {
  if (!hostname) return "";
  const host = normalizeDomain(hostname);
  if (isIp(host)) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function isThirdParty(requestUrl, pageUrl) {
  try {
    const reqHost = new URL(requestUrl).hostname;
    const pageHost = new URL(pageUrl).hostname;
    return getETLDPlus1(reqHost) !== getETLDPlus1(pageHost);
  } catch (e) {
    return false;
  }
}

function matchesAllowlist(requestUrl) {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase();
    return state.settings.allowlist.some((d) => host === d || host.endsWith("." + d));
  } catch (e) {
    return false;
  }
}

function loadSettings() {
  chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TAB_DATA], (res) => {
    state.settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
    state.tabData = res[STORAGE_KEYS.TAB_DATA] || {};
  });
}

function saveSettings() {
  chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: state.settings });
}

function saveTabData() {
  chrome.storage.local.set({ [STORAGE_KEYS.TAB_DATA]: state.tabData });
}

function getTrackerDb(cb) {
  chrome.storage.local.get([STORAGE_KEYS.CUSTOM_TRACKERS], (res) => {
    cb(res[STORAGE_KEYS.CUSTOM_TRACKERS] || DEFAULT_TRACKER_DB);
  });
}

function findTrackerMatch(url, trackerDb) {
  const u = url.toLowerCase();
  for (const [name, entry] of Object.entries(trackerDb)) {
    for (const d of entry.domains) {
      if (u.includes(d.toLowerCase())) {
        return { name, ...entry };
      }
    }
  }
  return null;
}

function ensureTab(tabId) {
  if (!state.tabData[tabId]) {
    state.tabData[tabId] = {
      tabId,
      url: "",
      pageLoadTime: now(),
      lastSeen: now(),
      consentBanner: {
        platform: null,
        detected: false,
        detectedAt: null,
        userAction: null,
        actionAt: null,
        inferred: false
      },
      trackers: [],
      violations: []
    };
  }
  return state.tabData[tabId];
}

function recordViolation(tabData, violation) {
  tabData.violations.push(violation);
}

function classifyViolation(trackerInfo, type) {
  const severity = trackerInfo?.severity || "medium";
  return { type, severity };
}

function updateBadge(tabId) {
  const tabData = state.tabData[tabId];
  if (!tabData) return;
  const count = tabData.violations.length;
  if (!state.settings.globalEnabled) {
    chrome.action.setBadgeText({ tabId, text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#888888" });
    return;
  }
  if (count === 0) {
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00AA00" });
  } else if (count < 3) {
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#FFAA00" });
  } else {
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#FF0000" });
  }
}

function cleanupOldData() {
  const cutoff = now() - state.settings.retentionDays * 24 * 60 * 60 * 1000;
  const domainBuckets = {};
  for (const [tabId, data] of Object.entries(state.tabData)) {
    data.trackers = data.trackers.filter((t) => t.firedAt >= cutoff);
    data.violations = data.violations.filter((v) => v.timestamp >= cutoff);
    if (data.url) {
      const domain = getETLDPlus1(new URL(data.url).hostname);
      if (!domainBuckets[domain]) domainBuckets[domain] = [];
      domainBuckets[domain].push({ tabId, lastSeen: data.lastSeen || 0 });
    }
  }
  // Enforce max pages per domain by removing oldest tab entries
  for (const [domain, entries] of Object.entries(domainBuckets)) {
    entries.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const maxPages = state.settings.maxPagesPerDomain || 50;
    if (entries.length > maxPages) {
      for (const drop of entries.slice(maxPages)) {
        delete state.tabData[drop.tabId];
      }
    }
  }
  saveTabData();
}

function shouldProcessTab(tabId) {
  return state.settings.globalEnabled && typeof tabId === "number" && tabId >= 0;
}

async function ensureContentScript(tabId, url) {
  if (!url) return;
  const origin = new URL(url).origin;
  const hasPerm = await chrome.permissions.contains({ origins: [origin + "/*"] });
  if (!hasPerm) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (e) {
    // Ignore if already injected
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadSettings();
});

chrome.runtime.onStartup.addListener(() => {
  loadSettings();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    const td = ensureTab(tabId);
    td.url = tab.url || "";
    td.pageLoadTime = now();
    td.lastSeen = now();
    td.consentBanner = {
      platform: null,
      detected: false,
      detectedAt: null,
      userAction: null,
      actionAt: null,
      inferred: false
    };
    td.trackers = [];
    td.violations = [];
    saveTabData();
    updateBadge(tabId);
  }
  if (changeInfo.status === "complete") {
    ensureContentScript(tabId, tab.url || "");
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!shouldProcessTab(details.tabId)) return;
    const tabData = ensureTab(details.tabId);
    const pageUrl = tabData.url || "";
    const url = details.url;
    tabData.lastSeen = now();

    if (!pageUrl || !isThirdParty(url, pageUrl)) return;
    if (matchesAllowlist(url)) return;

    getTrackerDb((trackerDb) => {
      const trackerMatch = findTrackerMatch(url, trackerDb);
      const firedAt = now();
      const consent = tabData.consentBanner;
      const entry = {
        domain: new URL(url).hostname,
        url,
        firedAt,
        category: trackerMatch?.category || "unknown",
        severity: trackerMatch?.severity || "medium",
        trackerName: trackerMatch?.name || "unknown",
        violation: null,
        timeDelta: null,
        piiDetected: []
      };

      // Violation logic
      if (!consent.detected) {
        if (state.settings.bannerPolicy === "always") {
          entry.violation = "NO_BANNER_FOUND";
          entry.timeDelta = firedAt - tabData.pageLoadTime;
          recordViolation(tabData, {
            type: "NO_BANNER_FOUND",
            severity: entry.severity,
            tracker: entry.trackerName,
            details: "Tracker fired but no consent banner detected",
            timestamp: firedAt
          });
        } else if (state.settings.bannerPolicy === "eu_ca") {
          // Policy says banner required in some regions; do not hard-flag without geolocation
          entry.violation = "NO_BANNER_FOUND_POLICY";
        }
      } else if (consent.detected && consent.userAction === null) {
        entry.violation = "FIRED_PRE_CONSENT";
        entry.timeDelta = firedAt - (consent.detectedAt || tabData.pageLoadTime);
        const v = classifyViolation(trackerMatch, "FIRED_PRE_CONSENT");
        recordViolation(tabData, {
          type: "FIRED_PRE_CONSENT",
          severity: v.severity,
          tracker: entry.trackerName,
          details: "Fired before consent interaction",
          timestamp: firedAt
        });
      } else if (consent.userAction === "rejected") {
        entry.violation = "REJECTION_IGNORED";
        entry.timeDelta = firedAt - (consent.actionAt || tabData.pageLoadTime);
        const v = classifyViolation(trackerMatch, "REJECTION_IGNORED");
        recordViolation(tabData, {
          type: "REJECTION_IGNORED",
          severity: v.severity,
          tracker: entry.trackerName,
          details: "Tracker fired after reject",
          timestamp: firedAt
        });
      }

      tabData.trackers.push(entry);
      saveTabData();
      updateBadge(details.tabId);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  const tabData = ensureTab(tabId);

  if (msg.type === "PAGE_LOAD") {
    tabData.url = msg.url || tabData.url;
    tabData.pageLoadTime = msg.timestamp || tabData.pageLoadTime;
    saveTabData();
  }

  if (msg.type === "CONSENT_STATE") {
    const cs = tabData.consentBanner;
    if (msg.detected) {
      cs.detected = true;
      cs.platform = msg.platform || cs.platform;
      cs.detectedAt = cs.detectedAt || msg.timestamp || now();
    }
    if (msg.userAction) {
      cs.userAction = msg.userAction;
      cs.actionAt = msg.timestamp || now();
    }
    if (msg.inferred) {
      cs.inferred = true;
    }
    saveTabData();
    updateBadge(tabId);
  }

  if (msg.type === "SETTINGS_UPDATE") {
    state.settings = { ...state.settings, ...(msg.settings || {}) };
    saveSettings();
    updateBadge(tabId);
  }

  if (msg.type === "CLEAR_TAB") {
    delete state.tabData[tabId];
    saveTabData();
    updateBadge(tabId);
  }

  if (msg.type === "GET_STATE") {
    sendResponse({
      settings: state.settings,
      tabData: tabData
    });
  }

  if (msg.type === "INJECT_CONTENT") {
    const targetTabId = msg.tabId || tabId;
    chrome.tabs.get(targetTabId, (tab) => {
      if (tab?.url) {
        ensureContentScript(targetTabId, tab.url);
      }
    });
  }
});

setInterval(cleanupOldData, 60 * 60 * 1000);
