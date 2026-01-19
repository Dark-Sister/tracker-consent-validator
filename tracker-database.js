const DEFAULT_TRACKER_DB = {
  facebook: {
    domains: ["facebook.com/tr", "connect.facebook.net"],
    category: "marketing",
    severity: "critical"
  },
  google_analytics: {
    domains: ["google-analytics.com", "googletagmanager.com"],
    category: "analytics",
    severity: "high"
  },
  doubleclick: {
    domains: ["doubleclick.net", "googleadservices.com"],
    category: "marketing",
    severity: "high"
  },
  linkedin: {
    domains: ["linkedin.com/px", "ads.linkedin.com"],
    category: "marketing",
    severity: "high"
  },
  twitter: {
    domains: ["twitter.com/i/adsct", "analytics.twitter.com"],
    category: "marketing",
    severity: "high"
  },
  hotjar: {
    domains: ["hotjar.com", "static.hotjar.com"],
    category: "analytics",
    severity: "medium"
  },
  mouseflow: {
    domains: ["mouseflow.com"],
    category: "analytics",
    severity: "medium"
  },
  segment: {
    domains: ["segment.io", "api.segment.io"],
    category: "analytics",
    severity: "medium"
  },
  amplitude: {
    domains: ["amplitude.com", "api.amplitude.com"],
    category: "analytics",
    severity: "medium"
  }
};

const DEFAULT_CONSENT_PLATFORMS = [
  { name: "OneTrust", selector: "#onetrust-banner-sdk" },
  { name: "Cookiebot", selector: "#CybotCookiebotDialog" },
  { name: "TrustArc", selector: "#truste-consent-track" }
];

const DEFAULT_CONSENT_COOKIE_PATTERNS = [
  /OptanonConsent=/i,
  /OptanonAlertBoxClosed=/i,
  /CookieConsent=/i,
  /CookiebotConsent=/i,
  /consent=/i
];

const DEFAULT_ALLOWLIST = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "stripe.com",
  "paypal.com"
];

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_TRACKER_DB,
    DEFAULT_CONSENT_PLATFORMS,
    DEFAULT_CONSENT_COOKIE_PATTERNS,
    DEFAULT_ALLOWLIST
  };
}
