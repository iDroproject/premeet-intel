// PreMeet side panel entry point
// Shows enriched meeting attendees with skeleton loading and progressive data fill.
// Communicates with the background service worker via chrome.runtime messaging.

import type { MeetingEvent, EnrichedAttendee, BackgroundToPopup } from '../types';
import { getCredits, remainingCredits } from '../utils/credits';

const LOG = '[PreMeet][SidePanel]';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const Els = {
  meetingTitle: $('pm-meeting-title'),
  loadingBar:   $('pm-loading-bar'),
  empty:        $('pm-empty'),
  error:        $('pm-error'),
  errorMsg:     $('pm-error-msg'),
  list:         $('pm-list'),
  footer:       $('pm-footer'),
  year:         $('pm-year'),
  credits:      $('pm-credits'),
};

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
}

function setLoading(on: boolean): void {
  Els.loadingBar?.classList.toggle('pm-hidden', !on);
}

// ─── Attendee Render ────────────────────────────────────────────────────────

function renderAttendees(meeting: MeetingEvent, attendees: EnrichedAttendee[]): void {
  if (!Els.list) return;

  if (Els.meetingTitle) {
    Els.meetingTitle.textContent = meeting.title;
    Els.meetingTitle.title = meeting.title;
  }

  Els.list.innerHTML = '';
  const isAnyPending = attendees.some((a) => a.status === 'pending');
  setLoading(isAnyPending);

  if (attendees.length === 0) {
    showView('empty');
    return;
  }

  showView('list');

  attendees.forEach((attendee) => {
    const card = document.createElement('div');
    card.className = `pm-card${attendee.status === 'pending' ? ' pm-card--pending' : ''}`;

    const name = attendee.person?.name || attendee.name;
    const title = attendee.person?.title || '';
    const company = attendee.person?.company?.name || attendee.company || '';
    const email = attendee.email;
    const avi = initials(name || '?');

    card.innerHTML = `
      <div class="pm-avatar">${escapeHtml(avi)}</div>
      <div class="pm-card__body">
        <div class="pm-card__name">${escapeHtml(name)}</div>
        ${title ? `<div class="pm-card__title">${escapeHtml(title)}</div>` : attendee.status === 'pending' ? '<div class="pm-card__title">&nbsp;</div>' : ''}
        ${company ? `<div class="pm-card__company">&#127970; ${escapeHtml(company)}</div>` : attendee.status === 'pending' ? '<div class="pm-card__company">&nbsp;</div>' : ''}
        ${email ? `<div class="pm-card__email">${escapeHtml(email)}</div>` : ''}
      </div>
    `;

    Els.list!.appendChild(card);
  });
}

// ─── Background Message Listener ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'MEETING_UPDATE') {
    const { meeting, attendees } = msg.payload;
    renderAttendees(meeting, attendees);
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
      renderAttendees(response.meeting, response.attendees || []);
    } else {
      showView('empty');
    }
  });
});

console.log(LOG, 'Side panel loaded.');
