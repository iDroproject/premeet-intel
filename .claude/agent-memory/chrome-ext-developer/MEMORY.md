# Chrome Extension Developer – Agent Memory

## Project: gcal-meeting-intel

### Architecture
- Manifest V3 extension, service_worker uses `"type": "module"` (ES module imports work)
- Key files: `background/service-worker.js`, `popup/popup.{html,js,css}`, `sidepanel/sidepanel.{html,js,css}`
- CSS variables: sidepanel uses `--mi-*` tokens; popup must use the same `--mi-*` naming for visual consistency
- Cache layer: `background/cache/cache-manager.js` (CacheManager class, chrome.storage.local, KEY_PREFIX `mi_`)
- Storage key for API token: `premeet_api_token` in `chrome.storage.sync`

### Message Types (service-worker.js)
- `PING` – liveness check, returns `{ ok, version }`
- `FETCH_PERSON_BACKGROUND` – payload `{ name, email, company }`, acknowledges sync then pushes result async
- `FETCH_PROGRESS` – pushed SW → side panel; payload is now a structured object: `{ label, percent, step, totalSteps, stepId, stepStatus, personName, stepsState }`
- `PERSON_BACKGROUND_RESULT` – pushed from SW to side panel with PersonData or `_error` field
- `OPEN_SIDE_PANEL` – opens side panel for sender tab
- `SET_API_TOKEN` – payload `{ token }`, stores to chrome.storage.sync
- `GET_CACHE_STATS` – returns `{ ok, stats: { count, expiredCount, sizeBytesEst } }`
- `CLEAR_CACHE` – calls cache.clear() then cache.getStats(), returns `{ ok, stats }`
- `GET_LOGS` – payload `{ module?, level?, limit? }` filters; returns `{ ok, entries, modules }`

### Waterfall Orchestrator
- File: `background/api/waterfall-orchestrator.js`, exports `WaterfallOrchestrator` class
- Constructor: `(cacheManager, apiToken, logBuffer?)` — logBuffer is optional
- `PIPELINE_STEPS` constant: `[{ id, label, icon, percent }]` for `cache`, `serp-discovery`, `deep-lookup`, `linkedin-scraper`, `filter-enrich`
- Step status values: `pending` | `active` | `completed` | `failed` | `skipped`
- `_notifyProgress(stepId, status)` mutates `_stepsState` in place then emits full structured payload
- `_runLayer(layerName, stepId, fn, timeoutMs)` — emits `active` before, then `completed`/`failed` after
- Discovery (Layers 2+3): SERP and Deep Lookup run in PARALLEL via `_runParallelDiscovery(email, name, company)`
  - Both steps set to 'active' simultaneously; `Promise.any` resolves on first URL found
  - Loser continues in background and is marked 'skipped' (if still active) or 'failed' once it settles
  - Returns `{ linkedInUrl, serpVerified, errors[] }`
  - `Promise.any` requires wrapping layer results: a null URL must be re-thrown to count as rejection
- `onInterimResult` callback (new): fired after scraper (Layer 4) succeeds, BEFORE filter (Layer 5) starts
  - Side panel uses this to render a card immediately with partial scraper data
  - Called with result of `pickBestProfile(scraperProfiles, name, 'scraper', ...)`
  - Always wrapped in try/catch to prevent callback errors from breaking the pipeline
- `onProgress` callback receives: `{ label, percent, step, totalSteps, stepId, stepStatus, personName, stepsState }`
- `_personName` and `_stepsState` reset at start of each `fetch()` call so orchestrator is safely reusable
- LogBuffer calls: `info('Waterfall', ...)` on layer complete, `error('Waterfall', ...)` on layer throw
- `serpVerified` boolean propagated from discovery result through to `_finalise` context (replaces `serpResult.success`)

### Deep Lookup (Phase 4)
- File: `background/api/deep-lookup.js`, exports `deepLookupFindLinkedIn`, `deepLookupEnrich`, `deepLookupCompanyIntel`, `deepLookupCustomEnrich`
- Endpoint: `POST /trigger_enrichment` (trigger_enrichment API)
- Returns requestId + polls status until completed, then downloads results
- Hard 120s total deadline, polls every 3s up to 30 attempts

### LogBuffer (service-worker.js)
- File: `background/log-buffer.js`, exports `LogBuffer` class (circular buffer, max 200 entries)
- Singleton `logBuffer = new LogBuffer()` at module level in service-worker.js
- Methods: `info(module, msg, data?)`, `warn(...)`, `error(...)`, `getEntries(filters)`, `getModules()`, `clear()`
- `getEntries` filters: `{ module?, level?, limit? }`, returns newest-first
- SW log points: fetch start/result/error (module `'SW'`), cache clear (module `'Cache'`), waterfall layers (module `'Waterfall'`)

### Alarm Names (service-worker.js)
- `refresh-cache` — every 30 min, triggers lazy cache eviction via getStats()
- `prefetch-upcoming-meetings` — every 120 min, Phase 5 scaffold for Calendar pre-fetch
- `registerAlarms()` called from BOTH `onInstalled` AND top-level startup (alarms don't survive SW restarts)

### Popup Settings Page (Phase 5)
- Token input: password type with show/hide toggle, saves via SET_API_TOKEN message
- Never read token back into UI; use placeholder "Token saved (paste to replace)" instead
- Cache stats auto-load on popup open via GET_CACHE_STATS
- Clear cache button sends CLEAR_CACHE, then re-renders stats from response
- Feedback messages auto-clear after 4000 ms using a timer stored on the element as `_feedbackTimer`
- Popup width: 320px

### Manual Search (Side Panel – Phase 5)
- Two instances: one in empty-state, one in error-state (separate IDs to avoid DOM conflicts)
- `wireManualSearch(inputId, buttonId)` handles both click and Enter key
- Sends FETCH_PERSON_BACKGROUND with `{ name, email: null, company: null }`
- Clears input after submission; sets loadingLabel before calling showView('loading')

### Patterns Confirmed
- `sendResponse` must be called synchronously OR `return true` must be returned from onMessage for async handlers
- When `chrome.runtime.lastError` is present, accessing `.message` is safe (no throw)
- Token security: never expose stored token back into DOM inputs; use placeholder confirmation
- `showFeedback` pattern: write message + class, then set a timeout to clear – store timer on element to cancel duplicates
- For dark mode button hover: must override inside `@media (prefers-color-scheme: dark)` because light-mode color values don't inherit naturally
