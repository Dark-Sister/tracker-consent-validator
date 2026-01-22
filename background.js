importScripts("tracker-database.js");
/* global DEFAULT_TRACKER_DB, DEFAULT_CONSENT_PLATFORMS, DEFAULT_CONSENT_COOKIE_PATTERNS, DEFAULT_ALLOWLIST */

const STORAGE_KEYS = {
  SETTINGS: "settings",
  TAB_DATA: "tabData",
  CUSTOM_TRACKERS: "customTrackerDb",
  LLM_CACHE: "llmCache",
  POLICY_RATE_LIMIT: "policyRateLimit"
};

const DEFAULT_SETTINGS = {
  globalEnabled: true,
  bannerPolicy: "eu_ca", // always | eu_ca | off
  retentionDays: 7,
  maxPagesPerDomain: 50,
  allowlist: DEFAULT_ALLOWLIST,
  llmTrackerEnabled: false,
  policyAnalysisEnabled: false,
  anthropicApiKey: ""
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  tabData: {},
  llmCache: {},
  policyRateLimit: {}
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
  chrome.storage.local.get(
    [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TAB_DATA, STORAGE_KEYS.LLM_CACHE, STORAGE_KEYS.POLICY_RATE_LIMIT],
    (res) => {
    state.settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
    state.tabData = res[STORAGE_KEYS.TAB_DATA] || {};
    state.llmCache = res[STORAGE_KEYS.LLM_CACHE] || {};
    state.policyRateLimit = res[STORAGE_KEYS.POLICY_RATE_LIMIT] || {};
  });
}

function saveSettings() {
  chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: state.settings });
}

function saveTabData() {
  chrome.storage.local.set({ [STORAGE_KEYS.TAB_DATA]: state.tabData });
}

function saveLlmCache() {
  chrome.storage.local.set({ [STORAGE_KEYS.LLM_CACHE]: state.llmCache });
}

function savePolicyRateLimit() {
  chrome.storage.local.set({ [STORAGE_KEYS.POLICY_RATE_LIMIT]: state.policyRateLimit });
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

function findTrackerEntryByRequestId(tabData, requestId) {
  if (!tabData || !requestId) return null;
  for (let i = tabData.trackers.length - 1; i >= 0; i -= 1) {
    const t = tabData.trackers[i];
    if (t.requestId === requestId) return t;
  }
  return null;
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

function hashString(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function getLlmCache(key) {
  return state.llmCache[key] || null;
}

function setLlmCache(key, value) {
  state.llmCache[key] = { value, ts: now() };
  // Simple bounded cache: keep last 500 entries
  const entries = Object.entries(state.llmCache);
  if (entries.length > 500) {
    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    for (const [k] of entries.slice(0, entries.length - 500)) {
      delete state.llmCache[k];
    }
  }
  saveLlmCache();
}

async function callClaudeTrackerAnalysis(payload, apiKey) {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    temperature: 0.0,
    messages: [
      {
        role: "user",
        content:
          "Analyze if this tracking request violates the user's privacy consent settings: " +
          payload.consent +
          ". Request details: " +
          payload.request +
          '. Return JSON with: {"violates": boolean, "reason": string, "severity": "low"|"medium"|"high"}'
      }
    ],
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Claude error ${resp.status}`);
  }
  const data = await resp.json();
  const content = data?.content?.[0]?.text || "{}";
  return JSON.parse(content);
}

async function callClaudePolicyAnalysis(payload, apiKey) {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    temperature: 0.0,
    messages: [
      {
        role: "user",
        content:
          "Compare stated privacy policy with actual tracking behavior. Policy: " +
          payload.policy +
          ". Observed trackers: " +
          payload.trackers +
          '. Return JSON: {"contradictions":[{"claim":string,"actual_behavior":string,"severity":string}],"deception_score":0-100}'
      }
    ]
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Claude error ${resp.status}`);
  }
  const data = await resp.json();
  const content = data?.content?.[0]?.text || "{}";
  return JSON.parse(content);
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
        requestId: details.requestId,
        requestType: details.type,
        method: details.method,
        category: trackerMatch?.category || "unknown",
        severity: trackerMatch?.severity || "medium",
        trackerName: trackerMatch?.name || "unknown",
        violation: null,
        timeDelta: null,
        piiDetected: [],
        headers: [],
        cookies: ""
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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!shouldProcessTab(details.tabId)) return;
    const tabData = ensureTab(details.tabId);
    const pageUrl = tabData.url || "";
    const url = details.url;

    if (!pageUrl || !isThirdParty(url, pageUrl)) return;
    if (matchesAllowlist(url)) return;

    const entry = findTrackerEntryByRequestId(tabData, details.requestId);
    if (!entry) return;

    entry.headers = details.requestHeaders || [];
    const cookieHeader = (details.requestHeaders || []).find(
      (h) => h.name && h.name.toLowerCase() === "cookie"
    );
    entry.cookies = cookieHeader?.value || "";

    // LLM enhanced analysis (opt-in)
    if (state.settings.llmTrackerEnabled && state.settings.anthropicApiKey && !entry.llmAnalyzed) {
      entry.llmAnalyzed = true;
      try {
        const consentSummary = JSON.stringify({
          bannerPolicy: state.settings.bannerPolicy,
          detected: tabData.consentBanner.detected,
          action: tabData.consentBanner.userAction
        });
        const requestSummary = JSON.stringify({
          url,
          method: details.method,
          type: details.type,
          cookies: entry.cookies,
          headers: entry.headers
        });
        const cacheKey = hashString(consentSummary + requestSummary);
        const cached = getLlmCache(cacheKey);
        const applyResult = (result) => {
          if (result?.violates) {
            recordViolation(tabData, {
              type: "LLM_ANALYSIS",
              severity: result.severity || "medium",
              tracker: entry.trackerName,
              details: result.reason || "LLM flagged violation",
              timestamp: now()
            });
          }
        };
        if (cached) {
          applyResult(cached.value);
        } else {
          callClaudeTrackerAnalysis(
            { consent: consentSummary, request: requestSummary },
            state.settings.anthropicApiKey
          )
            .then((result) => {
              setLlmCache(cacheKey, result);
              applyResult(result);
              saveTabData();
              updateBadge(details.tabId);
            })
            .catch(() => {
              // Fallback to rule-based only
            });
        }
      } catch (e) {
        // Ignore LLM errors; keep rule-based detection
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const resolveTabId = (cb) => {
    if (sender?.tab?.id) {
      cb(sender.tab.id);
      return;
    }
    if (typeof msg.tabId === "number") {
      cb(msg.tabId);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      cb(tabs?.[0]?.id);
    });
  };

  resolveTabId((tabId) => {
    if (!tabId && msg.type !== "SETTINGS_UPDATE") {
      sendResponse?.({ ok: false, error: "No active tab" });
      return;
    }
    const tabData = tabId ? ensureTab(tabId) : null;

    if (msg.type === "PAGE_LOAD" && tabData) {
      tabData.url = msg.url || tabData.url;
      tabData.pageLoadTime = msg.timestamp || tabData.pageLoadTime;
      saveTabData();
    }

    if (msg.type === "CONSENT_STATE" && tabData) {
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
      if (tabId) updateBadge(tabId);
    }

    if (msg.type === "CLEAR_TAB" && tabData) {
      delete state.tabData[tabId];
      saveTabData();
      updateBadge(tabId);
    }

    if (msg.type === "GET_STATE") {
      sendResponse?.({
        settings: state.settings,
        tabData: tabData || {}
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

    if (msg.type === "RUN_POLICY_ANALYSIS") {
      const targetTabId = msg.tabId || tabId;
      chrome.tabs.get(targetTabId, (tab) => {
      if (!tab?.url) {
        if (tabId) {
          const td = ensureTab(tabId);
          td.policyAnalysisStatus = { status: "error", message: "No active URL", at: now() };
          saveTabData();
        }
        sendResponse({ ok: false, error: "No active URL" });
        return;
      }
      const domain = getETLDPlus1(new URL(tab.url).hostname);
      const lastRun = state.policyRateLimit[domain] || 0;
      if (now() - lastRun < 24 * 60 * 60 * 1000) {
        if (tabId) {
          const td = ensureTab(tabId);
          td.policyAnalysisStatus = { status: "error", message: "Already ran today.", at: now() };
          saveTabData();
        }
        sendResponse({ ok: false, error: "Policy analysis already ran for this domain today." });
        return;
      }
      if (!state.settings.policyAnalysisEnabled) {
        if (tabId) {
          const td = ensureTab(tabId);
          td.policyAnalysisStatus = { status: "error", message: "Policy analysis disabled.", at: now() };
          saveTabData();
        }
        sendResponse({ ok: false, error: "Policy analysis is disabled in settings." });
        return;
      }
      if (!state.settings.anthropicApiKey) {
        if (tabId) {
          const td = ensureTab(tabId);
          td.policyAnalysisStatus = { status: "error", message: "Missing Claude API key.", at: now() };
          saveTabData();
        }
        sendResponse({ ok: false, error: "Missing Claude API key." });
        return;
      }

      // Ensure content script exists, then ask it to scrape policy text
      ensureContentScript(targetTabId, tab.url);
      chrome.tabs.sendMessage(
        targetTabId,
        { type: "SCRAPE_POLICY" },
        (policyRes) => {
          if (chrome.runtime.lastError) {
            if (tabId) {
              const td = ensureTab(tabId);
              td.policyAnalysisStatus = { status: "error", message: "Enable this site first.", at: now() };
              saveTabData();
            }
            sendResponse({ ok: false, error: "Content script not available. Enable this site first." });
            return;
          }
          if (!policyRes?.policyText) {
            if (tabId) {
              const td = ensureTab(tabId);
              td.policyAnalysisStatus = { status: "error", message: "No privacy policy found.", at: now() };
              saveTabData();
            }
            sendResponse({ ok: false, error: "No privacy policy found." });
            return;
          }

          const startTime = now();
          if (tabId) {
            const td = ensureTab(tabId);
            td.policyAnalysisStatus = { status: "running", message: "Running...", at: now() };
            saveTabData();
          }
          sendResponse({ ok: true, status: "running" });

          setTimeout(() => {
            const td = ensureTab(targetTabId);
            const observed = td.trackers.filter((t) => t.firedAt >= startTime);
            const trackerList = observed.map((t) => ({
              domain: t.domain,
              tracker: t.trackerName,
              category: t.category,
              severity: t.severity
            }));
            callClaudePolicyAnalysis(
              {
                policy: policyRes.policyText.slice(0, 20000),
                trackers: JSON.stringify(trackerList)
              },
              state.settings.anthropicApiKey
            )
              .then((result) => {
                td.policyAnalysis = {
                  runAt: now(),
                  policyUrl: policyRes.policyUrl,
                  contradictions: result.contradictions || [],
                  deceptionScore: result.deception_score || 0
                };
                td.policyAnalysisStatus = { status: "done", message: "Complete.", at: now() };
                state.policyRateLimit[domain] = now();
                savePolicyRateLimit();
                saveTabData();
                updateBadge(targetTabId);
              })
              .catch(() => {
                td.policyAnalysisStatus = { status: "error", message: "Claude API error.", at: now() };
                saveTabData();
                // Ignore LLM errors
              });
          }, 30000);
        }
      );
    });
    }
  });
  return true;
});

setInterval(cleanupOldData, 60 * 60 * 1000);
