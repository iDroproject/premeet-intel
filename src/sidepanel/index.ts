// PreMeet side panel entry point
// Shows enriched meeting attendees with skeleton loading and progressive data fill.
// Communicates with the background service worker via chrome.runtime messaging.

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, BackgroundToPopup } from '../types';
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
  Els.stepper?.classList.toggle(hidden, view !== 'list');
  Els.counter?.classList.toggle(hidden, view !== 'list');
}

function setLoading(on: boolean): void {
  Els.loadingBar?.classList.toggle('pm-hidden', !on);
}

// ─── Progress Stepper ────────────────────────────────────────────────────────

const STAGE_ORDER: EnrichmentStage[] = ['searching', 'resolving', 'enriching', 'complete'];

function updateStepper(): void {
  if (!Els.stepper) return;

  // Determine the highest stage across all attendees
  let highestIdx = -1;
  let allDone = true;
  for (const a of attendeeMap.values()) {
    if (a.status === 'pending') allDone = false;
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
  const done = [...attendeeMap.values()].filter((a) => a.status === 'done' || a.status === 'error').length;
  const pending = total - done;

  if (pending > 0) {
    Els.counter.textContent = `Enriching ${done} of ${total} attendees\u2026`;
  } else {
    Els.counter.textContent = `${total} attendee${total !== 1 ? 's' : ''} enriched`;
  }
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
  const isPending = attendee.status === 'pending';
  const isDone = attendee.status === 'done';
  const name = attendee.person?.name || attendee.name;
  const title = attendee.person?.title || '';
  const company = attendee.person?.company?.name || attendee.company || '';
  const email = attendee.email;
  const avi = initials(name || '?');

  // Build class list
  const classes = ['pm-card'];
  if (isPending) classes.push('pm-card--pending');
  if (attendee.fromCache) classes.push('pm-card--cache-hit');
  if (attendee.hasLinkedIn && !isDone) classes.push('pm-card--usable');
  if (isDone && !attendee.error) classes.push('pm-card--complete');

  card.className = classes.join(' ');

  const fadeClass = !isPending ? ' pm-fadein' : '';

  card.innerHTML = `
    <div class="pm-avatar">${escapeHtml(avi)}</div>
    <div class="pm-card__body">
      <div class="pm-card__name${fadeClass}">${escapeHtml(name)}</div>
      ${title ? `<div class="pm-card__title${fadeClass}">${escapeHtml(title)}</div>` : isPending ? '<div class="pm-card__title">&nbsp;</div>' : ''}
      ${company ? `<div class="pm-card__company${fadeClass}">${'\uD83C\uDFE2'} ${escapeHtml(company)}</div>` : isPending ? '<div class="pm-card__company">&nbsp;</div>' : ''}
      ${email ? `<div class="pm-card__email">${escapeHtml(email)}</div>` : ''}
    </div>
  `;
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
  const isAnyPending = attendees.some((a) => a.status === 'pending');
  setLoading(isAnyPending);

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

  // Update loading state
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
