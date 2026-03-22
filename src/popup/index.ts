// PreMeet popup entry point
// Renders enriched meeting attendees and feature requests. Communicates with the background SW.

import type { MeetingEvent, EnrichedAttendee, BackgroundToPopup, FeatureRequest } from '../types';
import { getCredits, remainingCredits } from '../utils/credits';
import {
  getFeatureRequests,
  upvoteRequest,
  removeUpvote,
  addFeatureRequest,
} from '../utils/featureRequests';

const LOG = '[PreMeet][Popup]';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const Els = {
  meetingTitle:   $('pm-meeting-title'),
  loadingBar:     $('pm-loading-bar'),
  empty:          $('pm-empty'),
  error:          $('pm-error'),
  errorMsg:       $('pm-error-msg'),
  list:           $('pm-list'),
  footer:         $('pm-footer'),
  year:           $('pm-year'),
  credits:        $('pm-credits'),
  // Tabs
  tabAttendees:   $('pm-tab-attendees'),
  tabFeatures:    $('pm-tab-features'),
  panelAttendees: $('pm-panel-attendees'),
  panelFeatures:  $('pm-panel-features'),
  // Feature requests
  addToggle:      $('pm-add-toggle'),
  addForm:        $('pm-add-form'),
  newTitle:       $<HTMLInputElement>('pm-new-title'),
  newDesc:        $<HTMLTextAreaElement>('pm-new-desc'),
  submitRequest:  $('pm-submit-request'),
  cancelRequest:  $('pm-cancel-request'),
  featureList:    $('pm-feature-list'),
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

// ─── Credits Display ──────────────────────────────────────────────────────────

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

// ─── Tab Management ───────────────────────────────────────────────────────────

type Tab = 'attendees' | 'features';

function switchTab(tab: Tab): void {
  const isAttendees = tab === 'attendees';
  Els.tabAttendees?.classList.toggle('pm-tab--active', isAttendees);
  Els.tabFeatures?.classList.toggle('pm-tab--active', !isAttendees);
  Els.panelAttendees?.classList.toggle('pm-hidden', !isAttendees);
  Els.panelFeatures?.classList.toggle('pm-hidden', isAttendees);

  if (!isAttendees) loadFeatureRequests();
}

// ─── Attendee View Management ─────────────────────────────────────────────────

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

// ─── Attendee Render ──────────────────────────────────────────────────────────

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
        ${company ? `<div class="pm-card__company">&#127970; ${escapeHtml(company)}</div>` : ''}
        ${email ? `<div class="pm-card__email">${escapeHtml(email)}</div>` : ''}
      </div>
    `;

    Els.list!.appendChild(card);
  });
}

// ─── Feature Requests Render ──────────────────────────────────────────────────

function renderFeatureRequests(requests: FeatureRequest[]): void {
  if (!Els.featureList) return;
  Els.featureList.innerHTML = '';

  if (requests.length === 0) {
    Els.featureList.innerHTML = `
      <div class="pm-state">
        <div class="pm-state__icon">&#128161;</div>
        <div class="pm-state__title">No requests yet</div>
        <div class="pm-state__body">Be the first to request a feature!</div>
      </div>`;
    return;
  }

  requests.forEach((req) => {
    const item = document.createElement('div');
    item.className = 'pm-feature-item';
    item.dataset.id = req.id;

    item.innerHTML = `
      <div class="pm-vote">
        <button class="pm-vote__btn${req.upvotedByUser ? ' pm-vote__btn--active' : ''}" data-vote="${escapeHtml(req.id)}" title="${req.upvotedByUser ? 'Remove vote' : 'Upvote'}">&#8679;</button>
        <span class="pm-vote__count">${req.votes}</span>
      </div>
      <div class="pm-feature__body">
        <div class="pm-feature__title">${escapeHtml(req.title)}</div>
        ${req.description ? `<div class="pm-feature__desc">${escapeHtml(req.description)}</div>` : ''}
      </div>
    `;

    Els.featureList!.appendChild(item);
  });
}

async function loadFeatureRequests(): Promise<void> {
  const requests = await getFeatureRequests();
  renderFeatureRequests(requests);
}

// ─── Background Message Listener ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'MEETING_UPDATE') {
    const { meeting, attendees } = msg.payload;
    renderAttendees(meeting, attendees);
    refreshCredits();
  }
});

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function wireEvents(): void {
  // Tab switching
  Els.tabAttendees?.addEventListener('click', () => switchTab('attendees'));
  Els.tabFeatures?.addEventListener('click', () => switchTab('features'));

  // Add feature form toggle
  Els.addToggle?.addEventListener('click', () => {
    Els.addForm?.classList.toggle('pm-hidden');
  });

  Els.cancelRequest?.addEventListener('click', () => {
    Els.addForm?.classList.add('pm-hidden');
    if (Els.newTitle) (Els.newTitle as HTMLInputElement).value = '';
    if (Els.newDesc) (Els.newDesc as HTMLTextAreaElement).value = '';
  });

  Els.submitRequest?.addEventListener('click', async () => {
    const title = (Els.newTitle as HTMLInputElement | null)?.value.trim() ?? '';
    if (!title) return;

    const desc = (Els.newDesc as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const requests = await addFeatureRequest(title, desc);
    renderFeatureRequests(requests);

    Els.addForm?.classList.add('pm-hidden');
    if (Els.newTitle) (Els.newTitle as HTMLInputElement).value = '';
    if (Els.newDesc) (Els.newDesc as HTMLTextAreaElement).value = '';
  });

  // Vote buttons (event delegation)
  Els.featureList?.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-vote]');
    if (!btn) return;
    const id = btn.dataset.vote!;
    const isActive = btn.classList.contains('pm-vote__btn--active');
    const requests = isActive ? await removeUpvote(id) : await upvoteRequest(id);
    renderFeatureRequests(requests);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (Els.year) Els.year.textContent = String(new Date().getFullYear());

  wireEvents();
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

console.log(LOG, 'Popup loaded.');
