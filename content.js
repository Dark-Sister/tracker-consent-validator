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
