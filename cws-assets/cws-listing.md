# Chrome Web Store Dashboard — PreMeet Listing

> All fields needed for CWS developer dashboard submission.

---

## Store Listing Tab

### Name

PreMeet

### Short Description (132 chars max)

```
Turn every calendar invite into a complete business brief.
```

_55 characters_

### Detailed Description

```
PreMeet turns every Google Calendar invite into a professional brief. Before your next meeting, instantly see who you're sitting down with — their role, company, background, and the signals that matter most.

HOW IT WORKS
1. Open any event in Google Calendar
2. Click "Know [Name]" next to any attendee
3. PreMeet fetches their LinkedIn profile, work history, company details, and recent activity — displayed in a clean side panel

No tab-switching. No pre-meeting research scramble. Just click and know.

KEY FEATURES

• One-Click Attendee Lookup — Click "Know [Name]" on any calendar event to pull up a full professional profile instantly.

• Rich Profile Cards — See current title, company, location, connections, followers, and a confidence-match score for every lookup.

• Company Intelligence — Get company name, industry, size, website, products, technologies, and recent news at a glance.

• Work History & Education — View complete career timelines and education background without leaving your calendar.

• Recent LinkedIn Activity — See what your meeting attendees have been posting and engaging with recently.

• Smart Enrichment — Drill deeper with one-click buttons for skills, company intel, and more.

• Lookup History — Revisit past profiles before follow-up meetings.

• Privacy-First — Data cached locally and on our server with automatic expiry. We only access publicly available information and never sell your data.

WHO IT'S FOR
PreMeet is built for professionals who do external meetings regularly:
— Sales reps preparing for discovery and demo calls
— Recruiters screening candidates before interviews
— Consultants meeting new client stakeholders
— Account managers onboarding new points of contact
— Founders taking investor or partner meetings
— Anyone who wants to walk into a meeting prepared

YOUR DATA, YOUR CONTROL
PreMeet only accesses publicly available professional information — the same data anyone can find with a Google search, just organized and delivered instantly.
— We do NOT read your emails or access other tabs
— We do NOT track your browsing activity
— We do NOT sell or share any data
— Profiles are cached locally and on our server (auto-expires after 7 days)
— PreMeet only activates on calendar.google.com

GETTING STARTED
1. Install the extension
2. Navigate to Google Calendar and open any event
3. Click "Know [Name]" next to an attendee — done!

Questions or feedback? Visit https://premeet.co
```

### Category

**Primary:** Productivity

### Language

English

### Website

https://premeet.co

### Support URL

https://premeet.co

---

## Single Purpose Statement

```
PreMeet enriches Google Calendar meeting attendees with professional background information displayed in a side panel, helping users prepare for meetings.
```

---

## Privacy Tab — Permission Justifications

### `storage`

Cache enriched profile data locally in the user's browser to reduce redundant API calls and provide instant repeat lookups for recurring meeting attendees.

### `identity`

Authenticate the user via Google OAuth for account management and billing. Required to link the extension to the user's PreMeet account.

### `sidePanel`

Display attendee professional briefings in Chrome's built-in side panel alongside Google Calendar, so users can review profiles without leaving their calendar view.

### Host Permissions

#### `https://calendar.google.com/*`

Read attendee names and email addresses from Google Calendar event detail pages. This is the core trigger for the extension — it detects calendar events and identifies who the user is meeting.

#### `https://www.gravatar.com/*`

Fetch publicly available profile photos for attendees using their email hash via the Gravatar API. Used to display attendee photos in profile cards.

#### `https://api.brightdata.com/*`

Look up publicly available professional profile data (LinkedIn profiles, company information) for meeting attendees via the BrightData data enrichment API.

---

## Privacy Practices

- **Data collected:** Attendee names and email addresses from calendar events (used only for profile lookups); Google account info at sign-in for account management
- **Data stored:** Cached profile data stored locally via `chrome.storage.local` (7-day TTL) and server-side in Neon Postgres (shared enrichment cache, 7-day TTL). User accounts, sessions, and billing references stored server-side.
- **Data shared:** Attendee data sent to BrightData for professional lookups and Gravatar for avatars. Stripe processes payments (never receives user browsing data). No data is sold to third parties, data brokers, or advertisers.
- **Data retention:** Local cached profiles expire after 7 days; server enrichment cache expires after 7 days; enrichment request logs retained 90 days; user accounts retained until deletion requested

---

## Assets Checklist

| Asset | Spec | Status |
|---|---|---|
| Extension icon 128x128 | PNG, no alpha on edges | `icons/icon128.png` |
| Screenshot 1280x800 or 640x400 | PNG/JPEG, 1-5 required | `cws-assets/screenshots/` |
| Small promo tile 440x280 | PNG | `cws-assets/promo-tiles/` |
| Large promo tile 920x680 | PNG (optional) | `cws-assets/promo-tiles/` |
| Privacy policy URL | Required | `https://premeet.co/privacy` |
