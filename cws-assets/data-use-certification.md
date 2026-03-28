# CWS Data Use Certification — PreMeet

**Prepared:** 2026-03-25
**Extension:** PreMeet (Chrome Web Store submission)
**Auditor:** Back-end Developer (automated code audit)

---

## 1. Data Type Checklist

### Personally Identifiable Information (PII)
**YES**

| Field | Source | Purpose | Core Functionality | Transferred to Third Parties | Combined with PII |
|-------|--------|---------|-------------------|------------------------------|-------------------|
| User email | Google OAuth | Account creation, login | Yes | Yes — Google (OAuth verification) | Yes (is PII) |
| User name | Google OAuth | Display in UI | Yes | Yes — Google (OAuth verification) | Yes |
| Google user ID | Google OAuth | Account linking | Yes | No (stored server-side only) | Yes |
| Attendee name | Google Calendar DOM | Identify meeting participants | Yes | Yes — BrightData (enrichment lookup) | Yes |
| Attendee email | Google Calendar DOM | Enrichment key, avatar lookup | Yes | Yes — BrightData (enrichment), Gravatar (hashed) | Yes |
| Attendee company | Derived from email domain | Enrichment context | Yes | Yes — BrightData (enrichment) | Yes |
| LinkedIn profile data | BrightData (public sources) | Display professional briefs | Yes | No (stored server-side in cache) | Yes |

**Justification:** PII is required for the extension's core purpose — generating professional briefs for meeting attendees. No PII is used for advertising, analytics, or purposes unrelated to the extension.

---

### Health Information
**NO** — PreMeet does not collect, process, or store any health-related data.

---

### Financial and Payment Information
**YES** (server-side only, not in extension)

| Field | Source | Purpose | Core Functionality | Transferred to Third Parties |
|-------|--------|---------|-------------------|------------------------------|
| Stripe customer ID | Stripe | Link user to billing account | Yes | Yes — Stripe (payment processing) |
| Stripe subscription ID | Stripe | Track subscription status | Yes | Yes — Stripe |
| Billing event data | Stripe webhooks | Audit trail | Yes | No (stored server-side only) |

**Justification:** Payment data is processed exclusively by Stripe. The extension itself never handles credit card numbers, bank accounts, or financial credentials. Server stores only Stripe reference IDs, not raw payment instruments.

---

### Authentication Information
**YES**

| Field | Source | Purpose | Transferred to Third Parties |
|-------|--------|---------|------------------------------|
| Google OAuth access token | Chrome Identity API | Authenticate user via Google | Yes — Google (verification) |
| PreMeet access token | Server-generated (JWT) | Authorize API requests | No |
| PreMeet refresh token | Server-generated | Maintain session | No |
| Session token hash | Server-generated | Server-side session validation | No |

**Justification:** Authentication tokens are required for user accounts and subscription management. Tokens are stored locally in `chrome.storage.local` (client) and as hashes in the database (server). No passwords are collected — Google OAuth is the sole auth method.

---

### Personal Communications
**NO** — PreMeet does not read emails, messages, or any communication content. It only reads attendee metadata (name, email) from Google Calendar event detail pages.

---

### Location
**NO** — PreMeet does not request or access location data.

---

### Web History
**NO** — PreMeet does not access browsing history. The content script runs only on `calendar.google.com` and does not observe navigation on other sites.

---

### User Activity (network monitoring, clicks, mouse position, scroll, keystroke logging)
**PARTIAL** — PreMeet tracks anonymous product usage events (e.g., "sidepanel opened", "brief completed") via Mixpanel for product improvement. It does NOT monitor clicks, mouse position, scrolls, keystrokes, or network traffic. Only high-level feature usage events are recorded.

---

### Website Content
**YES** (limited to Google Calendar)

| Field | Source | Purpose | Transferred to Third Parties |
|-------|--------|---------|------------------------------|
| Attendee names | Calendar event popup DOM | Identify meeting participants | Yes — BrightData |
| Attendee emails | Calendar event popup DOM attributes | Enrichment key | Yes — BrightData, Gravatar (hashed) |
| Meeting title | Calendar event popup DOM | Local activity log display | No (local only) |

**Justification:** PreMeet reads only structured attendee metadata from Google Calendar event detail popups. It does not read event descriptions, notes, attachments, or calendar content beyond the attendee list and event title.

---

## 2. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  USER'S BROWSER                                              │
│                                                              │
│  ┌─────────────────┐     ┌──────────────────────────────┐   │
│  │ Content Script   │────▶│ Background Service Worker     │   │
│  │ (calendar.google │     │                              │   │
│  │  .com only)      │     │  Enrichment Waterfall:       │   │
│  │                  │     │  1. Local cache check        │   │
│  │  Extracts:       │     │  2. Server cache check ──────┼───┼──▶ Neon DB
│  │  - Attendee name │     │  3. SERP discovery ──────────┼───┼──▶ BrightData SERP
│  │  - Attendee email│     │  4. Deep lookup ─────────────┼───┼──▶ BrightData Deep
│  │  - Meeting title │     │  5. LinkedIn scrape ─────────┼───┼──▶ BrightData Scraper
│  │                  │     │  6. Business data filter ────┼───┼──▶ BrightData Filter
│  └─────────────────┘     │  7. Company intelligence ────┼───┼──▶ BrightData SERP/Deep
│                           │  8. Gravatar avatar ─────────┼───┼──▶ Gravatar (hash only)
│  ┌─────────────────┐     │                              │   │
│  │ Side Panel UI    │◀────│  Stores results in:          │   │
│  │ (displays brief) │     │  - chrome.storage.local      │   │
│  └─────────────────┘     │    (7-day TTL)               │   │
│                           └──────────────────────────────┘   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ chrome.storage.local                                 │    │
│  │  - pm_enrich_*     (cached profiles, 7d TTL)        │    │
│  │  - pm_activity_log (500-entry FIFO, local only)     │    │
│  │  - pm_credits      (monthly usage counter)          │    │
│  │  - premeet_*       (auth tokens, user object)       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ chrome.storage.sync                                  │    │
│  │  - pm_settings (triggerMode, cacheDuration, etc.)    │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
          │
          │  Auth (Google OAuth token)
          ▼
┌──────────────────────────────────────────────────────────────┐
│  BACKEND (Deno Deploy Edge Functions)                        │
│                                                              │
│  auth-google    ──▶ Google Userinfo API (verify token)       │
│                 ──▶ Neon DB (upsert user, create session)    │
│                                                              │
│  auth-refresh   ──▶ Neon DB (validate/rotate session)        │
│  auth-me        ──▶ Neon DB (read user record)               │
│  auth-logout    ──▶ Neon DB (delete session)                 │
│                                                              │
│  enrichment-    ──▶ BrightData APIs (SERP, scrape, filter)   │
│  proxy              (proxies extension requests; API key     │
│                      stays server-side)                      │
│                                                              │
│  billing-*      ──▶ Stripe API (checkout, portal, status)    │
│  stripe-webhook ◀── Stripe (subscription events)             │
│                 ──▶ Neon DB (update subscription/tier)        │
└──────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────┐
│  NEON SERVERLESS POSTGRES                                    │
│                                                              │
│  users              — id, email, name, google_oauth_id,      │
│                       subscription_tier, credits_used/limit  │
│  sessions           — token_hash, expires_at                 │
│  enrichment_cache   — entity_type, entity_key, JSONB data,   │
│                       confidence, 7-day TTL                  │
│  enrichment_requests— user_id, entity_key, status,           │
│                       credits_used, meeting_title            │
│  subscriptions      — stripe_customer_id,                    │
│                       stripe_subscription_id, tier, status   │
│  billing_events     — stripe_event_id, event_type, JSONB     │
│  cache_stats        — date, entity_type, hits, misses        │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Third-Party Data Sharing Inventory

| Third Party | What Data Is Sent | Why | Data Use by Third Party | Contractual Basis |
|-------------|-------------------|-----|------------------------|-------------------|
| **BrightData** | Attendee name, email, company name, LinkedIn URLs | Professional profile enrichment (core feature) | BrightData processes queries to return public professional data; subject to BrightData's data processing terms | Service provider (data processor) |
| **Gravatar (Automattic)** | SHA-256 hash of attendee email | Retrieve profile avatar image | Gravatar uses hash to look up registered avatars; cannot reverse hash to email | Public API, no contract needed |
| **Google** | Google OAuth access token (during sign-in only) | Verify user identity for account creation | Google verifies token and returns user profile (email, name) | Google OAuth Terms of Service |
| **Stripe** | User ID reference, subscription events | Payment processing for Pro subscriptions | Stripe processes payments and sends webhook events | Stripe Services Agreement |
| **Mixpanel** | Anonymous event data (feature usage, errors), user plan type | Product analytics to improve the extension | Mixpanel aggregates events for product dashboards; no PII beyond hashed distinct_id | Mixpanel Terms of Service |

**Key clarifications:**
- BrightData API key is embedded at build time and used by the extension's background service worker to call BrightData directly.
- Mixpanel receives anonymous product usage events (e.g., "sidepanel_opened", "brief_completed") and the user's plan type for segmentation. No attendee PII is sent to Mixpanel.
- No data is sold to or shared with data brokers or advertisers.
- No data is transferred for purposes unrelated to the extension's core functionality.
- No data is used to determine creditworthiness or for lending purposes.

---

## 4. Recommended CWS Privacy Tab Selections

### Single Purpose Description
> PreMeet turns Google Calendar meeting invites into professional briefs by looking up publicly available information about meeting attendees.

### Permission Justifications (for CWS review)

| Permission | Justification |
|------------|---------------|
| `storage` | Store cached professional profiles and user preferences locally in the browser |
| `identity` | Authenticate the user via Google OAuth for account management and billing |
| `sidePanel` | Display attendee briefs in Chrome's side panel alongside Google Calendar |

### Host Permission Justifications

| Host | Justification |
|------|---------------|
| `https://calendar.google.com/*` | Inject content script to read attendee names/emails from calendar event pages — the only site PreMeet operates on |
| `https://api.brightdata.com/*` | Look up publicly available professional profile data for meeting attendees via the BrightData enrichment API. API key is injected at build time. |
| `https://www.gravatar.com/*` | Fetch attendee avatar images using email hash |
| `https://api-js.mixpanel.com/*` | Send anonymous product analytics events (feature usage, errors) to Mixpanel for product improvement. No PII is included in event payloads beyond the user's Mixpanel distinct_id. |

### Data Use Certification Checkboxes

**Check YES for:**
- [x] Personally identifiable information
- [x] Authentication information
- [x] Website content

**Check NO for:**
- [ ] Health information
- [ ] Financial and payment information *(Stripe is server-side only, not in extension)*
- [ ] Personal communications
- [ ] Location
- [ ] Web history
- [x] User activity *(anonymous product usage events via Mixpanel — not input monitoring)*

### For Each YES — Required Disclosures

#### Personally Identifiable Information
- **What:** Attendee names and email addresses from Google Calendar event pages
- **Why:** Core functionality — generating professional meeting briefs
- **Transferred to third parties?** Yes — to BrightData for enrichment lookups and Gravatar for avatar images
- **Used for purposes unrelated to extension?** No
- **Combined with PII?** Yes — name + email combined to perform enrichment

#### Authentication Information
- **What:** Google OAuth tokens, session tokens
- **Why:** User account management and subscription access
- **Transferred to third parties?** Yes — Google OAuth token sent to Google for verification
- **Used for purposes unrelated to extension?** No

#### Website Content
- **What:** Attendee metadata (name, email) from Google Calendar event detail popups
- **Why:** Core functionality — identifying meeting participants
- **Transferred to third parties?** Yes — to BrightData for professional lookups
- **Used for purposes unrelated to extension?** No

---

## 5. Data Retention Summary

| Data | Location | Retention | Deletion Method |
|------|----------|-----------|-----------------|
| Cached profiles | `chrome.storage.local` | 7-day auto-expiry (TTL) | User can clear via popup; auto-cleared on uninstall |
| Cached profiles | Neon `enrichment_cache` | 7-day auto-expiry (`expires_at`) | Server-side cleanup job |
| Activity log | `chrome.storage.local` | 500 entries max (FIFO) | User can clear; auto-cleared on uninstall |
| Auth tokens | `chrome.storage.local` | Until sign-out or session expiry | Cleared on sign-out; auto-cleared on uninstall |
| User settings | `chrome.storage.sync` | Until user changes | Cleared on uninstall |
| User account | Neon `users` | Until account deletion | Manual deletion request |
| Session records | Neon `sessions` | Until expiry (~30 days) | Auto-expired |
| Enrichment requests | Neon `enrichment_requests` | 90 days (auto-purged) | Automatic purge after 90 days; cascade delete on account deletion |
| Subscription records | Neon `subscriptions` | Until account deletion | Cascade delete with user |
| Billing events | Neon `billing_events` | Indefinite (audit log) | Manual deletion request |
| Cache statistics | Neon `cache_stats` | Indefinite (aggregated, non-PII) | N/A (no PII) |

---

## 6. Recommendations / Action Items

1. ~~**Remove `https://api.brightdata.com/*` from `host_permissions`**~~ — NOT applicable; the extension calls BrightData directly from `brightdata-proxy.ts` with a build-time API key. Permission is required.

2. ~~**Audit `alarms` permission**~~ ✅ Already removed — not present in manifest.json.

3. ~~**Update privacy policy**~~ ✅ Done (PRE-68) — privacy policy now discloses Neon server-side storage, BrightData as data processor, Stripe payment processing, and enrichment request log retention.

4. **Consider adding a data deletion endpoint** — to support GDPR/CCPA right-to-erasure requests (delete user + cascade all related records).

5. **CWS "limited use" compliance** ✅ Verified:
   - Data is not sold ✓
   - Data is not used for advertising ✓
   - Data is not transferred for creditworthiness ✓
   - Data use is related to core functionality ✓

6. **Set real OAuth client_id in manifest** — currently a placeholder (`YOUR_GOOGLE_OAUTH_CLIENT_ID`). Blocked on [PRE-69](/PRE/issues/PRE-69).

---

## 7. Certification Statements

> "I certify that my item's data use complies with the Chrome Web Store Developer Program Policies"

**Assessment:** PreMeet's data practices comply with CWS policies. All data collection serves the extension's core purpose. No data is sold or used for advertising. Recommend addressing the action items above before submission.

> "I certify my disclosures regarding data collection and use are accurate"

**Assessment:** The disclosures in this document accurately reflect the current codebase as of 2026-03-25. The privacy policy (`cws-assets/privacy-policy.md`) has been updated (PRE-68) to disclose server-side storage, BrightData, Stripe, and enrichment request log retention.
