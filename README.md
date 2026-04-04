# PreMeet

**v2.5.0**

> Turn every calendar invite into a complete business brief.

PreMeet is a Chrome extension + Vercel backend that surfaces LinkedIn profiles, company intelligence, and professional background on meeting attendees directly inside Google Calendar.

## How It Works

1. Open any event in Google Calendar
2. Click **"Search"** next to any attendee — gets a quick preview (0 credits)
3. Click **"Brief"** for full enrichment — profile, company intel, hiring signals, and more (1 credit)

## Architecture

```
Chrome Extension (TypeScript + Vite)
  ├── Content Scripts → Inject buttons into Google Calendar
  ├── Popup → Settings, auth, credit usage, activity log
  ├── Side Panel → Profile cards, company intel, enrichment actions
  └── Service Worker → Waterfall orchestrator, cache, messaging

Vercel Backend (TypeScript Edge/Serverless Functions)
  ├── Auth → Google OAuth → JWT sessions (Neon Postgres)
  ├── Billing → Stripe checkout, subscriptions, credits
  └── Enrichment APIs → Progressive fallback chains
```

## BrightData API Integration

### API Map

| # | API | Type | Latency | Purpose |
|---|---|---|---|---|
| 1 | **SERP API** | Sync | ~2s | Discover LinkedIn URL/ID from name + email |
| 2a | **Web Scraper API (WSA)** | Sync | ~10-16s | Real-time LinkedIn profile scrape (668M profiles) |
| 2b | **Dataset Filter API** | Async | ~15-60s | Query pre-collected enriched datasets (331 company datapoints, 55 employee datapoints) |
| 3 | **BrightData MCP** | SSE | 5-90s | Social media, Crunchbase, ZoomInfo (22 tools) |
| 4a | **Deep Lookup — Enrichment** | Async | ~60-120s | Enrich entities (email, phone, funding, CEO) |
| 4b | **Deep Lookup — Discovery** | Async | ~60-120s | Find entities matching business questions |
| 5 | **Discover API** | Async | ~30-70s | Deeper SERP with reranking + intent |
| 6 | **Web Scraper Google AI Mode** | Sync | ~10-16s | AI-generated company overview + products |

### Datasets

| Dataset | ID | Records | Datapoints | Use |
|---|---|---|---|---|
| LinkedIn Profiles | `gd_l1viktl72bvl7bjuj0` | 668M | 34 | Person profile scrape (WSA) |
| Enriched Employee | `gd_m18zt6ec11wfqohyrs` | 267M | 55 | Person enrichment (Dataset Filter) |
| Enriched Company | `gd_m3fl0mwzmfpfn4cw4` | 58.71M | 331 | Company enrichment (Dataset Filter) |
| Google AI Mode | `gd_mcswdt6z2elth3zqr2` | — | — | AI-generated company overview + products |

### Fallback Chains (Progressive Enrichment)

**Person lookup:**
1. SERP API (discover LinkedIn URL) → 2. WSA Scrape (real-time profile) → 3. Dataset Filter (enriched employee data) → 4. MCP (social media fallback) → 5. Deep Lookup (contact info, premium)

**Company lookup (hybrid progressive):**
1. **Fast:** SERP API (discover LinkedIn URL/ID, ~3s) → basic profile card
2. **Deep:** Dataset Filter with `id_lc` (331 datapoints) + Google AI Mode Web Scraper (overview, products) — run in parallel, merged into card

**Custom search:**
1. SERP (fast results) → 2. MCP social media (LinkedIn posts, X, Reddit) → 3. Discover API (deep reranked results)

**Contact info (premium, 2 credits):**
1. Deep Lookup Enrichment API

## Project Structure

```
premeet-intel/
├── src/                         # Chrome extension source (TypeScript)
│   ├── background/              # Service worker, waterfall orchestrator
│   ├── content/                 # Content scripts (button injector, calendar observer)
│   ├── popup/                   # Extension popup (settings, auth, credits)
│   ├── sidepanel/               # Side panel (profile cards, enrichment UI)
│   └── lib/                     # Shared utilities (auth, credits, analytics)
├── api/                         # Vercel backend (TypeScript)
│   ├── _shared/                 # Shared modules
│   │   ├── auth-middleware.ts   # JWT auth with CORS
│   │   ├── cors.ts              # Chrome extension origin validation
│   │   ├── db.ts                # Neon Postgres client
│   │   ├── deep-lookup.ts       # Deep Lookup API client
│   │   ├── fallback-chain.ts    # Generic progressive enrichment executor
│   │   ├── fetch-retry.ts       # Fetch with exponential backoff
│   │   ├── jwt.ts               # JWT creation/verification (jose)
│   │   ├── mcp-client.ts        # BrightData MCP SSE protocol client
│   │   └── stripe.ts            # Stripe SDK wrapper
│   ├── auth-*.ts                # Auth endpoints (Google OAuth, refresh, logout)
│   ├── billing-*.ts             # Billing endpoints (Stripe checkout, usage)
│   ├── enrichment-company.ts    # Company basic profile (fast SERP, ~3s)
│   ├── enrichment-company-deep.ts # Company deep enrichment (Dataset Filter + AI Mode)
│   ├── enrichment-contact.ts    # Contact info via Deep Lookup (premium)
│   ├── enrichment-custom.ts     # Custom search with MCP social media
│   ├── enrichment-hiring-signals.ts  # Hiring signals (stub, coming soon)
│   ├── enrichment-stakeholder-map.ts # Stakeholder map (stub, coming soon)
│   ├── enrichment-social-pulse.ts    # Social pulse (stub, coming soon)
│   ├── enrichment-proxy.ts      # BrightData API proxy (keeps key server-side)
│   ├── enrichment-mcp/          # MCP aggregator (Crunchbase + ZoomInfo)
│   └── stripe-webhook.ts        # Stripe webhook handler
├── dist/                        # Built extension (load unpacked from here)
├── icons/                       # Extension icons
├── vercel.json                  # Vercel deployment config
├── vite.config.ts               # Vite build config
└── package.json                 # Dependencies and scripts
```

## Getting Started

### Prerequisites
- Node.js 18+, pnpm
- Chrome browser
- Vercel account (for backend)
- BrightData API key
- Neon Postgres database
- Stripe account (for billing)
- Google OAuth client ID

### Setup

```bash
git clone https://github.com/iDroproject/premeet-intel.git
cd premeet-intel
pnpm install
cp .env.example .env  # Fill in API keys
pnpm run build
```

### Load Extension
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" → select the `dist/` folder

### Deploy Backend
```bash
vercel deploy --prod
```

## Credit System

| Action | Credits |
|---|---|
| Search (preview) | 0 |
| Full Brief | 1 |
| Company Intel | 1 |
| Contact Info | 2 (premium) |
| Custom Search | 2 |
| Hiring Signals | 0.5 |
| Social Pulse | 0.5 |

**Free plan:** 10 credits/month | **Pro plan:** Unlimited

## License

Proprietary. All rights reserved.
