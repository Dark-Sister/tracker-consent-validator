# tracker-consent-validator
Chrome extension that audits sites for consent violations by monitoring third‑party requests, detecting consent banners/cookies, and flagging trackers that fire before consent or after rejection. Exports JSON reports, supports per‑site enablement, and uses a configurable tracker DB.

## Tracker Consent Validator (Chrome Extension)

Detects privacy violations when third-party trackers fire before consent. Lightweight, MV3-compatible, and open-source friendly.

### Features
- Real-time request monitoring (best effort)
- Consent banner + consent-cookie detection
- Violation classification and severity badge
- Optional allowlist for necessary services
- Per-site enablement (on click / this site only)
- JSON report export
- Importable tracker database JSON

### Install (Developer Mode)
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-extension` folder

### How to use (step-by-step)
1. Open the site you want to test.
2. Click the extension icon.
3. Click **Enable on this site** and approve permissions.
4. Watch the popup update with violations and consent state.
5. Click **Export JSON Report** to save findings.
6. Use the **On/Off** toggle to pause or resume monitoring.

### How it works
- A **service worker** listens to web requests and correlates them with consent state.
- A **content script** detects consent banners/cookies and user action.
- The popup shows violations, exports JSON, and allows importing tracker lists.

### Permissions model
Default is **“this site only”**. Use the popup to grant site access:
- Click **Enable on this site** → Chrome will ask for permission.

### Limitations (best effort)
- MV3 limits access to full request payloads/headers.
- “EU/CA” policy is a toggle only; no geolocation is performed.
- eTLD+1 detection is heuristic (no public suffix list).

### What it detects
- Pre-consent firing (trackers fire before user action)
- Rejection ignored (trackers fire after user rejects)
- No banner found (only enforced when policy is `always`)

### Notes for real-world use
- Use the tracker DB import to stay current as domains change.
- Unknown trackers default to medium severity; known trackers use the DB severity.
- Default mode is active-tab only to minimize permissions.

### File overview
```
chrome-extension/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── popup.css
├── tracker-database.js
└── README.md
```

