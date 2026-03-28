---
name: Extension Architecture
description: Key architectural decisions and file layout for the PreMeet Chrome extension
type: reference
---

## Extension Structure
- `src/background/` — Service worker, handles data fetching waterfall
- `src/background/waterfall-data-fetch/` — BrightData API integration, caching, response normalization
- `src/content/` — Content scripts injected into Google Calendar
- `src/lib/` — Shared utilities (Mixpanel analytics, etc.)
- `src/manifest.json` — MV3 manifest

## Backend Structure
- `functions/` — Deno edge functions (auth, billing, enrichment)
- `functions/_shared/` — Shared middleware (auth, CORS, DB, JWT, Stripe)
- `neon/schema/` — Database migration SQL files

## Build
- Vite-based build (`vite.config.ts`)
- Tests: Vitest (`vitest.config.ts`)
