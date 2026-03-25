// PreMeet side panel entry point
// Shows enriched meeting attendees with rich profile cards and progressive data fill.
// Communicates with the background service worker via chrome.runtime messaging.

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, BackgroundToPopup } from '../types';
import type { PersonData, ExperienceEntry, EducationEntry, ConfidenceCitation } from '../background/enrichment/types';
import { getCredits, remainingCredits } from '../utils/credits';

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
};

// ─── State ────────────────────────────────────────────────────────────────────

let currentMeeting: MeetingEvent | null = null;
let attendeeMap = new Map<string, EnrichedAttendee>();

// Track which expandable sections are open per attendee
const expandedSections = new Map<string, Set<string>>();

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

const STAGE_ORDER: EnrichmentStage[] = ['searching', 'resolving', 'enriching', 'complete'];

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
    Els.counter.textContent = `Enriching\u2026 ${enriched} of ${total} attendees`;
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

function renderCompanyIntel(pd: PersonData): string {
  const rows: string[] = [];
  if (pd.companySize) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Size:</span> ${escapeHtml(pd.companySize)}</div>`);
  if (pd.companyFounded) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Founded:</span> ${escapeHtml(pd.companyFounded)}</div>`);
  if (pd.companyHeadquarters) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">HQ:</span> ${escapeHtml(pd.companyHeadquarters)}</div>`);
  if (pd.companyRevenue) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Revenue:</span> ${escapeHtml(pd.companyRevenue)}</div>`);
  if (pd.companyFunding) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Funding:</span> ${escapeHtml(pd.companyFunding)}</div>`);
  if (pd.companyProducts) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Products:</span> ${escapeHtml(pd.companyProducts)}</div>`);
  if (pd.companyTechnologies) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Technologies:</span> ${escapeHtml(pd.companyTechnologies)}</div>`);
  if (pd.recentNews) rows.push(`<div class="pm-intel__row"><span class="pm-intel__label">Recent News:</span> ${escapeHtml(pd.recentNews)}</div>`);
  if (rows.length === 0) return '<div style="font-size:12px;color:#9ca3af;">No company intel available</div>';
  return `<div class="pm-intel">${rows.join('')}</div>`;
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
  const pd = attendee.personData;
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
    if (pd.skills && pd.skills.length > 0) {
      sections.push(renderExpandableSection(key, 'skills', 'Skills', renderSkills(pd.skills)));
    }
    if (pd.companyIndustry || pd.companySize || pd.companyFounded || pd.recentNews || pd.companyProducts || pd.companyTechnologies) {
      sections.push(renderExpandableSection(key, 'intel', 'Company Intel', renderCompanyIntel(pd)));
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
    renderAllAttendees(meeting, attendees);
    refreshCredits();
  }

  if (msg.type === 'ATTENDEE_UPDATE') {
    const { email, attendee } = msg.payload;
    updateSingleAttendee(email, attendee);
    refreshCredits();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (Els.year) Els.year.textContent = String(new Date().getFullYear());

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
