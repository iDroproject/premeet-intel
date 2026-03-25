# PreMeet — Chrome Web Store Reviewer Test Instructions

## What PreMeet Does

PreMeet enriches Google Calendar meeting attendees with professional background information. When a user opens a calendar event, the extension adds "Know [Name]" buttons next to each attendee. Clicking a button opens Chrome's side panel with a professional briefing: current role, company details, work history, education, and recent LinkedIn activity.

## Prerequisites

- Google Chrome (latest stable)
- A Google account with Google Calendar access
- At least one upcoming calendar event with external attendees (people outside your organization)

## Setup

1. Unzip the extension package
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked** and select the unzipped folder (the folder containing `manifest.json`)
5. The PreMeet icon should appear in the Chrome toolbar

## Test Steps

### Test 1: Extension loads correctly

1. After loading the extension, click the PreMeet icon in the toolbar
2. **Expected:** A popup opens showing the PreMeet login/setup screen
3. Verify no console errors in `chrome://extensions` for the PreMeet entry

### Test 2: Content script activates on Google Calendar

1. Navigate to `https://calendar.google.com`
2. Click on any calendar event that has attendees
3. **Expected:** "Know [Name]" buttons appear next to attendee names in the event detail view

### Test 3: Side panel opens with attendee data

1. On a calendar event with attendees, click any "Know [Name]" button
2. **Expected:** Chrome's side panel opens on the right side
3. **Expected:** The side panel shows a loading state, then displays the attendee's professional profile card with:
   - Name and current title
   - Company information
   - Profile photo (if available)

### Test 4: Profile enrichment displays correctly

1. After clicking "Know [Name]", wait for the side panel to load
2. **Expected:** The profile card shows available information such as:
   - Current role and company
   - Location
   - Work history timeline
   - Education background
   - Recent LinkedIn activity
3. **Note:** Results depend on publicly available data for the attendee. Some attendees may have limited information.

### Test 5: Extension only activates on Google Calendar

1. Navigate to any non-Calendar page (e.g., `https://www.google.com`)
2. **Expected:** The extension does not inject any UI elements on non-Calendar pages
3. Verify by inspecting the page — no PreMeet content scripts should be active

## Permissions Justification

| Permission | Reason |
|---|---|
| `storage` | Cache enriched profile data locally to reduce API calls and improve load times |
| `identity` | Authenticate user via Google OAuth for account management |
| `sidePanel` | Display attendee briefings in Chrome's side panel alongside Google Calendar |
| `host_permissions: calendar.google.com` | Read attendee names and emails from Google Calendar event pages |
| `host_permissions: gravatar.com` | Fetch profile photos for attendees via email hash |
| `host_permissions: api.brightdata.com` | Look up publicly available professional profile data for meeting attendees |

## Notes

- The extension only activates on `calendar.google.com` — it does not access any other websites or user data
- All cached data is stored locally in the browser via `chrome.storage.local`
- The extension does not read email content, track browsing, or transmit personal data
