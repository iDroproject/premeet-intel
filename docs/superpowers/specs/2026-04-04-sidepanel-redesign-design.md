# PreMeet Sidepanel Redesign — Design Spec

**Date:** 2026-04-04
**Version:** 1.0
**Author:** Daniel Oren + Claude

## Problem

The current sidepanel is a vertical wall of text with no visual hierarchy. Sections that have no data show error messages. LinkedIn posts render in full. The confidence score is a tiny ring that nobody understands. There's no loading feedback beyond a spinner. For the core use case — "1 minute before a meeting with a big shot" — the UI fails to surface the most important information quickly.

## Goal

Redesign the sidepanel so a user can glance at it 60 seconds before a meeting and walk in knowing: who this person is, what they care about, and what their company does. The experience should feel modern, fast, and polished — not AI-generated.

## Constraints

- No features or functionality removed. Everything that exists today stays.
- Vanilla TypeScript + CSS (no framework migration). Follow existing patterns.
- Must work within Chrome extension sidepanel dimensions (~400px wide).
- Must use the ui-ux-pro-max design skill for implementation quality.
- All existing message types and background service worker communication preserved.

---

## User States

### State 1: Searching (skeleton)

When the waterfall runs after opening a calendar event.

- Each attendee gets a **skeleton card**: pulsing blocks for avatar (56px circle), name (120px bar), title (180px bar), company (100px bar).
- Cards animate in with staggered delay (50ms between each).
- **Thin progress bar** in the header area (like YouTube/GitHub loading bar) — animated, not a spinner.
- **Rotating microcopy** below the progress bar: "Searching Google...", "Reading LinkedIn...", "Finding profile..." — changes every 2-3 seconds to make the wait feel productive.

### State 2: Confirmation (search result)

After the waterfall finds a LinkedIn match, before the user commits a credit.

**Card content:**
- Avatar: 56px, circular. LinkedIn photo if available, initials fallback.
- Full name: clickable link to LinkedIn profile (opens in new tab).
- LinkedIn headline (e.g., "Product Strategy @ AppsFlyer") — pulled from SERP/scraper data already fetched.
- Company name with small company logo (if available).
- Location (e.g., "Tel Aviv, Israel").
- Email in tertiary text (11px).
- Connections + followers stats line.

**Confidence indicator:**
- Simple colored dot next to the name: red (<50), amber (50-69), green (70+).
- On hover: tooltip with plain-English explanation (e.g., "Matched by email and name on LinkedIn — high confidence").
- No ring chart. No confusing SVG. Just a dot and a tooltip.

**CTA button:**
- Full-width, prominent.
- Copy: **"Get Meeting Brief"** with smaller "Uses 1 credit" below.
- Not "Generate Brief" — "Get" is more direct and human.
- Button shows immediate visual feedback on click (color change, subtle press animation) before API responds.

**Multiple attendees:**
- Each attendee gets their own confirmation card.
- User can choose which ones to enrich.

### State 3: Enriching (skeleton brief)

After clicking "Get Meeting Brief". The card transitions into the brief layout.

- Smooth crossfade from confirmation card to brief skeleton.
- **Profile header skeleton**: compact avatar + name/title bars.
- **Meeting Brief skeleton**: 3 lines of varying-width pulsing bars.
- **Tab bar skeleton**: 3-4 grey pill-shaped tab placeholders.
- **Content area skeleton**: Structured blocks matching the tab content shape.
- Progress bar continues in header.
- Microcopy updates: "Scraping LinkedIn...", "Analyzing company...", "Building brief..."
- **Partial rendering**: As each data source arrives, its skeleton block crossfades to real content. Don't wait for everything.

### State 4: Brief Complete

The full enriched view.

**Sticky profile header (always visible, does not scroll):**
- Compact: avatar (40px) + name + title + company — all on ~2 lines.
- Confidence dot next to name (same hover tooltip behavior).

**Meeting Brief block (below header, scrolls with content):**
- 2-3 ice-breaker bullet points extracted from the person's background.
  - Sources: LinkedIn headline, recent posts themes, bio, work history highlights.
  - Example: "Wounded veteran advocate who recently rejoined AppsFlyer's product strategy team. Passionate about tech-driven team success."
- 1-sentence company summary.
  - Example: "AppsFlyer — Marketing analytics platform (Founded 2011, San Francisco, ~1,200 employees)"
- This block has a subtle distinct background (e.g., light indigo tint) to separate it visually.

**Tab bar:**
- Horizontal tabs below the brief block.
- Only tabs with actual data appear (no empty tabs).
- Available tabs and their content:

| Tab | Content | Data source |
|-----|---------|-------------|
| **Overview** | Work history (timeline, max 3 roles), education, skills (pills) | Scraper + Filter |
| **Company** | Logo + name, industry tag, size, HQ, founded, funding (total + last round + investors), products (pills), tech stack (pills), recent news (max 3), intent signals | Dataset Filter + Google AI Mode |
| **Posts** | Max 3 LinkedIn posts, 2-line clamp each, engagement count badge, "View on LinkedIn" link | Scraper/MCP posts |
| **Contact** | Phone + email (Pro only). Green themed. | Deep Lookup |
| **Research** | Custom query textarea with suggestions, results as snippet list | SERP + Discover API |

- Tab switches use a smooth horizontal slide transition.
- Active tab has an indigo underline indicator.

**Pro-only "Coming Soon" tabs (visible only to Pro users):**
- Hiring Signals, Stakeholder Map, Social Pulse, Reputation.
- Greyed out text + "Coming Soon" badge.
- Clicking shows a brief message: "We're building this. Stay tuned."
- Free users do not see these tabs at all.

### State 5: Credits Exhausted (free user)

When a free user has used all 10 monthly credits.

- **Persistent banner** at the top of the sidepanel (below header, above cards):
  - "You've used all 10 free briefs this month."
  - **"Upgrade to Pro"** button (links to billing-checkout).
  - Dismissable (X button) but reappears on next panel open.
- Previously generated briefs remain fully visible and usable.
- "Get Meeting Brief" button changes to: **"Upgrade to unlock"** (disabled state, links to upgrade).
- Search still works (0 credits) — user can still see confirmation cards.

### State 6: Pro User

- No credit counter friction. Credits badge in header shows "Pro" instead of "X/Y left".
- "Coming Soon" greyed tabs visible (Hiring, Stakeholders, Social, Reputation).
- Contact Info and Custom Research available without upgrade prompts.

---

## Error Handling

### User-Facing Errors

No raw technical messages shown to users. Two categories:

**Expected failures (no data found):**
- "We couldn't find a LinkedIn profile for this person."
- "No company data available yet."
- Friendly tone, no alarm. Grey text, subtle.

**Unexpected failures (something broke):**
- Compact error card: "Something went wrong."
- **"Report Issue"** button below.
- Clicking opens a `mailto:contact@danielroren.com` link pre-filled with:
  - Subject: `[PreMeet Bug] {error type} — v{version}`
  - Body: Error message, endpoint that failed, timestamp (ISO), user email, extension version, attendee name/email being enriched, browser/OS info from `navigator.userAgent`.
- Format: `mailto:contact@danielroren.com?subject=...&body=...` — no backend needed.

**Retry behavior:**
- For unexpected errors, show a "Try Again" button alongside "Report Issue".
- "Try Again" re-triggers the failed enrichment step.

### Error States Per Section

- **Search fails**: "Couldn't find this person. Check the spelling or try a different email." + "Report Issue" if it was a network/auth error.
- **Enrichment fails**: Brief skeleton stops animating, shows: "Brief couldn't be completed." + "Try Again" + "Report Issue".
- **Individual tab fails**: That tab shows inline: "Couldn't load this data." + "Try Again". Other tabs unaffected.
- **Auth expired**: "Session expired. Please sign in again." with sign-in button. No retry loop.

---

## Perceived Performance

### Loading Feedback

- **Thin progress bar** in header: animated gradient bar (indigo → light indigo) that progresses based on waterfall steps. Not fake — tied to actual step completion percentages.
- **Rotating microcopy**: Below progress bar during enrichment. Updates as each layer completes:
  - "Searching Google..." → "Reading LinkedIn..." → "Analyzing company..." → "Building your brief..."
- **Skeleton everywhere**: Every component that will eventually have data shows a content-shaped skeleton placeholder first. No blank spaces, no spinners.

### Animation & Transitions

- **Skeleton → data crossfade**: 200ms fade, no flash of empty content.
- **Staggered card entrance**: Cards animate in with 50ms stagger (fade-in-up, 200ms each).
- **Tab switch**: Horizontal slide (150ms ease-out). Active tab underline slides to new position.
- **Button press feedback**: Immediate color/scale change on mousedown (50ms), before API responds.
- **Section expand/collapse**: Smooth height animation (200ms ease).
- **Data arrival pulse**: When deep enrichment data arrives (updating an already-visible card), brief subtle pulse animation on the updated section to draw attention.

### Performance Hacks

- **Optimistic tab bar**: Show tab bar skeleton immediately. Tabs appear one by one as their data arrives.
- **Partial rendering**: Each section renders the moment its data arrives. Overview tab can show work history from the scraper while company tab still loads from Dataset Filter.
- **Instant CTA feedback**: "Get Meeting Brief" immediately changes to "Loading..." with a small spinner inside the button on click.
- **Pre-render company section**: If SERP already returned company name + LinkedIn URL, show the Company tab with whatever data is available, fill in deep data when it arrives.

---

## Design Tokens (updates to existing)

Keep the existing CSS custom property system. Key additions:

```
--pm-skeleton-base: #E5E7EB
--pm-skeleton-shine: #F3F4F6
--pm-brief-bg: #F0F0FF          (light indigo tint for brief block)
--pm-tab-active: var(--pm-primary)
--pm-tab-inactive: var(--pm-text-tertiary)
--pm-confidence-red: #DC2626
--pm-confidence-amber: #D97706
--pm-confidence-green: #059669
--pm-banner-bg: #FEF3C7          (amber light for credit warning)
--pm-banner-text: #92400E
--pm-error-bg: #FEF2F2
--pm-error-text: #991B1B
```

---

## Component Inventory

All existing components preserved. Changes and additions:

| Component | Change | Notes |
|-----------|--------|-------|
| Card skeleton | **New** | Structured skeleton for searching state |
| Confidence dot | **Replace** ring SVG with colored dot + tooltip | Simpler, clearer |
| CTA button | **Update** copy and add press animation | "Get Meeting Brief" |
| Meeting Brief block | **New** | Ice-breaker points + company 1-liner |
| Tab bar | **New** | Horizontal tabs with slide transition |
| Tab content panels | **New** | Wrappers for each tab's content |
| Section skeletons | **Enhance** | More structured, content-shaped |
| Progress bar | **New** | Thin header bar tied to waterfall steps |
| Microcopy rotator | **New** | Rotating status text during enrichment |
| Credit banner | **New** | Persistent upgrade prompt for exhausted free users |
| Error card | **New** | Friendly error + "Report Issue" mailto + "Try Again" |
| Post snippet | **Update** | 2-line clamp, engagement badge, LinkedIn link |
| Company section | **Update** | Logo inline, structured layout, AI overview |
| "Coming Soon" tab | **New** | Greyed tab for Pro users, placeholder content |
| Bio section | **Update** | 3-line clamp with "Show more" toggle (existing, keep) |
| Work history | **Update** | Move into Overview tab (was standalone section) |
| Education | **Update** | Move into Overview tab |
| Skills | **Update** | Move into Overview tab |
| Contact info | **Update** | Move into Contact tab |
| Custom research | **Update** | Move into Research tab |
| Recent posts | **Update** | Move into Posts tab, 2-line clamp, max 3 |
| Power-up buttons | **Update** | Remove grid, each becomes a tab when implemented |
| Expandable sections | **Keep** | Used within tabs for sub-sections |

---

## Data Flow

No changes to the background service worker communication. All existing message types preserved:

- `MEETING_UPDATE`, `ATTENDEE_UPDATE` — Drive card rendering
- `COMPANY_INTEL_RESULT` — Populates Company tab
- `CONTACT_INFO_RESULT` — Populates Contact tab
- `CUSTOM_ENRICHMENT_RESULT` — Populates Research tab
- `HIRING_SIGNALS_RESULT`, `STAKEHOLDER_MAP_RESULT`, `SOCIAL_PULSE_RESULT`, `REPUTATION_RESULT` — Populate their respective tabs when implemented
- All `FETCH_*` outgoing messages preserved

The only data flow addition: the Meeting Brief block's ice-breaker points are **derived client-side** from existing enrichment data. The derivation logic:

1. **Point 1 (Role)**: Combine current title + company + tenure from work history. E.g., "VP Product Strategy at AppsFlyer (3.5 years)"
2. **Point 2 (Background)**: Extract most notable prior role or education. E.g., "Previously led customer success across North America, Israel, and UK"
3. **Point 3 (Personal)**: First sentence of bio or theme from recent post. E.g., "Passionate about wounded veteran rehabilitation and tech-driven team success"

If any source is missing, skip that point (show 1-2 instead of 3). No new API call needed.

---

## Files Affected

- `src/sidepanel/index.html` — CSS updates (new tokens, tab styles, skeleton styles, animations, progress bar, banner, error card)
- `src/sidepanel/index.ts` — Rendering logic (tab system, brief block, confidence dot, error handling with mailto, skeleton management, microcopy rotator, credit banner, "Coming Soon" tabs)

No backend changes needed. No new endpoints. No message type changes.

---

## ui-ux-pro-max Design Rules (mandatory)

All implementation must follow these rules from the ui-ux-pro-max skill:

### Icons
- **SVG icons only** (Lucide or Heroicons). Replace all emojis used as icons (🏢, 📊, 👥, 📢, ⭐, 📞, 🔍).
- Consistent icon style: same stroke width, corner radius across all icons.
- Icon-only buttons must have `aria-label`.

### Touch & Interaction
- All clickable elements min **44x44px** touch target.
- **8px minimum** spacing between touch targets.
- **cursor: pointer** on all clickable elements.
- **touch-action: manipulation** to remove 300ms tap delay.
- Visual press feedback: subtle scale (0.97) on mousedown, restore on release.

### Accessibility
- **4.5:1** contrast ratio for all text.
- Visible focus rings (2-4px) on interactive elements.
- `aria-label` on icon-only buttons.
- Sequential heading hierarchy (h1 → h2 → h3).
- `prefers-reduced-motion`: disable all animations, show content instantly.
- Confidence dot must use icon/text alongside color (color-not-only rule).

### Typography
- Body text: **16px** minimum.
- Line height: **1.5** for body.
- Font scale: 12, 14, 16, 18, 24 (no arbitrary sizes).
- Truncation: ellipsis + tooltip for full text.
- Semantic color tokens in CSS, no raw hex in components.

### Spacing
- **4px/8px** spacing scale throughout.
- Consistent padding: 8, 12, 16, 24px.

### Animation (all durations)
- Micro-interactions: **150-300ms**.
- Complex transitions: max **400ms**.
- Easing: **ease-out** for enter, **ease-in** for exit.
- Stagger list items: **30-50ms** per item.
- Exit animations: **60-70%** of enter duration.
- Crossfade for content replacement within same container.
- Scale feedback: 0.97 on press, 1.0 on release.
- Transform/opacity only — never animate width/height.
- Animations must be interruptible by user action.
- `prefers-reduced-motion` disables all motion.

### Loading
- Skeleton/shimmer for any loading state >300ms.
- Reserve space for async content (no layout shift / CLS).
- Progressive loading: show content as it arrives, don't block on full load.

### Forms & Feedback
- Error messages: state cause + how to fix (not just "Error").
- Error recovery: always include retry path.
- Disabled elements: 0.38-0.5 opacity + cursor change.
- Success feedback: brief visual confirmation (checkmark, color flash).

### Navigation
- Active tab: visually highlighted (color, weight, underline indicator).
- Tab count: max 5 visible.
- "Coming Soon" tabs: explain why unavailable, don't silently hide from Pro users.

### Style
- One primary CTA per screen (the "Get Meeting Brief" button).
- Elevation: consistent shadow scale for cards.
- No mixing of style paradigms (flat + skeuomorphic).

---

## Implementation Notes

- Use the **ui-ux-pro-max** design skill rules above for all CSS and visual implementation.
- The sidepanel is vanilla TypeScript (no React). Follow the existing pattern of string-based HTML rendering with `innerHTML`.
- The file `index.ts` is ~1,700 lines. The redesign will modify most rendering functions but should not increase file size significantly — the tab system replaces the current stacked sections, it doesn't add on top.
- Test in Chrome extension sidepanel context (~400px wide). Verify on both Mac and Windows Chrome.
- Skeleton animations should use CSS only (`transform` and `opacity` — no JS timers for shimmer).
- The `mailto:` error reporting uses `encodeURIComponent` for all dynamic values to prevent injection.
- Replace all emoji icons with inline SVGs from Lucide (building, chart-bar, users, megaphone, star, phone, search, briefcase, graduation-cap, tag).

---

## Out of Scope

- Framework migration (React/Vue/Svelte)
- New API endpoints or backend changes
- Implementing the "Coming Soon" features (Hiring, Stakeholders, Social, Reputation)
- AI-powered post summarization (future Pro feature)
- Dark mode (future spec)
- Mobile/responsive (sidepanel is fixed-width)
