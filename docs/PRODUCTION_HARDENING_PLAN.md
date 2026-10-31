# PreMeet Production Hardening Plan (v2.5.1 → v2.6.0)

Goal: make PreMeet production-ready for external users. Fix verified bugs across
security, database, backend logic, and UI; add the fast BrightData **Search
Dataset API** to speed up enrichment.

Findings below were produced by a multi-agent code review and each was
adversarially re-verified against the actual code before inclusion. Severities
are post-verification. Only confirmed defects are listed.

---

## Phase 0 — Build/tooling stability (unblocks validation)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 0.1 | Test suite can't start: vitest 4 vs vite 5 (`ERR_PACKAGE_PATH_NOT_EXPORTED`) | `package.json` | Pin `vitest` to `^3.2.4` (compatible with vite 5); reinstall |
| 0.2 | `typecheck` fails: client `CompanyData` missing `linkedinId` | `src/background/waterfall-data-fetch/types.ts` | Add `linkedinId: string \| null` |
| 0.3 | `typecheck` TS2367: `GET_SEARCH_QUOTA` unreachable in message union | `src/types.ts`, `src/background/index.ts` | Add message type to union |
| 0.4 | Conflicting lockfiles (`package-lock.json` + `pnpm-lock.yaml`) | repo root | Keep pnpm; delete `package-lock.json`, `deno.lock`; add `packageManager` |
| 0.5 | Dead legacy Supabase/Deno `functions/` tree (15 endpoints) | `functions/` | Delete (preserved in `legacy/v1` branch) |
| 0.6 | Dead legacy client module + handlers | `src/background/waterfall-data-fetch.ts` | Delete if unreferenced |
| 0.7 | Integration tests import undeclared `ws`; unused `puppeteer` | `package.json` | Add `ws`+`@types/ws`, drop `puppeteer` |

## Phase 1 — Security & backend logic

| # | Sev | Issue | File | Fix |
|---|-----|-------|------|-----|
| 1.1 | **critical** | `enrichment-proxy` is an unmetered open relay to BrightData: any signed-in user can drain paid credits and scrape arbitrary URLs (SSRF via `/request`) | `api/enrichment-proxy.ts` | Strict path allowlist; reject arbitrary-URL zones; inject SERP `customer`/`zone` server-side; server-side per-user daily quota (Neon); audit-log triggers |
| 1.2 | high | Google OAuth token audience never verified (token substitution) | `api/auth-google.ts` | Validate via `tokeninfo`; assert `aud/azp === client_id`, `email_verified` |
| 1.3 | med | Dev-auth backdoor deployable via one env var | `api/auth-dev.ts` | Hard-gate to non-production (`VERCEL_ENV !== 'production'`) **and** shared secret |
| 1.4 | high | Credit check-then-spend TOCTOU + inconsistent tier enforcement (free-only checks; Pro/enterprise unmetered on company/deep/mcp) | all `api/enrichment-*.ts` | Single atomic conditional `UPDATE ... RETURNING`; enforce `credits_limit` for all tiers; refund on failure |
| 1.5 | critical | Shared cache writable/deletable by any user; free users read Pro contact data via cache `get` | `api/enrichment-cache.ts` | Remove client `put`/`invalidate`; tier-gate premium keys on `get`; validate enums; cap ttl/size; fix module-global `_cors` |
| 1.6 | high | MCP runs on edge runtime (needs Node + maxDuration 60); wrong SSE transport | `api/enrichment-custom.ts`, `api/enrichment-mcp/*` | Node runtime + `maxDuration: 60`; use shared `callMcpTool` |
| 1.7 | high | company-deep treats empty `{}` AI result as success → charges + caches empty 30d | `api/enrichment-company-deep.ts` | Require usable fields before success/charge/cache |
| 1.8 | high | Dataset Filter drops valid records containing substring `building` | `api/_shared/dataset-filter.ts` | Parse JSON first; only apply retry heuristic to non-JSON status bodies |
| 1.9 | med | Poll loop swallows permanent 4xx; non-JSON MCP result stalls to timeout; non-idempotent trigger retries | `api/_shared/{dataset-filter,mcp-client,deep-lookup}.ts` | Terminal on 4xx; fallback `{text}`; retry only safe ops |
| 1.10 | low | CORS reflects any extension origin; avatar XSS; Stripe webhook non-idempotent; `priceIdToTier` unsafe defaults | `api/_shared/cors.ts`, `stripe-webhook.ts`, `stripe.ts` | Pin extension id; `ON CONFLICT ... RETURNING` guard; guard empty price ids |

## Phase 2 — Database

| # | Issue | Fix |
|---|-------|-----|
| 2.1 | Migrations not idempotent; runner re-applies all files | `schema_migrations` ledger in `apply-schema.mjs` + idempotent guards in a new `004` |
| 2.2 | No purge of expired cache/sessions (unbounded growth) | Add cleanup endpoint + Vercel cron; cap ttl/payload in cache |
| 2.3 | Monthly reset race can wipe usage | Conditional atomic `UPDATE ... WHERE credits_reset_month <> $m` (folded into 1.4) |

## Phase 3 — Extension client

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| 3.1 | critical | Pro tier never applied client-side (subscribers stuck at free) | Sync server `tier`/`credits` from `/auth-me` into `pm_credits` |
| 3.2 | high | SW restart wipes `currentMeeting`/`currentEnriched` | Persist to `chrome.storage.session`, rehydrate on startup |
| 3.3 | high | Meeting-switch race writes into wrong attendee slot | Generation token + re-resolve index by email post-await |
| 3.4 | med | Credit consumed even when enrichment fails | Charge only on success, skip on cache hit |
| 3.5 | med | `cacheDuration` setting ignored | Thread TTL through orchestrator; `never` disables caching |
| 3.6 | med | `CacheManager` LRU races / unbounded size | Serialize index writes; size-aware eviction |
| 3.7 | low | Unneeded host permissions | Drop gravatar/mixpanel host perms |

## Phase 4 — UI (sidepanel + popup)

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| 4.1 | critical | Every "Upgrade to Pro" CTA is a dead click (`OPEN_UPGRADE` unhandled) | Background handler → `billing-checkout` → open Stripe URL (paywall redirect) |
| 4.2 | high | `CREDITS_EXHAUSTED` ignored — brief button silently no-ops | Render paywall/banner state |
| 4.3 | high | Tab switch stacks duplicate listeners; chevron dies | Scope listener rewiring / delegate on card root |
| 4.4 | high | Meeting-switch stale updates append wrong cards | Drop updates whose meeting id ≠ current |
| 4.5 | high | Company Intel skeleton never resolves on fast-profile failure | Broadcast error; UI timeout fallback |
| 4.6 | high | HTML/attribute injection from scraped data | Use `escapeAttr`/DOM APIs; URL-scheme validation |
| 4.7 | med | Posts metadata (source/date/likes/shares) absent | Extend model + render (user issue #3) |
| 4.8 | med | Company auto-fetch has no settings toggle | Add `autoFetchCompanyIntel` (user issue #4) |
| 4.9 | med | Auth state desyncs popup↔sidepanel | Broadcast `AUTH_STATE_CHANGED` |
| 4.10 | med | Three dead settings controls | Wire or remove |
| 4.11 | low | Tooltip occluded by sticky header (issue #2); banner dismiss cosmetic; sign-in failure nukes list | Targeted fixes |

## Phase 5 — Feature: BrightData Search Dataset API (speed)

`POST https://api.brightdata.com/datasets/search/:dataset_id` → sub-second inline
`{hits,total_hits,took}`, no snapshot polling. Filter syntax is identical to the
existing Dataset Filter (`{name,operator,value}` / `{operator:'and',filters}`),
so every current filter maps 1:1; `records_limit` → `size`.

- **5.1** New `api/_shared/search-dataset.ts` client (returns unwrapped records).
- **5.2** Client person filter (`filterByLinkedInId`, dataset `gd_l1viktl72bvl7bjuj0`):
  search-first, fall back to snapshot flow on error/empty. Biggest win
  (~8–25s → ~1–1.5s). Requires `/datasets/search/*` in the proxy allowlist.
- **5.3** `enrichment-contact`: try search on contact-enriched people dataset
  `gd_me5ppxjr2ge6icjuh0` before Deep Lookup; delete dead `queryEmployee`.
- **5.4** `enrichment-company`: inline search layer on company dataset
  `gd_l1vikfnt1wgvvqz95w` (sync API removes the 25s-timeout reason company data
  was deferred). Keep snapshot `queryCompany` in company-deep for funding/revenue
  (its 331-datapoint merged dataset is **not** search-supported).

## Phase 6 — Validate & ship

- `npm run typecheck` clean; `npm test` green; `npm run build` produces loadable `dist/`.
- Bump version to **2.6.0** across `package.json`, `src/manifest.json`, `README.md`.
- Commit per phase; open PR.
