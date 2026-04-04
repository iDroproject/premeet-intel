# Sidepanel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the PreMeet Chrome extension sidepanel for the "1 minute before a meeting" use case — tab-based navigation, ice-breaker brief, skeleton loading, friendly errors, and modern polish following ui-ux-pro-max design rules.

**Architecture:** Vanilla TypeScript + CSS (no framework). Two files: `index.html` (CSS + markup) and `index.ts` (rendering logic). The redesign replaces the stacked-section layout with a tab system, adds skeleton states, replaces emoji icons with Lucide SVGs, and adds error reporting via mailto. All existing message types and background worker communication preserved.

**Tech Stack:** TypeScript, CSS custom properties, Lucide SVG icons (inline), Chrome Extension APIs (runtime.sendMessage, onMessage)

**Spec:** `docs/superpowers/specs/2026-04-04-sidepanel-redesign-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/sidepanel/index.html` | Modify | CSS design tokens, skeleton styles, tab styles, animation keyframes, progress bar, credit banner, error card, SVG icon sprites |
| `src/sidepanel/index.ts` | Modify | Tab system, brief block renderer, confidence dot, skeleton management, microcopy rotator, error handling with mailto, credit banner logic, "Coming Soon" tabs, SVG icon helpers |
| `src/sidepanel/icons.ts` | Create | Lucide SVG icon constants (building, chart-bar, users, megaphone, star, phone, search, briefcase, graduation-cap, tag, alert-circle, external-link, loader, chevron-down, check-circle, x-circle, message-square, globe, clock, sparkles) |
| `src/manifest.json` | Modify | Version bump to 2.5.0 |
| `package.json` | Modify | Version bump to 2.5.0 |
| `README.md` | Modify | Version bump to 2.5.0 |

---

### Task 1: Create SVG Icon Module

**Files:**
- Create: `src/sidepanel/icons.ts`

- [ ] **Step 1: Create the icon module with all Lucide SVGs**

Create `src/sidepanel/icons.ts` with inline SVG strings for every icon used in the sidepanel. Each icon is a function that returns an SVG string with configurable size and class.

```typescript
// src/sidepanel/icons.ts
// Lucide SVG icons for PreMeet sidepanel (replaces emoji icons)
// All icons: 24x24 viewBox, stroke-based, currentColor

export function icon(name: string, size = 16, className = ''): string {
  const svg = ICONS[name];
  if (!svg) return '';
  const cls = className ? ` class="${className}"` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${cls} aria-hidden="true">${svg}</svg>`;
}

const ICONS: Record<string, string> = {
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  'chart-bar': '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  megaphone: '<path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  briefcase: '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  'graduation-cap': '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 10 3 12 0v-5"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>',
  'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  'external-link': '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>',
  loader: '<line x1="12" x2="12" y1="2" y2="6"/><line x1="12" x2="12" y1="18" y2="22"/><line x1="4.93" x2="7.76" y1="4.93" y2="7.76"/><line x1="16.24" x2="19.07" y1="16.24" y2="19.07"/><line x1="2" x2="6" y1="12" y2="12"/><line x1="18" x2="22" y1="12" y2="12"/><line x1="4.93" x2="7.76" y1="19.07" y2="16.24"/><line x1="16.24" x2="19.07" y1="7.76" y2="4.93"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  sparkles: '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  linkedin: '<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};
```

- [ ] **Step 2: Verify the module compiles**

Run: `pnpm run build 2>&1 | tail -5`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/icons.ts
git commit -m "feat(sidepanel): add Lucide SVG icon module"
```

---

### Task 2: Update CSS Design Tokens & Base Styles

**Files:**
- Modify: `src/sidepanel/index.html` (lines 22-40, CSS tokens section)

- [ ] **Step 1: Add new design tokens and update base font size**

In the `:root` block, add the new tokens from the spec. Update `body` font-size from 12px to 14px (ui-ux-pro-max: min 16px for body, but sidepanel is constrained at ~400px — 14px is the minimum readable size).

Add after the existing tokens in `:root`:

```css
/* ── New tokens (sidepanel redesign) ── */
--pm-skeleton-base: #E5E7EB;
--pm-skeleton-shine: #F3F4F6;
--pm-brief-bg: #F0F0FF;
--pm-tab-active: var(--pm-primary);
--pm-tab-inactive: var(--pm-text-tertiary);
--pm-confidence-red: #DC2626;
--pm-confidence-amber: #D97706;
--pm-confidence-green: #059669;
--pm-banner-bg: #FEF3C7;
--pm-banner-text: #92400E;
--pm-error-bg: #FEF2F2;
--pm-error-text: #991B1B;
--pm-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--pm-shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
```

Update `body` font-size:

```css
body {
  font-family: var(--pm-font);
  font-size: 14px;
  line-height: 1.5;
  color: var(--pm-text);
  background: var(--pm-bg);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Add global interaction styles**

Add to the CSS (after body):

```css
/* ── Global interaction (ui-ux-pro-max) ── */
button, [role="button"], .pm-clickable {
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

button:active, [role="button"]:active, .pm-clickable:active {
  transform: scale(0.97);
}

*:focus-visible {
  outline: 2px solid var(--pm-primary);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 3: Add skeleton animation keyframes**

```css
/* ── Skeleton shimmer ── */
@keyframes pm-shimmer {
  0% { background-position: -200px 0; }
  100% { background-position: 200px 0; }
}

.pm-skeleton {
  background: linear-gradient(90deg, var(--pm-skeleton-base) 25%, var(--pm-skeleton-shine) 50%, var(--pm-skeleton-base) 75%);
  background-size: 400px 100%;
  animation: pm-shimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}

.pm-skeleton--circle { border-radius: 50%; }
.pm-skeleton--text { height: 14px; margin-bottom: 8px; }
.pm-skeleton--text-short { width: 40%; }
.pm-skeleton--text-medium { width: 65%; }
.pm-skeleton--text-wide { width: 90%; }
```

- [ ] **Step 4: Add progress bar styles**

```css
/* ── Progress bar (thin header bar) ── */
.pm-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--pm-primary), var(--pm-primary-light), var(--pm-primary));
  background-size: 200% 100%;
  animation: pm-progress-slide 1.5s ease-in-out infinite;
  transition: width 300ms ease-out;
  border-radius: 0 2px 2px 0;
}

@keyframes pm-progress-slide {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 5: Add tab bar styles**

```css
/* ── Tab bar ── */
.pm-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--pm-border);
  padding: 0 16px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.pm-tabs::-webkit-scrollbar { display: none; }

.pm-tab {
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--pm-tab-inactive);
  border: none;
  background: none;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition: color 200ms ease-out, border-color 200ms ease-out;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pm-tab:hover { color: var(--pm-text); }
.pm-tab--active {
  color: var(--pm-tab-active);
  border-bottom-color: var(--pm-tab-active);
  font-weight: 600;
}
.pm-tab--disabled {
  color: var(--pm-text-tertiary);
  opacity: 0.5;
  cursor: default;
}
.pm-tab--disabled:active { transform: none; }
.pm-tab__badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--pm-border-light);
  color: var(--pm-text-tertiary);
}

.pm-tab-content {
  padding: 16px;
  animation: pm-fadeIn 200ms ease-out;
}

@keyframes pm-fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 6: Add credit banner styles**

```css
/* ── Credit exhaustion banner ── */
.pm-credit-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--pm-banner-bg);
  color: var(--pm-banner-text);
  font-size: 13px;
  line-height: 1.4;
  border-bottom: 1px solid #FDE68A;
}
.pm-credit-banner__text { flex: 1; }
.pm-credit-banner__cta {
  padding: 6px 16px;
  background: var(--pm-warning);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  min-height: 44px;
  display: flex;
  align-items: center;
}
.pm-credit-banner__dismiss {
  background: none;
  border: none;
  color: var(--pm-banner-text);
  padding: 4px;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 7: Add error card styles**

```css
/* ── Error card ── */
.pm-error-card {
  padding: 16px;
  background: var(--pm-error-bg);
  border: 1px solid #FECACA;
  border-radius: var(--pm-radius);
  margin: 8px 16px;
}
.pm-error-card__message {
  color: var(--pm-error-text);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 12px;
}
.pm-error-card__actions {
  display: flex;
  gap: 8px;
}
.pm-error-card__btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pm-error-card__btn--retry {
  background: var(--pm-primary);
  color: white;
}
.pm-error-card__btn--report {
  background: var(--pm-surface);
  color: var(--pm-text-secondary);
  border: 1px solid var(--pm-border);
}
```

- [ ] **Step 8: Add brief block and confidence dot styles**

```css
/* ── Meeting Brief block ── */
.pm-brief {
  padding: 16px;
  background: var(--pm-brief-bg);
  border-radius: var(--pm-radius);
  margin: 12px 16px;
}
.pm-brief__title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pm-primary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pm-brief__points {
  list-style: none;
  padding: 0;
}
.pm-brief__point {
  font-size: 14px;
  line-height: 1.5;
  color: var(--pm-text);
  padding: 4px 0;
  padding-left: 16px;
  position: relative;
}
.pm-brief__point::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pm-primary);
}
.pm-brief__company {
  font-size: 13px;
  color: var(--pm-text-secondary);
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(79, 70, 229, 0.15);
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-brief__company-logo {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  object-fit: contain;
}

/* ── Confidence dot ── */
.pm-confidence-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-left: 6px;
  vertical-align: middle;
  position: relative;
}
.pm-confidence-dot--red { background: var(--pm-confidence-red); }
.pm-confidence-dot--amber { background: var(--pm-confidence-amber); }
.pm-confidence-dot--green { background: var(--pm-confidence-green); }

.pm-confidence-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--pm-text);
  color: white;
  font-size: 12px;
  line-height: 1.4;
  padding: 8px 12px;
  border-radius: 6px;
  white-space: nowrap;
  max-width: 250px;
  white-space: normal;
  z-index: 100;
  box-shadow: var(--pm-shadow-md);
}
.pm-confidence-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: var(--pm-text);
}
.pm-confidence-dot:hover .pm-confidence-tooltip { display: block; }

/* ── Microcopy rotator ── */
.pm-microcopy {
  font-size: 12px;
  color: var(--pm-text-tertiary);
  text-align: center;
  padding: 4px 16px;
  height: 20px;
  overflow: hidden;
}
.pm-microcopy__text {
  animation: pm-fadeIn 300ms ease-out;
}
```

- [ ] **Step 9: Add staggered card animation and post snippet styles**

```css
/* ── Staggered card entrance ── */
.pm-card-enter {
  opacity: 0;
  transform: translateY(8px);
  animation: pm-cardEnter 250ms ease-out forwards;
}
@keyframes pm-cardEnter {
  to { opacity: 1; transform: translateY(0); }
}

/* ── Post snippet (2-line clamp) ── */
.pm-post-snippet {
  padding: 12px 0;
  border-bottom: 1px solid var(--pm-border-light);
}
.pm-post-snippet:last-child { border-bottom: none; }
.pm-post-snippet__text {
  font-size: 14px;
  line-height: 1.5;
  color: var(--pm-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pm-post-snippet__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--pm-text-tertiary);
}
.pm-post-snippet__link {
  color: var(--pm-primary);
  font-size: 12px;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 8px 0;
}
.pm-post-snippet__link:hover { text-decoration: underline; }
```

- [ ] **Step 10: Verify build and commit**

Run: `pnpm run build 2>&1 | tail -3`
Expected: Build succeeds.

```bash
git add src/sidepanel/index.html
git commit -m "feat(sidepanel): add new CSS tokens, tab bar, skeleton, progress bar, error card, brief block, confidence dot styles"
```

---

### Task 3: Refactor Rendering — Icon Replacement & Confidence Dot

**Files:**
- Modify: `src/sidepanel/index.ts` (icon references and confidence rendering)

- [ ] **Step 1: Add icon import and replace emoji references**

At the top of `index.ts`, add the import:

```typescript
import { icon } from './icons';
```

Then find and replace all emoji icon usage throughout the file:
- `🏢` → `icon('building', 14)`
- `📊` → `icon('chart-bar', 14)`
- `👥` → `icon('users', 14)`
- `📢` → `icon('megaphone', 14)`
- `⭐` → `icon('star', 14)`
- `📞` / `📱` → `icon('phone', 14)`
- `🔍` → `icon('search', 14)`
- `💼` → `icon('briefcase', 14)`
- `🎓` → `icon('graduation-cap', 14)`
- `🏷️` → `icon('tag', 14)`
- Any other emojis used as functional icons

**Important:** Only replace emojis that serve as icons/labels. Do not replace emojis in user content or decorative text.

- [ ] **Step 2: Replace confidence ring with confidence dot**

Find the `renderConfidenceBadge()` function (or equivalent) and the `confidenceRingSvg()` function. Replace the SVG ring implementation with:

```typescript
function renderConfidenceDot(score: number | null, explanation?: string): string {
  if (score === null || score === undefined) return '';
  const level = score >= 70 ? 'green' : score >= 50 ? 'amber' : 'red';
  const label = score >= 70 ? 'High confidence' : score >= 50 ? 'Medium confidence' : 'Low confidence';
  const tooltipText = explanation || label;
  return `<span class="pm-confidence-dot pm-confidence-dot--${level}" aria-label="${label}: ${score}%" title="${escapeAttr(tooltipText)}">
    <span class="pm-confidence-tooltip">${escapeHtml(tooltipText)}</span>
  </span>`;
}
```

Update all call sites that render the confidence badge to use `renderConfidenceDot()` instead.

- [ ] **Step 3: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): replace emoji icons with Lucide SVGs, confidence dot replaces ring"
```

---

### Task 4: Implement Tab System

**Files:**
- Modify: `src/sidepanel/index.ts`

This is the core structural change. The current stacked sections become tabs.

- [ ] **Step 1: Add tab state management**

Add near the top of the file (with other state variables):

```typescript
// Tab state per attendee
const activeTab = new Map<string, string>();

const TAB_DEFS: Array<{
  id: string;
  label: string;
  iconName: string;
  dataCheck: (key: string) => boolean;
  proOnly?: boolean;
  comingSoon?: boolean;
}> = [
  { id: 'overview', label: 'Overview', iconName: 'briefcase', dataCheck: (key) => {
    const a = attendeeMap.get(key);
    return !!(a?.workHistory?.length || a?.education?.length || a?.skills?.length || a?.bio);
  }},
  { id: 'company', label: 'Company', iconName: 'building', dataCheck: (key) => {
    const state = companyIntelState.get(key);
    return state === 'loading' || (typeof state === 'object' && 'data' in state);
  }},
  { id: 'posts', label: 'Posts', iconName: 'message-square', dataCheck: (key) => {
    const a = attendeeMap.get(key);
    return !!(a?.recentPosts?.length);
  }},
  { id: 'contact', label: 'Contact', iconName: 'phone', dataCheck: (key) => {
    const state = contactInfoState.get(key);
    return state === 'loading' || (typeof state === 'object' && 'data' in state);
  }},
  { id: 'research', label: 'Research', iconName: 'search', dataCheck: (key) => {
    const state = customEnrichState.get(key);
    return state === 'loading' || (typeof state === 'object' && 'data' in state) || true; // always show research tab
  }},
  // Coming soon tabs — only visible to Pro users
  { id: 'hiring', label: 'Hiring', iconName: 'chart-bar', dataCheck: () => false, proOnly: true, comingSoon: true },
  { id: 'stakeholders', label: 'Stakeholders', iconName: 'users', dataCheck: () => false, proOnly: true, comingSoon: true },
  { id: 'social', label: 'Social', iconName: 'megaphone', dataCheck: () => false, proOnly: true, comingSoon: true },
  { id: 'reputation', label: 'Reputation', iconName: 'star', dataCheck: () => false, proOnly: true, comingSoon: true },
];
```

- [ ] **Step 2: Create tab bar renderer**

```typescript
function renderTabBar(key: string, userTier: string): string {
  const current = activeTab.get(key) || 'overview';
  const visibleTabs = TAB_DEFS.filter(tab => {
    if (tab.comingSoon && tab.proOnly && userTier !== 'pro') return false;
    if (tab.comingSoon) return true; // show as disabled for pro
    return tab.dataCheck(key);
  });

  if (visibleTabs.length === 0) return '';

  const tabsHtml = visibleTabs.map(tab => {
    const isActive = tab.id === current;
    const isDisabled = tab.comingSoon;
    const cls = [
      'pm-tab',
      isActive ? 'pm-tab--active' : '',
      isDisabled ? 'pm-tab--disabled' : '',
    ].filter(Boolean).join(' ');

    const badge = isDisabled ? '<span class="pm-tab__badge">Soon</span>' : '';
    const attrs = isDisabled
      ? 'aria-disabled="true"'
      : `data-tab="${tab.id}" data-key="${escapeAttr(key)}"`;

    return `<button class="${cls}" ${attrs} role="tab" aria-selected="${isActive}">${icon(tab.iconName, 14)} ${escapeHtml(tab.label)}${badge}</button>`;
  }).join('');

  return `<div class="pm-tabs" role="tablist">${tabsHtml}</div>`;
}
```

- [ ] **Step 3: Create tab content renderer**

```typescript
function renderTabContent(key: string, attendee: EnrichedAttendee): string {
  const current = activeTab.get(key) || 'overview';

  switch (current) {
    case 'overview': return renderOverviewTab(key, attendee);
    case 'company': return renderCompanyTab(key);
    case 'posts': return renderPostsTab(attendee);
    case 'contact': return renderContactTab(key, attendee);
    case 'research': return renderResearchTab(key, attendee);
    default: {
      // Coming soon tab
      const def = TAB_DEFS.find(t => t.id === current);
      if (def?.comingSoon) {
        return `<div class="pm-tab-content"><p style="color:var(--pm-text-tertiary);text-align:center;padding:32px 16px;">${icon('clock', 24, 'pm-coming-soon-icon')}<br><br>We're building ${escapeHtml(def.label)}. Stay tuned.</p></div>`;
      }
      return renderOverviewTab(key, attendee);
    }
  }
}
```

- [ ] **Step 4: Create individual tab content renderers**

These reuse the existing rendering functions (renderWorkHistory, renderEducation, renderSkills, renderCompanyIntelFromData, renderRecentPosts, renderContactInfoSection, renderCustomEnrichSection) but wrap them in the tab content container.

```typescript
function renderOverviewTab(key: string, attendee: EnrichedAttendee): string {
  const pd = attendee.personData;
  if (!pd) return `<div class="pm-tab-content"><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-wide"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-medium"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-short"></div></div>`;

  let html = '<div class="pm-tab-content">';

  // Bio
  if (pd.bio) {
    html += renderBioSection(pd.bio);
  }

  // Work history
  if (pd.workHistory && pd.workHistory.length > 0) {
    html += renderWorkHistory(pd);
  }

  // Education
  if (pd.education && pd.education.length > 0) {
    html += renderEducation(pd);
  }

  // Skills
  if (pd.skills && pd.skills.length > 0) {
    html += renderSkills(pd);
  }

  html += '</div>';
  return html;
}

function renderCompanyTab(key: string): string {
  const state = companyIntelState.get(key);
  if (state === 'loading' || state === 'idle' || !state) {
    return `<div class="pm-tab-content"><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-wide"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-medium"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-short"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-wide"></div><div class="pm-skeleton pm-skeleton--text pm-skeleton--text-medium"></div></div>`;
  }
  if (typeof state === 'object' && 'error' in state) {
    return `<div class="pm-tab-content">${renderErrorCard(state.error as string, 'company intel', key)}</div>`;
  }
  if (typeof state === 'object' && 'data' in state) {
    return `<div class="pm-tab-content">${renderCompanyIntelFromData(state.data as CompanyData)}</div>`;
  }
  return '<div class="pm-tab-content"></div>';
}

function renderPostsTab(attendee: EnrichedAttendee): string {
  const pd = attendee.personData;
  if (!pd?.recentPosts?.length) {
    return `<div class="pm-tab-content"><p style="color:var(--pm-text-tertiary);">No recent posts found.</p></div>`;
  }

  const posts = pd.recentPosts.slice(0, 3);
  let html = '<div class="pm-tab-content">';
  for (const post of posts) {
    const text = typeof post === 'string' ? post : (post.text || post.title || '');
    const url = typeof post === 'object' ? (post.url || post.link || '') : '';
    const engagement = typeof post === 'object' ? (post.interactions || post.likes || '') : '';

    html += `<div class="pm-post-snippet">
      <p class="pm-post-snippet__text">${escapeHtml(text)}</p>
      <div class="pm-post-snippet__meta">
        ${engagement ? `<span>${icon('zap', 12)} ${escapeHtml(String(engagement))}</span>` : ''}
        ${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="pm-post-snippet__link">${icon('external-link', 12)} View on LinkedIn</a>` : ''}
      </div>
    </div>`;
  }
  html += '</div>';
  return html;
}

function renderContactTab(key: string, attendee: EnrichedAttendee): string {
  // Reuse existing renderContactInfoSection logic
  return `<div class="pm-tab-content">${renderContactInfoSection(key, attendee)}</div>`;
}

function renderResearchTab(key: string, attendee: EnrichedAttendee): string {
  // Reuse existing renderCustomEnrichSection logic
  return `<div class="pm-tab-content">${renderCustomEnrichSection(key, attendee)}</div>`;
}
```

- [ ] **Step 5: Wire tab click handlers**

In the card listener attachment function, add tab click handling:

```typescript
// Tab click handler
card.addEventListener('click', (e) => {
  const tabBtn = (e.target as HTMLElement).closest('.pm-tab[data-tab]') as HTMLElement | null;
  if (!tabBtn) return;
  const tabId = tabBtn.dataset.tab!;
  const tabKey = tabBtn.dataset.key!;
  activeTab.set(tabKey, tabId);
  // Re-render the tab bar and content
  const tabBar = card.querySelector('.pm-tabs');
  const tabContent = card.querySelector('.pm-tab-content-container');
  if (tabBar) tabBar.outerHTML = renderTabBar(tabKey, currentUserTier);
  if (tabContent) tabContent.innerHTML = renderTabContent(tabKey, attendeeMap.get(tabKey)!);
});
```

- [ ] **Step 6: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): implement tab system replacing stacked sections"
```

---

### Task 5: Implement Meeting Brief Block

**Files:**
- Modify: `src/sidepanel/index.ts`

- [ ] **Step 1: Create brief block renderer**

```typescript
function deriveBriefPoints(attendee: EnrichedAttendee): string[] {
  const pd = attendee.personData;
  if (!pd) return [];
  const points: string[] = [];

  // Point 1: Current role
  if (pd.currentTitle && pd.currentCompany) {
    const tenure = pd.workHistory?.[0]?.startDate
      ? ` (since ${pd.workHistory[0].startDate})`
      : '';
    points.push(`${pd.currentTitle} at ${pd.currentCompany}${tenure}`);
  }

  // Point 2: Notable background
  if (pd.workHistory && pd.workHistory.length > 1) {
    const prev = pd.workHistory[1];
    if (prev.title && prev.company) {
      points.push(`Previously ${prev.title} at ${prev.company}`);
    }
  } else if (pd.education && pd.education.length > 0) {
    const edu = pd.education[0];
    const degree = edu.degree ? `${edu.degree}` : '';
    const school = edu.institution || edu.school || '';
    if (school) points.push(`${degree ? degree + ', ' : ''}${school}`);
  }

  // Point 3: Personal interest from bio
  if (pd.bio) {
    const firstSentence = pd.bio.split(/[.!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length > 10 && firstSentence.length < 200) {
      points.push(firstSentence);
    }
  }

  return points.slice(0, 3);
}

function renderBriefBlock(key: string, attendee: EnrichedAttendee): string {
  const points = deriveBriefPoints(attendee);
  const pd = attendee.personData;
  const cd = companyIntelState.get(key);
  const companyData = (typeof cd === 'object' && 'data' in cd) ? cd.data as CompanyData : null;

  if (points.length === 0 && !companyData) {
    // Skeleton while loading
    return `<div class="pm-brief">
      <div class="pm-brief__title">${icon('sparkles', 14)} Meeting Brief</div>
      <div class="pm-skeleton pm-skeleton--text pm-skeleton--text-wide"></div>
      <div class="pm-skeleton pm-skeleton--text pm-skeleton--text-medium"></div>
      <div class="pm-skeleton pm-skeleton--text pm-skeleton--text-short"></div>
    </div>`;
  }

  let html = `<div class="pm-brief">
    <div class="pm-brief__title">${icon('sparkles', 14)} Meeting Brief</div>
    <ul class="pm-brief__points">`;

  for (const point of points) {
    html += `<li class="pm-brief__point">${escapeHtml(point)}</li>`;
  }

  html += '</ul>';

  // Company 1-liner
  if (companyData) {
    const desc = companyData.description
      ? companyData.description.split('.')[0] + '.'
      : companyData.industry || '';
    const meta = [
      companyData.foundedYear ? `Founded ${companyData.foundedYear}` : '',
      companyData.hqAddress || '',
      companyData.sizeRange || '',
    ].filter(Boolean).join(' / ');

    const logoHtml = companyData.logo
      ? `<img src="${escapeAttr(companyData.logo)}" alt="" class="pm-brief__company-logo" onerror="this.style.display='none'">`
      : icon('building', 16);

    html += `<div class="pm-brief__company">
      ${logoHtml}
      <span>${escapeHtml(companyData.name || pd?.currentCompany || '')}${meta ? ' &mdash; ' + escapeHtml(meta) : ''}</span>
    </div>`;
  } else if (pd?.currentCompany) {
    html += `<div class="pm-brief__company">${icon('building', 16)} <span>${escapeHtml(pd.currentCompany)}</span></div>`;
  }

  html += '</div>';
  return html;
}
```

- [ ] **Step 2: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): add meeting brief block with ice-breaker points"
```

---

### Task 6: Implement Error Handling with Report Issue

**Files:**
- Modify: `src/sidepanel/index.ts`

- [ ] **Step 1: Create error card renderer with mailto**

```typescript
const REPORT_EMAIL = 'contact@danielroren.com';
const EXT_VERSION = chrome.runtime.getManifest().version;

function renderErrorCard(errorMessage: string, context: string, attendeeKey: string): string {
  const isExpected = errorMessage.includes('couldn\'t find') || errorMessage.includes('No ') || errorMessage.includes('not found');
  const friendlyMessage = isExpected
    ? errorMessage
    : 'Something went wrong. Please try again.';

  const subject = encodeURIComponent(`[PreMeet Bug] ${context} — v${EXT_VERSION}`);
  const body = encodeURIComponent([
    `Error: ${errorMessage}`,
    `Context: ${context}`,
    `Attendee: ${attendeeKey}`,
    `Time: ${new Date().toISOString()}`,
    `Version: ${EXT_VERSION}`,
    `UA: ${navigator.userAgent}`,
  ].join('\n'));

  const mailtoUrl = `mailto:${REPORT_EMAIL}?subject=${subject}&body=${body}`;

  return `<div class="pm-error-card">
    <p class="pm-error-card__message">${icon('alert-circle', 16)} ${escapeHtml(friendlyMessage)}</p>
    <div class="pm-error-card__actions">
      ${!isExpected ? `<button class="pm-error-card__btn pm-error-card__btn--retry" data-retry="${escapeAttr(context)}" data-key="${escapeAttr(attendeeKey)}">${icon('refresh-cw', 14)} Try Again</button>` : ''}
      <a href="${mailtoUrl}" class="pm-error-card__btn pm-error-card__btn--report">${icon('mail', 14)} Report Issue</a>
    </div>
  </div>`;
}
```

- [ ] **Step 2: Update all error rendering locations**

Find all places where raw error messages are shown to users and replace with `renderErrorCard()`. Key locations:
- Card search failure
- Enrichment failure
- Company intel failure
- Contact info failure
- Custom research failure
- Power-up failures (hiring, stakeholder, social, reputation)

- [ ] **Step 3: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): add friendly error cards with Report Issue mailto link"
```

---

### Task 7: Implement Skeleton Cards & Progress Bar

**Files:**
- Modify: `src/sidepanel/index.ts`
- Modify: `src/sidepanel/index.html`

- [ ] **Step 1: Create skeleton card renderer**

```typescript
function renderSkeletonCard(index: number): string {
  const delay = index * 40;
  return `<div class="pm-card pm-card-enter" style="animation-delay: ${delay}ms">
    <div class="pm-card__header">
      <div class="pm-skeleton pm-skeleton--circle" style="width:56px;height:56px;flex-shrink:0"></div>
      <div class="pm-card__body" style="flex:1;padding-left:12px">
        <div class="pm-skeleton pm-skeleton--text" style="width:120px;height:16px"></div>
        <div class="pm-skeleton pm-skeleton--text" style="width:180px;height:14px;margin-top:4px"></div>
        <div class="pm-skeleton pm-skeleton--text" style="width:100px;height:12px;margin-top:4px"></div>
      </div>
    </div>
  </div>`;
}
```

- [ ] **Step 2: Create microcopy rotator**

```typescript
const MICROCOPY_MESSAGES = [
  'Searching Google...',
  'Finding LinkedIn profile...',
  'Reading profile details...',
  'Analyzing background...',
  'Preparing your brief...',
];

let microcopyInterval: ReturnType<typeof setInterval> | null = null;
let microcopyIndex = 0;

function startMicrocopy(container: HTMLElement): void {
  stopMicrocopy();
  microcopyIndex = 0;
  container.innerHTML = `<div class="pm-microcopy"><span class="pm-microcopy__text">${MICROCOPY_MESSAGES[0]}</span></div>`;
  microcopyInterval = setInterval(() => {
    microcopyIndex = (microcopyIndex + 1) % MICROCOPY_MESSAGES.length;
    const el = container.querySelector('.pm-microcopy__text');
    if (el) {
      el.textContent = MICROCOPY_MESSAGES[microcopyIndex];
      el.classList.remove('pm-microcopy__text');
      void (el as HTMLElement).offsetWidth; // trigger reflow
      el.classList.add('pm-microcopy__text');
    }
  }, 2500);
}

function stopMicrocopy(): void {
  if (microcopyInterval) {
    clearInterval(microcopyInterval);
    microcopyInterval = null;
  }
}
```

- [ ] **Step 3: Add progress bar to header**

In the header HTML rendering, add the progress bar element:

```typescript
// Inside the header rendering, add:
`<div class="pm-progress-bar" id="pm-progress" style="width: 0%; display: none;"></div>`
```

Create update function:

```typescript
function updateProgressBar(percent: number): void {
  const bar = document.getElementById('pm-progress');
  if (!bar) return;
  if (percent <= 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  bar.style.width = `${Math.min(percent, 100)}%`;
  if (percent >= 100) {
    setTimeout(() => { bar.style.display = 'none'; }, 500);
  }
}
```

- [ ] **Step 4: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts src/sidepanel/index.html
git commit -m "feat(sidepanel): add skeleton cards, progress bar, and microcopy rotator"
```

---

### Task 8: Implement Credit Banner & Pro State

**Files:**
- Modify: `src/sidepanel/index.ts`

- [ ] **Step 1: Create credit banner renderer**

```typescript
function renderCreditBanner(creditsUsed: number, creditsLimit: number, tier: string): string {
  if (tier === 'pro') return ''; // Pro users: no banner
  if (creditsUsed < creditsLimit) return ''; // Still has credits

  return `<div class="pm-credit-banner" id="pm-credit-banner">
    <div class="pm-credit-banner__text">
      You've used all ${creditsLimit} free briefs this month.
    </div>
    <button class="pm-credit-banner__cta" id="pm-upgrade-btn">Upgrade to Pro</button>
    <button class="pm-credit-banner__dismiss" id="pm-banner-dismiss" aria-label="Dismiss">${icon('x-circle', 16)}</button>
  </div>`;
}
```

- [ ] **Step 2: Update CTA button for exhausted state**

When rendering the "Get Meeting Brief" button, check credit state:

```typescript
function renderCTAButton(key: string, creditsExhausted: boolean): string {
  if (creditsExhausted) {
    return `<button class="pm-cta pm-cta--disabled" disabled aria-label="Upgrade to get more briefs">
      ${icon('lock', 16)} Upgrade to unlock
    </button>`;
  }

  return `<button class="pm-cta" data-action="generate-brief" data-key="${escapeAttr(key)}">
    Get Meeting Brief
    <span class="pm-cta__hint">Uses 1 credit</span>
  </button>`;
}
```

- [ ] **Step 3: Update Pro user credits display**

In the header credits badge, show "Pro" for Pro users instead of "X/Y left":

```typescript
function renderCreditsDisplay(creditsUsed: number, creditsLimit: number, tier: string): string {
  if (tier === 'pro') {
    return `<span class="pm-credits pm-credits--pro">${icon('zap', 12)} Pro</span>`;
  }
  return `<span class="pm-credits">${creditsLimit - creditsUsed}/${creditsLimit} left</span>`;
}
```

- [ ] **Step 4: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): add credit exhaustion banner and Pro state display"
```

---

### Task 9: Wire Everything Into updateCardContent

**Files:**
- Modify: `src/sidepanel/index.ts`

This task integrates all the new components into the main card rendering flow.

- [ ] **Step 1: Update the enriched/complete card rendering**

In `updateCardContent()`, replace the existing stacked sections with the new brief block + tab layout for enriched cards. The card states are:

- **idle/pending**: Skeleton card
- **searched**: Confirmation card (identity + confidence dot + CTA)
- **enriching**: Brief skeleton + tab skeleton
- **complete**: Brief block + tab bar + active tab content

The key change: after the profile header, instead of rendering all sections stacked, render:

```typescript
// For enriched/complete cards:
let cardHtml = renderCompactProfileHeader(key, attendee);
cardHtml += renderBriefBlock(key, attendee);
cardHtml += renderTabBar(key, currentUserTier);
cardHtml += `<div class="pm-tab-content-container">${renderTabContent(key, attendee)}</div>`;
```

For searched (confirmation) cards, keep the larger profile header with headline, location, stats, and the CTA button. Add `renderConfidenceDot()` next to the name.

- [ ] **Step 2: Create compact profile header for enriched state**

```typescript
function renderCompactProfileHeader(key: string, attendee: EnrichedAttendee): string {
  const pd = attendee.personData;
  const sr = attendee.searchResult;
  const name = pd?.name || sr?.name || attendee.name || 'Unknown';
  const title = pd?.currentTitle || sr?.currentTitle || '';
  const company = pd?.currentCompany || sr?.currentCompany || '';
  const linkedinUrl = pd?.linkedinUrl || sr?.linkedinUrl || '';
  const avatarUrl = pd?.avatarUrl || sr?.avatarUrl || '';
  const score = pd?._confidenceScore ?? sr?.confidenceScore ?? null;

  const avatar = avatarUrl
    ? `<img src="${escapeAttr(avatarUrl)}" alt="" class="pm-avatar" width="40" height="40" style="border-radius:50%;" onerror="this.outerHTML='<div class=\\'pm-avatar pm-avatar--initials\\' style=\\'width:40px;height:40px;\\'>${initials(name)}</div>'">`
    : `<div class="pm-avatar pm-avatar--initials" style="width:40px;height:40px;">${initials(name)}</div>`;

  const nameLink = linkedinUrl
    ? `<a href="${escapeAttr(linkedinUrl)}" target="_blank" rel="noopener" class="pm-card__name">${escapeHtml(name)}</a>`
    : `<span class="pm-card__name">${escapeHtml(name)}</span>`;

  return `<div class="pm-card__header pm-card__header--compact">
    ${avatar}
    <div class="pm-card__body">
      <div>${nameLink}${renderConfidenceDot(score)}</div>
      <div class="pm-card__title">${escapeHtml(title)}${company ? ` at ${escapeHtml(company)}` : ''}</div>
    </div>
  </div>`;
}
```

- [ ] **Step 3: Ensure all existing message handlers still trigger re-renders**

Verify that `COMPANY_INTEL_RESULT`, `CONTACT_INFO_RESULT`, `CUSTOM_ENRICHMENT_RESULT`, and all power-up result handlers still properly update the card. The tab system should re-render the active tab content when new data arrives.

- [ ] **Step 4: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): wire brief block, tabs, and all new components into card rendering"
```

---

### Task 10: Confirmation Card Enhancement

**Files:**
- Modify: `src/sidepanel/index.ts`

- [ ] **Step 1: Update searched/confirmation card to show more identity signals**

For the "searched" state (before Generate Brief), show:
- Larger avatar (56px)
- Full name as LinkedIn link
- LinkedIn headline (from searchResult)
- Company + location on one line
- Email in tertiary text
- Connections + followers
- Confidence dot
- CTA button with better copy

```typescript
function renderConfirmationCard(key: string, attendee: EnrichedAttendee, creditsExhausted: boolean): string {
  const sr = attendee.searchResult;
  const name = sr?.name || attendee.name || 'Unknown';
  const title = sr?.currentTitle || '';
  const company = sr?.currentCompany || '';
  const location = sr?.location || '';
  const linkedinUrl = sr?.linkedinUrl || '';
  const avatarUrl = sr?.avatarUrl || '';
  const email = attendee.email || '';
  const connections = sr?.connections;
  const followers = sr?.followers;
  const score = sr?.confidenceScore ?? null;
  const confidence = sr?.confidence || '';

  const avatar = avatarUrl
    ? `<img src="${escapeAttr(avatarUrl)}" alt="" width="56" height="56" style="border-radius:50%;object-fit:cover;" onerror="this.outerHTML='<div class=\\'pm-avatar pm-avatar--initials\\' style=\\'width:56px;height:56px;font-size:18px;\\'>${initials(name)}</div>'">`
    : `<div class="pm-avatar pm-avatar--initials" style="width:56px;height:56px;font-size:18px;">${initials(name)}</div>`;

  const nameLink = linkedinUrl
    ? `<a href="${escapeAttr(linkedinUrl)}" target="_blank" rel="noopener" class="pm-card__name" style="font-size:16px;">${escapeHtml(name)}</a>`
    : `<span class="pm-card__name" style="font-size:16px;">${escapeHtml(name)}</span>`;

  const statsLine = [
    connections ? `<strong>${formatNumber(connections)}</strong> connections` : '',
    followers ? `<strong>${formatNumber(followers)}</strong> followers` : '',
  ].filter(Boolean).join(' &middot; ');

  const companyLocation = [company, location].filter(Boolean).join(' &middot; ');

  return `<div class="pm-card__header" style="align-items:flex-start;">
    ${avatar}
    <div class="pm-card__body" style="padding-left:12px;">
      <div>${nameLink}${renderConfidenceDot(score, confidence === 'partial' ? 'Matched but not fully verified. Check before using.' : score && score >= 70 ? 'Strong match on LinkedIn.' : 'Low confidence match. Verify before using.')}</div>
      ${title ? `<div class="pm-card__title" style="font-size:14px;margin-top:2px;">${escapeHtml(title)}</div>` : ''}
      ${companyLocation ? `<div style="font-size:13px;color:var(--pm-text-secondary);margin-top:2px;">${icon('building', 12)} ${escapeHtml(companyLocation)}</div>` : ''}
      ${email ? `<div style="font-size:12px;color:var(--pm-text-tertiary);margin-top:2px;">${escapeHtml(email)}</div>` : ''}
      ${statsLine ? `<div style="font-size:12px;color:var(--pm-text-secondary);margin-top:4px;">${statsLine}</div>` : ''}
    </div>
  </div>
  ${renderCTAButton(key, creditsExhausted)}`;
}
```

- [ ] **Step 2: Build and commit**

Run: `pnpm run build 2>&1 | tail -3`

```bash
git add src/sidepanel/index.ts
git commit -m "feat(sidepanel): enhance confirmation card with full identity signals"
```

---

### Task 11: Version Bump, Build, and Final Commit

**Files:**
- Modify: `src/manifest.json`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump version to 2.5.0**

Update `src/manifest.json` version from `2.4.0` to `2.5.0`.
Update `package.json` version from `2.4.0` to `2.5.0`.
Update `README.md` version from `v2.4.0` to `v2.5.0`.

- [ ] **Step 2: Full build**

Run: `pnpm run build 2>&1`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Final commit and push**

```bash
git add src/manifest.json package.json README.md
git commit -m "chore: bump version to 2.5.0 — sidepanel redesign"
git push origin main
```

---

### Task 12: Deploy and Verify

- [ ] **Step 1: Deploy to Vercel**

Run: `vercel --prod`

- [ ] **Step 2: Reload extension**

At `chrome://extensions`, reload the PreMeet extension.

- [ ] **Step 3: Manual verification checklist**

1. Open a Google Calendar event with attendees
2. Verify skeleton cards appear with shimmer animation
3. Verify progress bar animates in header
4. Verify microcopy rotates
5. After search: verify confirmation card shows full identity (name, headline, company, location, confidence dot)
6. Hover confidence dot: verify tooltip appears
7. Click "Get Meeting Brief": verify skeleton transitions to brief block + tabs
8. Verify Meeting Brief block shows ice-breaker points
9. Click each tab: verify content renders with slide animation
10. Verify "Coming Soon" tabs only visible to Pro users
11. Verify all SVG icons (no emojis visible)
12. Verify error states show friendly message + "Report Issue" link
13. Test credit exhausted state: verify banner appears
