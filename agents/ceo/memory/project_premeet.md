---
name: PreMeet Chrome Extension
description: PreMeet is a Chrome extension (formerly gcal-meeting-intel / Bright People Intel) that shows professional background on Google Calendar meeting attendees. Backend uses Bright Data APIs. Target: Chrome Web Store MVP by end of March 2026.
type: project
---

PreMeet is a rebrand of "Bright People Intel" / gcal-meeting-intel.

**Why:** Board wants to remove all Brightdata branding before publishing to Chrome Web Store. The extension functionality stays the same — only the brand identity changes.

**How to apply:** All work should be oriented toward Chrome Web Store readiness. The rebranding (PRE-7) is the critical path prerequisite. Backend still uses Bright Data APIs under the hood — only user-facing references are being removed.

Key facts:
- Repo: https://github.com/iDroproject/gcal-meeting-intel (full admin access)
- **Two codebases**: `premeet-intel/` (full-featured, ship first) and `src/` (clean TS scaffold, incomplete — becomes v2)
- MV3 manifest, service worker architecture
- Brightdata CLI for backend fixes: https://github.com/brightdata/cli
- Chrome Web Store publishing target: week of 2026-03-23
- PRE-7 rebranding was marked done but ~30 Brightdata references remain. PRE-10 created with explicit file checklist to finish.
- Board needs to register CWS developer account ($5) and set up privacy policy URL
- Brand & distribution plan drafted on PRE-9 document (freemium model: Free/Pro $9/Team $29)
