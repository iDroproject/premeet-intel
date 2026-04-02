# PreMeet

> Know who you're meeting before every call.

PreMeet is a Chrome extension (Manifest V3) that surfaces LinkedIn profiles, company intelligence, and professional background on meeting attendees directly inside Google Calendar.

## How It Works

1. Open any event in Google Calendar
2. Click **"Know [Name]"** next to any attendee
3. PreMeet fetches their LinkedIn profile, work history, company details, and recent activity — displayed in a clean side panel

No tab-switching. No pre-meeting research scramble. Just click and know.

## Features

- **One-Click Attendee Lookup** — Click "Know [Name]" on any calendar event to pull up a full professional profile
- **Rich Profile Cards** — Current title, company, location, connections, followers, and confidence-match score
- **Company Intelligence** — Industry, size, website, products, technologies, and recent news
- **Work History & Education** — Complete career timelines and education background
- **Recent LinkedIn Activity** — See what attendees have been posting and engaging with
- **Smart Enrichment** — Drill deeper with one-click buttons for skills, company intel, and more
- **Lookup History** — Revisit past profiles before follow-up meetings
- **Brief Mode** — One-click bulk lookup for all attendees on an event
- **Privacy-First** — All data stored locally in your browser; only accesses publicly available information

## Project Structure

```
premeet-intel/
├── background/          # Service worker, API clients, cache
│   ├── api/             # Data scraping, SERP, deep lookup, waterfall orchestrator
│   ├── cache/           # Chrome storage-based caching layer
│   ├── analytics.js     # Local usage analytics
│   ├── log-buffer.js    # Circular log buffer for debugging
│   └── service-worker.js
├── content/             # Content scripts injected into Google Calendar
│   ├── attendee-extractor.js
│   ├── button-injector.js
│   ├── calendar-observer.js
│   ├── content-script.js
│   └── content.css
├── popup/               # Extension popup (settings, API token, cache management)
├── sidepanel/           # Side panel UI (profile cards, enrichment views)
├── icons/               # Extension icons (16, 32, 48, 128px)
├── tests/               # Smoke tests, API tests, integration tests
├── manifest.json        # Chrome Extension Manifest V3
└── cws-listing.md       # Chrome Web Store listing copy
```

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/iDroproject/premeet-intel.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `premeet-intel` directory
5. Open the extension popup and enter your API token
6. Navigate to Google Calendar, open any event, and click **"Know [Name]"**

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Cache profiles locally for instant repeat lookups |
| `sidePanel` | Display profiles alongside your calendar |
| `activeTab` | Read attendee names from the current calendar event |
| `alarms` | Periodically clean expired cache entries |

## Tech Stack

- **Chrome Extension Manifest V3** with ES module service worker
- **Bright Data API** for professional data enrichment
- **SERP API** for search-based discovery
- **Gravatar** for attendee avatars
- **Waterfall orchestrator** with parallel discovery, caching, and fallback layers

## Who It's For

- Sales reps preparing for discovery and demo calls
- Recruiters screening candidates before interviews
- Consultants meeting new client stakeholders
- Account managers onboarding new points of contact
- Founders taking investor or partner meetings

## License

Proprietary. All rights reserved.
