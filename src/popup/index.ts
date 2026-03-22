// PreMeet popup entry point
// Renders enriched meeting attendees. Communicates with the background SW.

import type { MeetingEvent, EnrichedAttendee, BackgroundToPopup } from '../types';

const LOG = '[PreMeet][Popup]';

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

// ─── Render ───────────────────────────────────────────────────────────────────

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
        ${title ? `<div class="pm-card__title">${escapeHtml(title)}</div>` : ''}
        ${company ? `<div class="pm-card__company">🏢 ${escapeHtml(company)}</div>` : ''}
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
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (Els.year) Els.year.textContent = String(new Date().getFullYear());

  // Ask the background SW for the current meeting (handles popup opened after detection)
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

console.log(LOG, 'Popup loaded.');
