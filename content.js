/* global DEFAULT_CONSENT_PLATFORMS, DEFAULT_CONSENT_COOKIE_PATTERNS */

const LOCAL_CONSENT_PLATFORMS = [
  { name: "OneTrust", selector: "#onetrust-banner-sdk" },
  { name: "Cookiebot", selector: "#CybotCookiebotDialog" },
  { name: "TrustArc", selector: "#truste-consent-track" }
];

const LOCAL_CONSENT_COOKIE_PATTERNS = [
  /OptanonConsent=/i,
  /OptanonAlertBoxClosed=/i,
  /CookieConsent=/i,
  /CookiebotConsent=/i,
  /consent=/i
];

const CONSENT_PLATFORMS =
  typeof DEFAULT_CONSENT_PLATFORMS !== "undefined" ? DEFAULT_CONSENT_PLATFORMS : LOCAL_CONSENT_PLATFORMS;
const CONSENT_COOKIE_PATTERNS =
  typeof DEFAULT_CONSENT_COOKIE_PATTERNS !== "undefined" ? DEFAULT_CONSENT_COOKIE_PATTERNS : LOCAL_CONSENT_COOKIE_PATTERNS;

const consentState = {
  detected: false,
  platform: null,
  userAction: null,
  detectedAt: null
};

function now() {
  return Date.now();
}

function sendConsentState(extra = {}) {
  chrome.runtime.sendMessage({
    type: "CONSENT_STATE",
    detected: consentState.detected,
    platform: consentState.platform,
    userAction: consentState.userAction,
    timestamp: now(),
    inferred: extra.inferred || false
  });
}

function detectBannerBySelectors() {
  for (const p of CONSENT_PLATFORMS) {
    const el = document.querySelector(p.selector);
    if (el) {
      consentState.detected = true;
      consentState.platform = p.name;
      consentState.detectedAt = consentState.detectedAt || now();
      sendConsentState();
      return true;
    }
  }
  return false;
}

function detectBannerByText() {
  const keywords = ["cookie", "consent", "privacy", "accept all", "reject all", "manage preferences"];
  const text = document.body ? document.body.innerText.toLowerCase() : "";
  return keywords.some((k) => text.includes(k));
}

function detectConsentCookies() {
  const ck = document.cookie || "";
  for (const re of CONSENT_COOKIE_PATTERNS) {
    if (re.test(ck)) {
      consentState.detected = true;
      consentState.platform = consentState.platform || "cookie";
      consentState.detectedAt = consentState.detectedAt || now();
      sendConsentState({ inferred: true });
      return true;
    }
  }
  return false;
}

function observeConsentBanner() {
  const observer = new MutationObserver(() => {
    if (!consentState.detected) {
      if (detectBannerBySelectors()) return;
      if (detectBannerByText()) {
        consentState.detected = true;
        consentState.platform = consentState.platform || "generic";
        consentState.detectedAt = consentState.detectedAt || now();
        sendConsentState();
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

document.addEventListener(
  "click",
  (e) => {
    const target = e.target;
    if (!target || !target.textContent) return;
    const txt = target.textContent.toLowerCase();
    if (txt.includes("accept")) {
      consentState.userAction = "accepted";
      sendConsentState();
    } else if (txt.includes("reject") || txt.includes("decline")) {
      consentState.userAction = "rejected";
      sendConsentState();
    }
  },
  true
);

chrome.runtime.sendMessage({
  type: "PAGE_LOAD",
  timestamp: now(),
  url: window.location.href
});

detectBannerBySelectors();
detectConsentCookies();
observeConsentBanner();

function findPolicyLink() {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const priorities = ["privacy policy", "privacy", "terms"];

  const scoreAnchor = (a) => {
    const text = (a.textContent || "").trim().toLowerCase();
    const href = (a.getAttribute("href") || "").trim().toLowerCase();
    let score = 0;

    if (text === "privacy policy") score += 100;
    if (text === "privacy") score += 80;
    if (text === "terms") score += 70;
    if (text.includes("privacy policy")) score += 60;
    if (text.includes("privacy")) score += 50;
    if (text.includes("terms")) score += 40;

    if (href.includes("privacy-policy")) score += 35;
    if (href.includes("privacy")) score += 25;
    if (href.includes("terms")) score += 15;

    return score;
  };

  const candidates = anchors
    .filter((a) => !/^javascript:|^mailto:/i.test(a.getAttribute("href") || ""))
    .map((a) => ({ a, score: scoreAnchor(a) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);

  if (candidates.length === 0) return null;
  try {
    return new URL(candidates[0].a.getAttribute("href"), window.location.href).href;
  } catch (e) {
    return candidates[0].a.href || null;
  }
}

async function fetchPolicyText(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) return "";
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.innerText || "").replace(/\s+/g, " ").trim();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCRAPE_POLICY") {
    const policyUrl = findPolicyLink();
    if (!policyUrl) {
      sendResponse({ policyUrl: null, policyText: "" });
      return;
    }
    fetchPolicyText(policyUrl)
      .then((text) => {
        sendResponse({ policyUrl, policyText: text.slice(0, 20000) });
      })
      .catch(() => {
        sendResponse({ policyUrl, policyText: "" });
      });
    return true;
  }
});
