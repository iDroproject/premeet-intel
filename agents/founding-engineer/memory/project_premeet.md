---
name: PreMeet Chrome Extension
description: Chrome extension (MV3) that turns calendar invites into business briefs, shipped inside Google Calendar
type: project
---

PreMeet is a Chrome extension (Manifest V3) that shows professional background and company intel on Google Calendar meeting attendees.

**Why:** Professionals need instant context before meetings — who they're meeting, the company, role, and signals that matter.

**How to apply:** All technical work targets Chrome Web Store readiness. The extension runs as a service worker with content scripts injected into Google Calendar.

Key facts:
- Tech stack: TypeScript, Vite, Chrome Extension MV3
- Backend data: Bright Data APIs (called directly from extension, no intermediary server for core flow)
- Database: Neon Serverless Postgres (migrated from Supabase)
- Edge functions: Deno-based, deployed to Neon/Deno Deploy
- CWS publishing target: end of March 2026
