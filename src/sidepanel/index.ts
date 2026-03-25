// PreMeet side panel entry point
// Shows enriched meeting attendees with rich profile cards and progressive data fill.
// Communicates with the background service worker via chrome.runtime messaging.

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, BackgroundToPopup, CustomEnrichmentResult } from '../types';
import type { PersonData, ExperienceEntry, EducationEntry, ConfidenceCitation, CompanyData, ContactInfo } from '../background/enrichment/types';
import { getCredits, remainingCredits } from '../utils/credits';
import { maskPersonData, skillsPreviewCount } from '../utils/masking';
import { initMixpanel, identifyUser, resetUser, track } from '../lib/mixpanel';

const LOG = '[PreMeet][SidePanel]';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const Els = {
  meetingTitle: $('pm-meeting-title'),
  attendeeCount: $('pm-attendee-count'),
  loadingBar:   $('pm-loading-bar'),
  stepper:      $('pm-stepper'),
  counter:      $('pm-counter'),
  empty:        $('pm-empty'),
  error:        $('pm-error'),
  errorMsg:     $('pm-error-msg'),
  list:         $('pm-list'),
  footer:       $('pm-footer'),
  year:         $('pm-year'),
  credits:      $('pm-credits'),
  ctaBanner:    $('pm-cta-banner'),
  ctaSignin:    $('pm-cta-signin'),
};

// ─── State ────────────────────────────────────────────────────────────────────

let currentMeeting: MeetingEvent | null = null;
let attendeeMap = new Map<string, EnrichedAttendee>();
let isAuthenticated = false;

// Track which expandable sections are open per attendee
const expandedSections = new Map<string, Set<string>>();

// Track company intel state per attendee: 'idle' | 'loading' | CompanyData | error string
const companyIntelState = new Map<string, 'idle' | 'loading' | { data: CompanyData } | { error: string }>();

// Track contact info state per attendee: 'idle' | 'loading' | ContactInfo | error string
const contactInfoState = new Map<string, 'idle' | 'loading' | { data: ContactInfo } | { error: string }>();

// Track custom enrichment state per attendee
type CustomEnrichState =
  | 'idle'
  | 'input'
  | { loading: true; prompt: string }
  | { data: CustomEnrichmentResult; prompt: string }
  | { error: string };
const customEnrichState = new Map<string, CustomEnrichState>();

// Suggestion prompts for custom enrichment
const CUSTOM_ENRICH_SUGGESTIONS = [
  'Recent speaking engagements',
  'Published articles or blog posts',
  'Open source contributions',
  'Board memberships',
  'Awards and recognition',
  'Mutual connections',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function attendeeKey(a: { email: string; name: string }): string {
  return (a.email || a.name).toLowerCase();
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Confidence helpers ──────────────────────────────────────────────────────

type ConfidenceColor = 'green' | 'blue' | 'amber' | 'red';

function confidenceColor(score: number): ConfidenceColor {
  if (score >= 90) return 'green';
  if (score >= 70) return 'blue';
  if (score >= 50) return 'amber';
  return 'red';
}

const CONFIDENCE_HEX: Record<ConfidenceColor, string> = {
  green: '#16a34a',
  blue: '#2563eb',
  amber: '#d97706',
  red: '#dc2626',
};

function confidenceTooltipHtml(score: number, citations: ConfidenceCitation[]): string {
  let html = `<strong>${score}% match</strong>`;
  if (citations.length > 0) {
    html += '<br>';
    for (const c of citations) {
      const sign = c.points >= 0 ? '+' : '';
      html += `${escapeHtml(c.factor)}: ${sign}${c.points}<br>`;
    }
  }
  return html;
}

/** Build a 24px SVG circular progress ring */
function confidenceRingSvg(score: number, color: ConfidenceColor): string {
  const size = 24;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const gap = circ - filled;
  const hex = CONFIDENCE_HEX[color];

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
      fill="none" stroke="${hex}" stroke-width="${stroke}"
      stroke-dasharray="${filled} ${gap}"
      stroke-linecap="round"
      transform="rotate(-90 ${size / 2} ${size / 2})" />
  </svg>`;
}

/** Factor weights for the bar chart in the modal */
const FACTOR_WEIGHTS: Record<string, number> = {
  'Email Match': 40,
  'Name Match': 25,
  'Domain Match': 20,
  'Completeness': 15,
};

function openConfidenceModal(pd: PersonData): void {
  const overlay = document.getElementById('pm-confidence-modal');
  const body = document.getElementById('pm-modal-body');
  if (!overlay || !body) return;

  const score = pd._confidenceScore;
  const color = confidenceColor(score);
  const hex = CONFIDENCE_HEX[color];
  const citations = pd._confidenceCitations || [];

  let factorsHtml = '';
  for (const c of citations) {
    const maxPts = FACTOR_WEIGHTS[c.factor] || 40;
    const pct = Math.round((c.points / maxPts) * 100);
    factorsHtml += `
      <div class="pm-modal__factor">
        <span class="pm-modal__factor-name">${escapeHtml(c.factor)}</span>
        <div class="pm-modal__factor-bar">
          <div class="pm-modal__factor-fill" style="width:${pct}%;background:${hex};"></div>
        </div>
        <span class="pm-modal__factor-pts">${c.points}/${maxPts}</span>
      </div>
      <div class="pm-modal__factor-desc">${escapeHtml(c.description)}</div>`;
  }

  body.innerHTML = `
    <div class="pm-modal__title">Confidence Breakdown</div>
    <div class="pm-modal__score">
      <div class="pm-modal__score-value" style="color:${hex}">${score}%</div>
      <div class="pm-modal__score-label">${escapeHtml(pd.name)}</div>
    </div>
    ${factorsHtml}`;

  overlay.classList.add('pm-modal-overlay--open');
}

function closeConfidenceModal(): void {
  document.getElementById('pm-confidence-modal')?.classList.remove('pm-modal-overlay--open');
}

// ─── Auth State ──────────────────────────────────────────────────────────────

async function checkAuthState(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'AUTH_GET_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(false);
        return;
      }
      if (response.isAuthenticated && response.user) {
        identifyUser(response.user);
      }
      resolve(response.isAuthenticated === true);
    });
  });
}

function updateCtaBanner(): void {
  if (!Els.ctaBanner) return;
  Els.ctaBanner.classList.toggle('pm-hidden', isAuthenticated);
}

// ─── Credits Display ────────────────────────────────────────────────────────

async function refreshCredits(): Promise<void> {
  if (!Els.credits) return;
  const credits = await getCredits();
  const remaining = remainingCredits(credits);
  if (credits.plan === 'pro') {
    Els.credits.textContent = 'Pro';
    Els.credits.classList.remove('pm-hidden', 'pm-credits--low');
  } else {
    Els.credits.textContent = `${remaining}/${credits.limit} left`;
    Els.credits.classList.remove('pm-hidden');
    Els.credits.classList.toggle('pm-credits--low', remaining <= 2);
  }
}

// ─── View Management ─────────────────────────────────────────────────────────

type View = 'empty' | 'list' | 'error';

function showView(view: View): void {
  const hidden = 'pm-hidden';
  Els.empty?.classList.toggle(hidden, view !== 'empty');
  Els.list?.classList.toggle(hidden, view !== 'list');
  Els.footer?.classList.toggle(hidden, view !== 'list');
  Els.error?.classList.toggle(hidden, view !== 'error');
  // Stepper visibility is controlled by updateStepper() — hide by default
  Els.stepper?.classList.toggle(hidden, true);
  Els.counter?.classList.toggle(hidden, view !== 'list');
}

function setLoading(on: boolean): void {
  Els.loadingBar?.classList.toggle('pm-hidden', !on);
}

// ─── Progress Stepper ────────────────────────────────────────────────────────

const STAGE_ORDER: EnrichmentStage[] = ['searching', 'fetching', 'complete'];

function updateStepper(): void {
  if (!Els.stepper) return;

  // Hide stepper entirely if no attendee has started enrichment
  const anyEnriching = [...attendeeMap.values()].some((a) => a.status === 'pending' || a.status === 'done' || a.status === 'error');
  Els.stepper.classList.toggle('pm-hidden', !anyEnriching);
  if (!anyEnriching) return;

  let highestIdx = -1;
  let allDone = true;
  for (const a of attendeeMap.values()) {
    if (a.status === 'pending') allDone = false;
    if (a.status === 'idle') continue; // idle attendees don't affect stepper
    const stage = a.stage || (a.status === 'done' ? 'complete' : 'searching');
    const idx = STAGE_ORDER.indexOf(stage);
    if (idx > highestIdx) highestIdx = idx;
    if (a.status !== 'done' && a.status !== 'error') allDone = false;
  }

  const steps = Els.stepper.querySelectorAll<HTMLElement>('.pm-step');
  steps.forEach((step) => {
    const stepName = step.dataset.step as EnrichmentStage;
    const stepIdx = STAGE_ORDER.indexOf(stepName);

    step.classList.remove('pm-step--active', 'pm-step--done');
    if (allDone && stepIdx <= highestIdx) {
      step.classList.add('pm-step--done');
      const dot = step.querySelector('.pm-step__dot');
      if (dot) dot.textContent = '\u2713';
    } else if (stepIdx < highestIdx) {
      step.classList.add('pm-step--done');
      const dot = step.querySelector('.pm-step__dot');
      if (dot) dot.textContent = '\u2713';
    } else if (stepIdx === highestIdx) {
      step.classList.add('pm-step--active');
    }
  });
}

// ─── Attendee Counter ────────────────────────────────────────────────────────

function updateCounter(): void {
  if (!Els.counter) return;
  const total = attendeeMap.size;
  const enriched = [...attendeeMap.values()].filter((a) => a.status === 'done' || a.status === 'error').length;
  const enriching = [...attendeeMap.values()].filter((a) => a.status === 'pending').length;

  if (enriching > 0) {
    Els.counter.textContent = `Fetching\u2026 ${enriched} of ${total} attendees`;
  } else if (enriched > 0) {
    Els.counter.textContent = `${enriched} of ${total} attendee${total !== 1 ? 's' : ''} enriched`;
  } else {
    Els.counter.textContent = `${total} attendee${total !== 1 ? 's' : ''} \u2014 click a card to enrich`;
  }
}

// ─── Avatar Rendering ────────────────────────────────────────────────────────

function renderAvatar(name: string, pd: PersonData | undefined): string {
  if (pd?.avatarUrl) {
    return `<img src="${escapeHtml(pd.avatarUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${escapeHtml(initials(name))}'))">`;
  }
  return escapeHtml(initials(name || '?'));
}

// ─── Confidence Badge ────────────────────────────────────────────────────────

function renderConfidenceBadge(pd: PersonData): string {
  const score = pd._confidenceScore;
  const color = confidenceColor(score);
  const tooltip = confidenceTooltipHtml(score, pd._confidenceCitations || []);
  return `
    <div class="pm-confidence" data-confidence-click title="${score}% match">
      ${confidenceRingSvg(score, color)}
      <div class="pm-confidence__tooltip">${tooltip}</div>
    </div>`;
}

// ─── Company Section ─────────────────────────────────────────────────────────

function renderCompanySection(pd: PersonData): string {
  const companyName = pd.currentCompany;
  if (!companyName) return '';

  const logo = pd.companyLogoUrl
    ? `<img class="pm-company-section__logo" src="${escapeHtml(pd.companyLogoUrl)}" alt="" onerror="this.style.display='none'">`
    : '';
  const industry = pd.companyIndustry ? `<span class="pm-company-section__meta">${escapeHtml(pd.companyIndustry)}</span>` : '';
  const desc = pd.companyDescription
    ? `<div class="pm-company-section__desc">${escapeHtml(pd.companyDescription)}</div>`
    : '';
  const website = pd.companyWebsite
    ? `<a href="${escapeHtml(pd.companyWebsite)}" target="_blank" rel="noopener">${escapeHtml(pd.companyWebsite.replace(/^https?:\/\//, ''))}</a>`
    : '';

  return `
    <div class="pm-company-section pm-fadein">
      <div class="pm-company-section__header">
        ${logo}
        <span class="pm-company-section__name">${escapeHtml(companyName)}</span>
        ${industry}
      </div>
      ${desc}
      ${website}
    </div>`;
}

// ─── Bio ──────────────────────────────────────────────────────────────────────

function renderBio(bio: string, key: string): string {
  const expanded = expandedSections.get(key)?.has('bio');
  const collapseClass = expanded ? '' : ' pm-bio--collapsed';
  const label = expanded ? 'Show less' : 'Show more';
  return `
    <div class="pm-bio${collapseClass} pm-fadein" data-section-bio="${escapeHtml(key)}">${escapeHtml(bio)}</div>
    <button class="pm-bio__toggle" data-toggle-bio="${escapeHtml(key)}">${label}</button>`;
}

// ─── Expandable Sections ──────────────────────────────────────────────────────

function renderExpandableSection(key: string, sectionId: string, label: string, content: string): string {
  const isOpen = expandedSections.get(key)?.has(sectionId);
  const openClass = isOpen ? ' pm-section--open' : '';
  return `
    <div class="pm-section${openClass}" data-section="${escapeHtml(sectionId)}" data-attendee="${escapeHtml(key)}">
      <button class="pm-section__toggle" data-toggle-section="${escapeHtml(sectionId)}" data-attendee="${escapeHtml(key)}">
        ${escapeHtml(label)}
        <span class="pm-section__arrow">\u25BC</span>
      </button>
      <div class="pm-section__content">${content}</div>
    </div>`;
}

function renderWorkHistory(entries: ExperienceEntry[]): string {
  if (entries.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No work history available</div>';
  const items = entries.slice(0, 3).map((e) => {
    const role = e.title ? escapeHtml(e.title) : 'Unknown role';
    const company = e.company ? escapeHtml(e.company) : '';
    const dates = [e.startDate, e.endDate || 'Present'].filter(Boolean).join(' — ');
    return `
      <li class="pm-timeline__item">
        <div class="pm-timeline__role">${role}</div>
        ${company ? `<div class="pm-timeline__company">${company}</div>` : ''}
        ${dates ? `<div class="pm-timeline__dates">${escapeHtml(dates)}</div>` : ''}
      </li>`;
  }).join('');
  return `<ul class="pm-timeline">${items}</ul>`;
}

function renderEducation(entries: EducationEntry[]): string {
  if (entries.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No education data available</div>';
  return entries.map((e) => {
    const school = e.institution ? escapeHtml(e.institution) : 'Unknown institution';
    const degree = [e.degree, e.field].filter(Boolean).join(', ');
    const years = [e.startYear, e.endYear].filter(Boolean).join(' — ');
    return `
      <div class="pm-edu">
        <div class="pm-edu__school">${school}</div>
        ${degree ? `<div class="pm-edu__degree">${escapeHtml(degree)}</div>` : ''}
        ${years ? `<div class="pm-edu__years">${escapeHtml(years)}</div>` : ''}
      </div>`;
  }).join('');
}

function renderSkills(skills: string[]): string {
  if (skills.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No skills data available</div>';
  return `<div class="pm-skills">${skills.map((s) => `<span class="pm-skill-tag">${escapeHtml(s)}</span>`).join('')}</div>`;
}

function renderCompanyIntelFromData(cd: CompanyData): string {
  const rows: string[] = [];

  if (cd.industry) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Industry:</span> ${escapeHtml(cd.industry)}</div>`);
  if (cd.sizeRange) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Size:</span> ${escapeHtml(cd.sizeRange)}</div>`);
  if (cd.foundedYear) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Founded:</span> ${cd.foundedYear}</div>`);
  if (cd.hqAddress) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">HQ:</span> ${escapeHtml(cd.hqAddress)}</div>`);
  if (cd.revenueRange) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Revenue:</span> ${escapeHtml(cd.revenueRange)}</div>`);
  if (cd.website) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Website:</span> <a href="${escapeHtml(cd.website)}" target="_blank" rel="noopener">${escapeHtml(cd.website)}</a></div>`);

  // Funding
  const fundingParts: string[] = [];
  if (cd.fundingTotal) fundingParts.push(`Total: ${escapeHtml(cd.fundingTotal)}`);
  if (cd.fundingLastRound) fundingParts.push(`Last round: ${escapeHtml(cd.fundingLastRound)}`);
  if (fundingParts.length > 0) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Funding:</span> ${fundingParts.join(' · ')}</div>`);
  if (cd.fundingInvestors.length > 0) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Investors:</span> ${cd.fundingInvestors.map(escapeHtml).join(', ')}</div>`);

  // Products & Technologies as tags
  if (cd.products.length > 0) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Products:</span> ${cd.products.map(escapeHtml).join(', ')}</div>`);
  if (cd.technologies.length > 0) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Technologies:</span> <div class="pm-intel__tags">${cd.technologies.map((t) => `<span class="pm-skill-tag">${escapeHtml(t)}</span>`).join('')}</div></div>`);

  // Recent News
  if (cd.recentNews.length > 0) {
    const newsItems = cd.recentNews.slice(0, 5).map((n) => {
      const titleHtml = n.url ? `<a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>` : escapeHtml(n.title);
      const dateHtml = n.date ? ` <span class="pm-intel__date">(${escapeHtml(n.date)})</span>` : '';
      return `<li>${titleHtml}${dateHtml}</li>`;
    }).join('');
    rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Recent News:</span><ul class="pm-intel__news">${newsItems}</ul></div>`);
  }

  // Intent Signals
  if (cd.intentSignals.length > 0) {
    const signalItems = cd.intentSignals.map((s) => {
      return `<li><strong>${escapeHtml(s.signal)}</strong>${s.detail ? ': ' + escapeHtml(s.detail) : ''}</li>`;
    }).join('');
    rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Intent Signals:</span><ul class="pm-intel__signals">${signalItems}</ul></div>`);
  }

  if (rows.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No company intel available</div>';
  return `<div class="pm-intel">${rows.join('')}</div>`;
}

function renderCompanyIntelSection(key: string, pd: PersonData): string {
  const state = companyIntelState.get(key) || 'idle';
  const companyName = pd.currentCompany;
  if (!companyName) return '';

  if (state === 'loading') {
    return renderExpandableSection(key, 'intel', 'Company Intel', `
      <div class="pm-intel-skeleton">
        <div class="pm-skeleton-row pm-skeleton-row--wide"></div>
        <div class="pm-skeleton-row pm-skeleton-row--medium"></div>
        <div class="pm-skeleton-row pm-skeleton-row--wide"></div>
        <div class="pm-skeleton-row pm-skeleton-row--short"></div>
        <div class="pm-skeleton-row pm-skeleton-row--medium"></div>
      </div>
    `);
  }

  if (typeof state === 'object' && 'data' in state) {
    return renderExpandableSection(key, 'intel', 'Company Intel', renderCompanyIntelFromData(state.data));
  }

  if (typeof state === 'object' && 'error' in state) {
    return renderExpandableSection(key, 'intel', 'Company Intel',
      `<div style="font-size:12px;color:#991B1B;">${escapeHtml(state.error)}</div>`);
  }

  // idle — show fetch button
  return `
    <div class="pm-section" data-section="intel" data-attendee="${escapeHtml(key)}">
      <button class="pm-intel-fetch-btn" data-fetch-intel="${escapeHtml(key)}">
        <span class="pm-intel-fetch-btn__icon">🏢</span>
        Company Intel
        <span class="pm-intel-fetch-btn__arrow">→</span>
      </button>
    </div>`;
}

// ─── Contact Info Section ───────────────────────────────────────────────────

function renderContactInfoFromData(ci: ContactInfo): string {
  const rows: string[] = [];
  if (ci.phone) {
    rows.push(`<div class="pm-contact-info__row">
      <span class="pm-contact-info__label">Phone</span>
      <span class="pm-contact-info__value"><a href="tel:${escapeHtml(ci.phone)}">${escapeHtml(ci.phone)}</a></span>
    </div>`);
  }
  if (ci.email) {
    rows.push(`<div class="pm-contact-info__row">
      <span class="pm-contact-info__label">Email</span>
      <span class="pm-contact-info__value"><a href="mailto:${escapeHtml(ci.email)}">${escapeHtml(ci.email)}</a></span>
    </div>`);
  }
  if (rows.length === 0) {
    return '<div style="font-size:12px;color:#9ca3af;">No direct contact info found</div>';
  }
  return `<div class="pm-contact-info">${rows.join('')}</div>`;
}

function renderContactInfoSection(key: string, pd: PersonData): string {
  if (!pd.linkedinUrl) return '';

  const state = contactInfoState.get(key) || 'idle';

  if (state === 'loading') {
    return `
      <div class="pm-section" data-section="contact" data-attendee="${escapeHtml(key)}">
        <div class="pm-intel-skeleton" style="padding:10px 12px;">
          <div class="pm-skeleton-row pm-skeleton-row--medium"></div>
          <div class="pm-skeleton-row pm-skeleton-row--short"></div>
        </div>
      </div>`;
  }

  if (typeof state === 'object' && 'data' in state) {
    return renderExpandableSection(key, 'contact', 'Contact Info', renderContactInfoFromData(state.data));
  }

  if (typeof state === 'object' && 'error' in state) {
    // Show upgrade prompt for Pro-gated errors
    if (state.error.includes('Pro subscription required') || state.error.includes('Pro plan')) {
      return `
        <div class="pm-section" data-section="contact" data-attendee="${escapeHtml(key)}">
          <div style="padding:10px 12px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;font-size:12px;color:#9A3412;line-height:1.5;">
            <strong>Pro feature</strong> — Upgrade to access direct phone and email.
          </div>
        </div>`;
    }
    return renderExpandableSection(key, 'contact', 'Contact Info',
      `<div style="font-size:12px;color:#991B1B;">${escapeHtml(state.error)}</div>`);
  }

  // idle — show fetch button (locked for free users)
  const isLocked = !isAuthenticated;
  const lockedClass = isLocked ? ' pm-contact-btn--locked' : '';
  const lockIcon = isLocked ? '\uD83D\uDD12' : '\uD83D\uDCDE';
  return `
    <div class="pm-section" data-section="contact" data-attendee="${escapeHtml(key)}">
      <button class="pm-contact-btn${lockedClass}" data-fetch-contact="${escapeHtml(key)}">
        <span class="pm-contact-btn__icon">${lockIcon}</span>
        Get Contact Info
        <span class="pm-contact-btn__arrow">\u2192</span>
      </button>
    </div>`;
}

// ─── Custom Enrichment Section ───────────────────────────────────────────────

function renderCustomEnrichResultsContent(data: CustomEnrichmentResult, prompt: string): string {
  if (data.results.length === 0) {
    return `<div style="font-size:12px;color:#9ca3af;">No results found for "${escapeHtml(prompt)}"</div>`;
  }
  const items = data.results.slice(0, 8).map((r) => {
    const titleHtml = r.url
      ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>`
      : escapeHtml(r.title);
    const dateHtml = r.date ? `<div class="pm-custom-results__date">${escapeHtml(r.date)}</div>` : '';
    return `
      <li class="pm-custom-results__item">
        <div class="pm-custom-results__title">${titleHtml}</div>
        ${r.snippet ? `<div class="pm-custom-results__snippet">${escapeHtml(r.snippet)}</div>` : ''}
        ${dateHtml}
      </li>`;
  }).join('');
  return `
    <div class="pm-custom-results__prompt-label">${escapeHtml(prompt)}</div>
    ${data.summary ? `<div class="pm-custom-results__summary">${escapeHtml(data.summary)}</div>` : ''}
    <ul class="pm-custom-results__list">${items}</ul>`;
}

function renderCustomEnrichSection(key: string, pd: PersonData): string {
  if (!pd.linkedinUrl) return '';

  const state = customEnrichState.get(key) || 'idle';

  // Pro-gated: free users see locked button
  const isPro = isAuthenticated; // TODO: check actual subscription tier

  if (typeof state === 'object' && 'loading' in state) {
    return renderExpandableSection(key, 'custom', 'Custom Research', `
      <div class="pm-intel-skeleton">
        <div class="pm-skeleton-row pm-skeleton-row--wide"></div>
        <div class="pm-skeleton-row pm-skeleton-row--medium"></div>
        <div class="pm-skeleton-row pm-skeleton-row--wide"></div>
        <div class="pm-skeleton-row pm-skeleton-row--short"></div>
      </div>
    `);
  }

  if (typeof state === 'object' && 'data' in state) {
    const resultContent = renderCustomEnrichResultsContent(state.data, state.prompt);
    // Also show the form again for follow-up queries
    const formHtml = `
      <div class="pm-custom-enrich__form" style="margin-top:12px;border-top:1px solid var(--pm-border-light);padding-top:8px;">
        <div class="pm-custom-enrich__input-row">
          <textarea class="pm-custom-enrich__input" data-custom-input="${escapeHtml(key)}" placeholder="Ask another question..." rows="1"></textarea>
          <button class="pm-custom-enrich__submit" data-custom-submit="${escapeHtml(key)}">Search</button>
        </div>
        <div class="pm-custom-enrich__cost">2 credits per search</div>
      </div>`;
    return renderExpandableSection(key, 'custom', 'Custom Research',
      `<div class="pm-custom-results">${resultContent}</div>${formHtml}`);
  }

  if (typeof state === 'object' && 'error' in state) {
    if (state.error.includes('Pro subscription required') || state.error.includes('Pro plan')) {
      return `
        <div class="pm-custom-enrich">
          <div class="pm-pro-prompt">
            <strong>Pro feature</strong> — Upgrade to access custom research queries.
          </div>
        </div>`;
    }
    return renderExpandableSection(key, 'custom', 'Custom Research',
      `<div style="font-size:12px;color:#991B1B;">${escapeHtml(state.error)}</div>`);
  }

  if (state === 'input') {
    const suggestionsItems = CUSTOM_ENRICH_SUGGESTIONS.map(
      (s) => `<li class="pm-suggestions__item" data-suggestion="${escapeHtml(s)}" data-suggestion-key="${escapeHtml(key)}">${escapeHtml(s)}</li>`
    ).join('');

    return `
      <div class="pm-custom-enrich">
        <div class="pm-custom-enrich__form">
          <div class="pm-custom-enrich__input-row">
            <textarea class="pm-custom-enrich__input" data-custom-input="${escapeHtml(key)}" placeholder="e.g. Find their recent podcast appearances" rows="1"></textarea>
            <button class="pm-custom-enrich__submit" data-custom-submit="${escapeHtml(key)}">Search</button>
          </div>
          <div class="pm-custom-enrich__cost">2 credits per search</div>
          <div class="pm-suggestions" data-suggestions-key="${escapeHtml(key)}">
            <button class="pm-suggestions__toggle" data-suggestions-toggle="${escapeHtml(key)}">
              Suggestions <span class="pm-suggestions__arrow">&#9660;</span>
            </button>
            <ul class="pm-suggestions__list">${suggestionsItems}</ul>
          </div>
        </div>
      </div>`;
  }

  // idle — show "Enrich" button
  if (!isPro) {
    return `
      <div class="pm-custom-enrich">
        <button class="pm-custom-enrich__btn pm-custom-enrich__btn--locked" data-custom-enrich-locked="${escapeHtml(key)}">
          <span class="pm-custom-enrich__icon">&#128274;</span>
          Custom Research
          <span class="pm-custom-enrich__arrow">&#8594;</span>
        </button>
      </div>`;
  }

  return `
    <div class="pm-custom-enrich">
      <button class="pm-custom-enrich__btn" data-custom-enrich="${escapeHtml(key)}">
        <span class="pm-custom-enrich__icon">&#128269;</span>
        Custom Research
        <span class="pm-custom-enrich__arrow">&#8594;</span>
      </button>
    </div>`;
}

function renderRecentPosts(pd: PersonData): string {
  if (!pd.recentPosts || pd.recentPosts.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No recent posts</div>';
  return pd.recentPosts.map((p) => {
    const title = p.title || 'Untitled post';
    const titleHtml = p.link
      ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);
    const interaction = p.interaction ? `<div class="pm-post__interaction">${escapeHtml(p.interaction)}</div>` : '';
    return `<div class="pm-post"><div class="pm-post__title">${titleHtml}</div>${interaction}</div>`;
  }).join('');
}

// ─── Card Rendering ──────────────────────────────────────────────────────────

function createCardElement(attendee: EnrichedAttendee): HTMLElement {
  const card = document.createElement('div');
  const key = attendeeKey(attendee);
  card.dataset.attendeeKey = key;
  updateCardContent(card, attendee);
  return card;
}

function updateCardContent(card: HTMLElement, attendee: EnrichedAttendee): void {
  const isIdle = attendee.status === 'idle';
  const isPending = attendee.status === 'pending';
  const isDone = attendee.status === 'done';
  const isPreview = !isAuthenticated && !!attendee.personData;
  const pd = isPreview && attendee.personData ? maskPersonData(attendee.personData) : attendee.personData;
  const originalPd = attendee.personData; // keep ref for skill count in preview
  const name = pd?.name || attendee.person?.name || attendee.name;
  const title = pd?.currentTitle || attendee.person?.title || '';
  const company = pd?.currentCompany || attendee.person?.company?.name || attendee.company || '';
  const email = attendee.email;
  const key = attendeeKey(attendee);
  const hasRichData = !!pd;

  // Build class list
  const isError = attendee.status === 'error';
  const classes = ['pm-card'];
  if (isIdle || isError) classes.push('pm-card--idle');
  if (isPending) classes.push('pm-card--pending');
  if (attendee.fromCache) classes.push('pm-card--cache-hit');
  if (attendee.hasLinkedIn && !isDone) classes.push('pm-card--usable');
  if (isDone && !attendee.error) classes.push('pm-card--complete');
  if (isPreview) classes.push('pm-locked-overlay');

  card.className = classes.join(' ');

  const fadeClass = !isPending ? ' pm-fadein' : '';

  // ── Build the always-visible header ──
  const linkedinUrl = pd?.linkedinUrl;
  const nameHtml = linkedinUrl
    ? `<a href="${escapeHtml(linkedinUrl)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
    : escapeHtml(name);

  const location = pd?.location;
  const locationHtml = location ? `<div class="pm-card__location${fadeClass}">${escapeHtml(location)}</div>` : '';

  // Quick stats
  let statsHtml = '';
  if (hasRichData && (pd.connections != null || pd.followers != null)) {
    const parts: string[] = [];
    if (pd.connections != null) parts.push(`<span class="pm-card__stat"><strong>${formatNumber(pd.connections)}</strong> connections</span>`);
    if (pd.followers != null) parts.push(`<span class="pm-card__stat"><strong>${formatNumber(pd.followers)}</strong> followers</span>`);
    statsHtml = `<div class="pm-card__stats${fadeClass}">${parts.join('')}</div>`;
  }

  // Confidence badge
  let confidenceHtml = '';
  let confidenceWarning = '';
  if (hasRichData && pd._confidenceScore != null) {
    confidenceHtml = renderConfidenceBadge(pd);
    if (pd._confidenceScore < 50) {
      confidenceWarning = '<div class="pm-confidence__warning">This profile may not be the right person. Verify before using.</div>';
    }
  }

  // ── Build rich sections (only when data available and not pending) ──
  let companySectionHtml = '';
  let bioHtml = '';
  let expandableSectionsHtml = '';

  if (hasRichData && !isPending) {
    companySectionHtml = renderCompanySection(pd);

    if (pd.bio) {
      bioHtml = renderBio(pd.bio, key);
    }

    // Expandable sections
    const sections: string[] = [];
    if (pd.experience && pd.experience.length > 0) {
      sections.push(renderExpandableSection(key, 'work', 'Work History', renderWorkHistory(pd.experience)));
    }
    if (pd.education && pd.education.length > 0) {
      sections.push(renderExpandableSection(key, 'education', 'Education', renderEducation(pd.education)));
    }
    if (isPreview && originalPd && originalPd.skills && originalPd.skills.length > 0) {
      const count = skillsPreviewCount(originalPd);
      sections.push(renderExpandableSection(key, 'skills', 'Skills', `<div class="pm-skills-preview">${count} skills &mdash; sign in to view</div>`));
    } else if (pd.skills && pd.skills.length > 0) {
      sections.push(renderExpandableSection(key, 'skills', 'Skills', renderSkills(pd.skills)));
    }
    if (pd.currentCompany) {
      sections.push(renderCompanyIntelSection(key, pd));
    }
    if (pd.linkedinUrl) {
      sections.push(renderContactInfoSection(key, pd));
    }
    if (pd.linkedinUrl) {
      sections.push(renderCustomEnrichSection(key, pd));
    }
    if (pd.recentPosts && pd.recentPosts.length > 0) {
      sections.push(renderExpandableSection(key, 'posts', 'Recent Posts', renderRecentPosts(pd)));
    }
    expandableSectionsHtml = sections.join('');
  }

  // ── Skeleton placeholders for pending state ──
  const titleHtml = title
    ? `<div class="pm-card__title${fadeClass}">${escapeHtml(title)}</div>`
    : isPending ? '<div class="pm-card__title">&nbsp;</div>' : '';
  const companyHtml = company
    ? `<div class="pm-card__company${fadeClass}">\uD83C\uDFE2 ${escapeHtml(company)}</div>`
    : isPending ? '<div class="pm-card__company">&nbsp;</div>' : '';

  // Error message for failed enrichment
  const errorHtml = attendee.status === 'error' && attendee.error
    ? `<div style="margin-top:8px;padding:8px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;font-size:12px;color:#991B1B;line-height:1.5;">${escapeHtml(attendee.error)}</div>`
    : '';

  card.innerHTML = `
    <div class="pm-card__header">
      <div class="pm-avatar">${renderAvatar(name, pd)}</div>
      <div class="pm-card__body">
        <div class="pm-card__name${fadeClass}">${nameHtml}</div>
        ${titleHtml}
        ${companyHtml}
        ${locationHtml}
        ${email ? `<div class="pm-card__email">${escapeHtml(email)}</div>` : ''}
        ${statsHtml}
        ${confidenceWarning}
      </div>
      ${confidenceHtml}
    </div>
    ${errorHtml}
    ${companySectionHtml}
    ${bioHtml}
    ${expandableSectionsHtml}
  `;

  // Attach event listeners for interactive elements
  attachCardListeners(card, key);
}

// ─── Event Delegation for Card Interactions ──────────────────────────────────

function attachCardListeners(card: HTMLElement, key: string): void {
  // Click-to-enrich: clicking the card header triggers enrichment for idle attendees
  const header = card.querySelector<HTMLElement>('.pm-card__header');
  if (header) {
    header.addEventListener('click', (e) => {
      // Don't trigger enrichment if clicking a link or the confidence badge
      const target = e.target as HTMLElement;
      if (target.closest('a') || target.closest('[data-confidence-click]')) return;

      const attendee = attendeeMap.get(key);
      if (!attendee || (attendee.status !== 'idle' && attendee.status !== 'error')) return;

      // Reset error state to idle before retrying
      if (attendee.status === 'error') {
        attendee.status = 'idle';
        attendee.error = undefined;
        attendeeMap.set(key, attendee);
      }

      chrome.runtime.sendMessage({ type: 'ENRICH_ATTENDEE', payload: { email: attendee.email } });
    });
  }

  // Confidence ring click → open modal
  const confBadge = card.querySelector<HTMLElement>('[data-confidence-click]');
  if (confBadge) {
    confBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const attendee = attendeeMap.get(key);
      if (attendee?.personData) openConfidenceModal(attendee.personData);
    });
  }

  // Bio toggle
  const bioToggle = card.querySelector<HTMLButtonElement>(`[data-toggle-bio="${CSS.escape(key)}"]`);
  if (bioToggle) {
    bioToggle.addEventListener('click', () => {
      const sections = expandedSections.get(key) || new Set();
      if (sections.has('bio')) {
        sections.delete('bio');
      } else {
        sections.add('bio');
      }
      expandedSections.set(key, sections);

      const bioEl = card.querySelector<HTMLElement>(`[data-section-bio="${CSS.escape(key)}"]`);
      if (bioEl) {
        bioEl.classList.toggle('pm-bio--collapsed');
        bioToggle.textContent = sections.has('bio') ? 'Show less' : 'Show more';
      }
    });
  }

  // Company Intel fetch button
  const intelBtn = card.querySelector<HTMLButtonElement>(`[data-fetch-intel="${CSS.escape(key)}"]`);
  if (intelBtn) {
    intelBtn.addEventListener('click', () => {
      const attendee = attendeeMap.get(key);
      if (!attendee?.personData?.currentCompany) return;
      const pd = attendee.personData;

      companyIntelState.set(key, 'loading');
      // Auto-expand the intel section
      const sections = expandedSections.get(key) || new Set();
      sections.add('intel');
      expandedSections.set(key, sections);
      // Re-render card to show skeleton
      updateCardContent(card, attendee);

      track('company_intel_requested');
      chrome.runtime.sendMessage({
        type: 'FETCH_COMPANY_INTEL',
        payload: {
          email: attendee.email,
          companyName: pd.currentCompany!,
          linkedinUrl: pd.companyLinkedinUrl || undefined,
          website: pd.companyWebsite || undefined,
        },
      });
    });
  }

  // Contact Info fetch button
  const contactBtn = card.querySelector<HTMLButtonElement>(`[data-fetch-contact="${CSS.escape(key)}"]`);
  if (contactBtn) {
    contactBtn.addEventListener('click', () => {
      const attendee = attendeeMap.get(key);
      if (!attendee?.personData?.linkedinUrl) return;
      const pd = attendee.personData;

      contactInfoState.set(key, 'loading');
      // Re-render card to show skeleton
      updateCardContent(card, attendee);

      track('contact_info_requested');
      chrome.runtime.sendMessage({
        type: 'FETCH_CONTACT_INFO',
        payload: {
          email: attendee.email,
          linkedinUrl: pd.linkedinUrl!,
          fullName: pd.name,
          companyName: pd.currentCompany || undefined,
        },
      });
    });
  }

  // Custom Enrichment: open input button
  const customEnrichBtn = card.querySelector<HTMLButtonElement>(`[data-custom-enrich="${CSS.escape(key)}"]`);
  if (customEnrichBtn) {
    customEnrichBtn.addEventListener('click', () => {
      customEnrichState.set(key, 'input');
      const attendee = attendeeMap.get(key);
      if (attendee) updateCardContent(card, attendee);
    });
  }

  // Custom Enrichment: locked button (show Pro upgrade prompt)
  const customLockedBtn = card.querySelector<HTMLButtonElement>(`[data-custom-enrich-locked="${CSS.escape(key)}"]`);
  if (customLockedBtn) {
    customLockedBtn.addEventListener('click', () => {
      track('upgrade_prompt_shown', { feature: 'custom_enrichment' });
      customEnrichState.set(key, { error: 'Pro subscription required' });
      const attendee = attendeeMap.get(key);
      if (attendee) updateCardContent(card, attendee);
    });
  }

  // Custom Enrichment: submit button
  const customSubmitBtn = card.querySelector<HTMLButtonElement>(`[data-custom-submit="${CSS.escape(key)}"]`);
  const customInput = card.querySelector<HTMLTextAreaElement>(`[data-custom-input="${CSS.escape(key)}"]`);
  if (customSubmitBtn && customInput) {
    const submitCustom = () => {
      const prompt = customInput.value.trim();
      if (!prompt) return;
      const attendee = attendeeMap.get(key);
      if (!attendee?.personData?.linkedinUrl) return;
      const pd = attendee.personData;

      // Store prompt so we can recover it when result arrives
      customEnrichState.set(key, { loading: true, prompt });
      const sections = expandedSections.get(key) || new Set();
      sections.add('custom');
      expandedSections.set(key, sections);
      updateCardContent(card, attendee);

      track('custom_enrichment_requested', { prompt_length: prompt.length });
      chrome.runtime.sendMessage({
        type: 'CUSTOM_ENRICHMENT',
        payload: {
          email: attendee.email,
          linkedinUrl: pd.linkedinUrl!,
          fullName: pd.name,
          prompt,
        },
      });
    };

    customSubmitBtn.addEventListener('click', submitCustom);
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitCustom();
      }
    });
  }

  // Custom Enrichment: suggestions toggle
  const suggestionsToggle = card.querySelector<HTMLButtonElement>(`[data-suggestions-toggle="${CSS.escape(key)}"]`);
  if (suggestionsToggle) {
    suggestionsToggle.addEventListener('click', () => {
      const suggestionsContainer = card.querySelector<HTMLElement>(`[data-suggestions-key="${CSS.escape(key)}"]`);
      suggestionsContainer?.classList.toggle('pm-suggestions--open');
    });
  }

  // Custom Enrichment: suggestion items
  const suggestionItems = card.querySelectorAll<HTMLElement>(`[data-suggestion-key="${CSS.escape(key)}"]`);
  suggestionItems.forEach((item) => {
    item.addEventListener('click', () => {
      const suggestion = item.dataset.suggestion;
      if (!suggestion) return;
      const input = card.querySelector<HTMLTextAreaElement>(`[data-custom-input="${CSS.escape(key)}"]`);
      if (input) {
        input.value = suggestion;
        input.focus();
      }
      // Close suggestions dropdown
      const suggestionsContainer = card.querySelector<HTMLElement>(`[data-suggestions-key="${CSS.escape(key)}"]`);
      suggestionsContainer?.classList.remove('pm-suggestions--open');
    });
  });

  // Section toggles
  const sectionToggles = card.querySelectorAll<HTMLButtonElement>('[data-toggle-section]');
  sectionToggles.forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const sectionId = toggle.dataset.toggleSection!;
      const sections = expandedSections.get(key) || new Set();
      if (sections.has(sectionId)) {
        sections.delete(sectionId);
      } else {
        sections.add(sectionId);
      }
      expandedSections.set(key, sections);

      const sectionEl = toggle.closest('.pm-section');
      if (sectionEl) {
        sectionEl.classList.toggle('pm-section--open');
      }
    });
  });
}

// ─── Full Render (initial load) ──────────────────────────────────────────────

function renderAllAttendees(meeting: MeetingEvent, attendees: EnrichedAttendee[]): void {
  currentMeeting = meeting;
  attendeeMap.clear();

  if (Els.meetingTitle) {
    Els.meetingTitle.textContent = meeting.title;
    Els.meetingTitle.title = meeting.title;
  }

  if (Els.attendeeCount) {
    Els.attendeeCount.textContent = `${attendees.length} attendee${attendees.length !== 1 ? 's' : ''}`;
  }

  if (attendees.length === 0) {
    showView('empty');
    setLoading(false);
    return;
  }

  showView('list');
  if (!Els.list) return;

  Els.list.innerHTML = '';
  setLoading(false);

  for (const attendee of attendees) {
    const key = attendeeKey(attendee);
    attendeeMap.set(key, attendee);
    Els.list.appendChild(createCardElement(attendee));
  }

  updateStepper();
  updateCounter();
}

// ─── Per-Attendee Update (progressive fill) ──────────────────────────────────

function updateSingleAttendee(email: string, attendee: EnrichedAttendee): void {
  const key = (email || attendee.name).toLowerCase();
  attendeeMap.set(key, attendee);

  if (!Els.list) return;

  const existingCard = Els.list.querySelector<HTMLElement>(`[data-attendee-key="${CSS.escape(key)}"]`);
  if (existingCard) {
    updateCardContent(existingCard, attendee);
  } else {
    Els.list.appendChild(createCardElement(attendee));
  }

  const isAnyPending = [...attendeeMap.values()].some((a) => a.status === 'pending');
  setLoading(isAnyPending);

  updateStepper();
  updateCounter();
}

// ─── Background Message Listener ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'MEETING_UPDATE') {
    const { meeting, attendees } = msg.payload;
    track('meeting_detected', { attendee_count: attendees.length });
    renderAllAttendees(meeting, attendees);
    refreshCredits();
  }

  if (msg.type === 'ATTENDEE_UPDATE') {
    const { email, attendee } = msg.payload;
    if (attendee.status === 'done' && attendee.personData) {
      track('brief_completed', {
        from_cache: attendee.fromCache ?? false,
        has_linkedin: !!attendee.hasLinkedIn,
      });
    }
    updateSingleAttendee(email, attendee);
    refreshCredits();
  }

  if (msg.type === 'COMPANY_INTEL_RESULT') {
    const payload = msg.payload as { email: string; data?: CompanyData; cached?: boolean; error?: string };
    const key = payload.email.toLowerCase();
    if ('error' in payload && payload.error) {
      companyIntelState.set(key, { error: payload.error });
      track('company_intel_completed', { success: false });
    } else if (payload.data) {
      companyIntelState.set(key, { data: payload.data });
      track('company_intel_completed', { success: true, cached: payload.cached ?? false });
    }
    // Re-render the card to show results
    const attendee = attendeeMap.get(key);
    if (attendee && Els.list) {
      const existingCard = Els.list.querySelector<HTMLElement>(`[data-attendee-key="${CSS.escape(key)}"]`);
      if (existingCard) {
        // Auto-expand intel section
        const sections = expandedSections.get(key) || new Set();
        sections.add('intel');
        expandedSections.set(key, sections);
        updateCardContent(existingCard, attendee);
      }
    }
    refreshCredits();
  }

  if (msg.type === 'CONTACT_INFO_RESULT') {
    const payload = msg.payload as { email: string; data?: ContactInfo; cached?: boolean; error?: string };
    const key = payload.email.toLowerCase();
    if ('error' in payload && payload.error) {
      contactInfoState.set(key, { error: payload.error });
      track('contact_info_completed', { success: false });
    } else if (payload.data) {
      contactInfoState.set(key, { data: payload.data });
      track('contact_info_completed', { success: true, cached: payload.cached ?? false });
    }
    // Re-render the card to show results
    const attendee = attendeeMap.get(key);
    if (attendee && Els.list) {
      const existingCard = Els.list.querySelector<HTMLElement>(`[data-attendee-key="${CSS.escape(key)}"]`);
      if (existingCard) {
        // Auto-expand contact section
        const sections = expandedSections.get(key) || new Set();
        sections.add('contact');
        expandedSections.set(key, sections);
        updateCardContent(existingCard, attendee);
      }
    }
    refreshCredits();
  }

  if (msg.type === 'CUSTOM_ENRICHMENT_RESULT') {
    const payload = msg.payload as { email: string; data?: CustomEnrichmentResult; cached?: boolean; error?: string; prompt?: string };
    const key = payload.email.toLowerCase();
    if ('error' in payload && payload.error) {
      customEnrichState.set(key, { error: payload.error });
      track('custom_enrichment_completed', { success: false });
    } else if (payload.data) {
      track('custom_enrichment_completed', { success: true, cached: payload.cached ?? false });
      // Recover the prompt from the loading state or use a fallback
      const prevState = customEnrichState.get(key);
      const prompt = (prevState && typeof prevState === 'object' && 'prompt' in prevState && typeof prevState.prompt === 'string') ? prevState.prompt : 'Custom search';
      customEnrichState.set(key, { data: payload.data, prompt });
    }
    // Re-render the card to show results
    const attendee = attendeeMap.get(key);
    if (attendee && Els.list) {
      const existingCard = Els.list.querySelector<HTMLElement>(`[data-attendee-key="${CSS.escape(key)}"]`);
      if (existingCard) {
        const sections = expandedSections.get(key) || new Set();
        sections.add('custom');
        expandedSections.set(key, sections);
        updateCardContent(existingCard, attendee);
      }
    }
    refreshCredits();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (Els.year) Els.year.textContent = String(new Date().getFullYear());

  initMixpanel();

  // Check auth state for freemium preview mode
  isAuthenticated = await checkAuthState();
  updateCtaBanner();

  track('sidepanel_opened');

  // CTA sign-in button
  Els.ctaSignin?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AUTH_SIGN_IN' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG, 'Sign-in failed:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        isAuthenticated = true;
        if (response.user) {
          identifyUser(response.user);
          track('Sign In', { login_method: 'google' });
        }
        updateCtaBanner();
        // Re-render all attendees with full data
        if (currentMeeting) {
          const attendees = [...attendeeMap.values()];
          renderAllAttendees(currentMeeting, attendees);
        }
        refreshCredits();
      }
    });
  });

  // Modal close handlers
  document.getElementById('pm-modal-close')?.addEventListener('click', closeConfidenceModal);
  document.getElementById('pm-confidence-modal')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('pm-modal-overlay')) closeConfidenceModal();
  });

  refreshCredits();

  // Ask the background SW for the current meeting
  chrome.runtime.sendMessage({ type: 'GET_CURRENT_MEETING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG, 'Could not reach background SW:', chrome.runtime.lastError.message);
      showView('empty');
      return;
    }
    if (response?.ok && response.meeting) {
      renderAllAttendees(response.meeting, response.attendees || []);
    } else {
      showView('empty');
    }
  });
});

console.log(LOG, 'Side panel loaded.');
