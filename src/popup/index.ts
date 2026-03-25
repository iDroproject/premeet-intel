// PreMeet popup entry point
// Renders enriched meeting attendees and feature requests. Communicates with the background SW.

import type { MeetingEvent, EnrichedAttendee, BackgroundToPopup, FeatureRequest, Settings, ActivityLogEntry, DataSourceLabel } from '../types';
import { getCredits, remainingCredits } from '../utils/credits';
import {
  getFeatureRequests,
  upvoteRequest,
  removeUpvote,
  addFeatureRequest,
} from '../utils/featureRequests';
import { getSettings, saveSettings } from '../utils/settings';
import { getActivityLog } from '../utils/activityLog';

const LOG = '[PreMeet][Popup]';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const Els = {
  meetingTitle:   $('pm-meeting-title'),
  loadingBar:     $('pm-loading-bar'),
  empty:          $('pm-empty'),
  error:          $('pm-error'),
  errorMsg:       $('pm-error-msg'),
  noCredits:      $('pm-no-credits'),
  creditsResetDate: $('pm-credits-reset-date'),
  list:           $('pm-list'),
  footer:         $('pm-footer'),
  year:           $('pm-year'),
  credits:        $('pm-credits'),
  // Tabs
  tabAttendees:   $('pm-tab-attendees'),
  tabActivity:    $('pm-tab-activity'),
  tabFeatures:    $('pm-tab-features'),
  panelAttendees: $('pm-panel-attendees'),
  panelActivity:  $('pm-panel-activity'),
  panelFeatures:  $('pm-panel-features'),
  activityList:   $('pm-activity-list'),
  // Feature requests
  addToggle:      $('pm-add-toggle'),
  addForm:        $('pm-add-form'),
  newTitle:       $<HTMLInputElement>('pm-new-title'),
  newDesc:        $<HTMLTextAreaElement>('pm-new-desc'),
  submitRequest:  $('pm-submit-request'),
  cancelRequest:  $('pm-cancel-request'),
  featureList:    $('pm-feature-list'),
  // Settings
  gear:           $('pm-gear'),
  panelSettings:  $('pm-panel-settings'),
  settingsBack:   $('pm-settings-back'),
  setTrigger:     $<HTMLInputElement>('pm-set-trigger'),
  triggerLabel:   $('pm-trigger-label'),
  setCache:       $<HTMLSelectElement>('pm-set-cache'),
  setConfidence:  $<HTMLInputElement>('pm-set-confidence'),
  setCompact:     $<HTMLInputElement>('pm-set-compact'),
  setToken:       $<HTMLInputElement>('pm-set-token'),
  tokenEye:       $('pm-token-eye'),
  saveToken:      $('pm-save-token'),
  tokenFeedback:  $('pm-token-feedback'),
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentAttendees: EnrichedAttendee[] = [];

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

function nextResetLabel(resetMonth: string): string {
  const [y, m] = resetMonth.split('-').map(Number);
  const next = new Date(y, m, 1); // month is 0-indexed, so m (1-indexed) gives next month
  return next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function refreshCredits(): Promise<void> {
  if (!Els.credits) return;
  const credits = await getCredits();
  const remaining = remainingCredits(credits);
  if (credits.plan === 'pro') {
    Els.credits.textContent = 'Pro';
    Els.credits.classList.remove('pm-hidden', 'pm-credits--low', 'pm-credits--warn', 'pm-credits--expandable');
  } else {
    const resetLabel = nextResetLabel(credits.resetMonth);
    const isExhausted = remaining === 0;
    Els.credits.innerHTML = isExhausted
      ? `0/${credits.limit} — Upgrade`
      : `${remaining}/${credits.limit} briefs left<span class="pm-credits__reset">Resets ${escapeHtml(resetLabel)}</span>`;
    Els.credits.classList.remove('pm-hidden');
    Els.credits.classList.toggle('pm-credits--warn', remaining <= 3 && remaining > 1);
    Els.credits.classList.toggle('pm-credits--low', remaining <= 1 || isExhausted);
    Els.credits.classList.toggle('pm-credits--expandable', isExhausted);
    if (isExhausted) {
      Els.credits.title = 'Upgrade to Pro for unlimited briefs';
      Els.credits.onclick = () => window.open('https://premeet.co/pricing', '_blank');
    } else {
      Els.credits.title = '';
      Els.credits.onclick = null;
    }
  }
}

// ─── Tab Management ───────────────────────────────────────────────────────────

type Tab = 'attendees' | 'activity' | 'features';

function switchTab(tab: Tab): void {
  Els.tabAttendees?.classList.toggle('pm-tab--active', tab === 'attendees');
  Els.tabActivity?.classList.toggle('pm-tab--active', tab === 'activity');
  Els.tabFeatures?.classList.toggle('pm-tab--active', tab === 'features');
  Els.panelAttendees?.classList.toggle('pm-hidden', tab !== 'attendees');
  Els.panelActivity?.classList.toggle('pm-hidden', tab !== 'activity');
  Els.panelFeatures?.classList.toggle('pm-hidden', tab !== 'features');

  if (tab === 'features') loadFeatureRequests();
  if (tab === 'activity') loadActivityLog();
}

// ─── Attendee View Management ─────────────────────────────────────────────────

type View = 'empty' | 'list' | 'error' | 'no-credits';

function showView(view: View): void {
  const hidden = 'pm-hidden';
  Els.empty?.classList.toggle(hidden, view !== 'empty');
  Els.list?.classList.toggle(hidden, view !== 'list');
  Els.footer?.classList.toggle(hidden, view !== 'list');
  Els.error?.classList.toggle(hidden, view !== 'error');
  Els.noCredits?.classList.toggle(hidden, view !== 'no-credits');
}

function setLoading(on: boolean): void {
  Els.loadingBar?.classList.toggle('pm-hidden', !on);
}

// ─── Attendee Render ──────────────────────────────────────────────────────────

function renderAttendeeCard(attendee: EnrichedAttendee): HTMLElement {
  const card = document.createElement('div');
  card.className = `pm-card${attendee.status === 'pending' ? ' pm-card--pending' : ''}`;
  card.dataset.email = attendee.email;
  card.style.cursor = 'pointer';

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

  card.addEventListener('click', () => {
    if (attendee.status === 'pending') return; // already enriching

    // Trigger enrichment if not done yet
    if (attendee.status !== 'done') {
      chrome.runtime.sendMessage({ type: 'ENRICH_ATTENDEE', payload: { email: attendee.email } }, () => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, 'ENRICH_ATTENDEE failed:', chrome.runtime.lastError.message);
        }
      });
    }

    // If enriched data is available, send it to the side panel for display
    if (attendee.personData) {
      chrome.runtime.sendMessage({
        type: 'FETCH_PERSON_BACKGROUND',
        payload: {
          name: attendee.person?.name || attendee.name,
          email: attendee.email,
          company: attendee.person?.company?.name || attendee.company || '',
        },
      }, () => { void chrome.runtime.lastError; });
    }

    // Open the side panel
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId != null) {
        chrome.sidePanel.open({ tabId }).catch((err) => {
          console.warn(LOG, 'Could not open side panel:', err);
        });
      }
    });
  });

  return card;
}

function renderAttendees(meeting: MeetingEvent, attendees: EnrichedAttendee[]): void {
  if (!Els.list) return;

  currentAttendees = attendees;

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
    Els.list!.appendChild(renderAttendeeCard(attendee));
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

// ─── Activity Log Render ─────────────────────────────────────────────────────

const SOURCE_ABBREV: Record<DataSourceLabel, string> = {
  'Web Search': 'WS',
  'Profile Lookup': 'PL',
  'Profile Scraper': 'PS',
  'Business Data': 'BD',
  'Cache': 'C',
};

function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  success: { cls: 'pm-badge--success', label: 'OK' },
  partial: { cls: 'pm-badge--partial', label: 'Partial' },
  failed:  { cls: 'pm-badge--failed',  label: 'Failed' },
  cached:  { cls: 'pm-badge--cached',  label: 'Cached' },
};

function renderActivityLog(entries: ActivityLogEntry[]): void {
  if (!Els.activityList) return;
  Els.activityList.innerHTML = '';

  if (entries.length === 0) {
    Els.activityList.innerHTML = `
      <div class="pm-state">
        <div class="pm-state__icon">&#128220;</div>
        <div class="pm-state__title">No activity yet</div>
        <div class="pm-state__body">Enrichment history will appear here after your first meeting brief.</div>
      </div>`;
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'pm-log-item';

    const badge = STATUS_BADGE[entry.status] ?? STATUS_BADGE.failed;
    const sources = entry.dataSources
      .map((s) => `<span class="pm-source-icon" title="${escapeHtml(s)}">${SOURCE_ABBREV[s] ?? '?'}</span>`)
      .join('');

    row.innerHTML = `
      <span class="pm-log__time">${escapeHtml(relativeTime(entry.timestamp))}</span>
      <div class="pm-log__info">
        <div class="pm-log__name">${escapeHtml(entry.attendeeName || entry.attendeeEmail)}</div>
        <div class="pm-log__meeting">${escapeHtml(entry.meetingTitle)}</div>
      </div>
      <div class="pm-log__meta">
        <span class="pm-badge ${badge.cls}">${badge.label}</span>
        <div class="pm-log__sources">${sources}</div>
        <span class="pm-log__credit">${entry.creditsUsed === 0 ? '0cr' : '1cr'}</span>
      </div>
    `;

    Els.activityList!.appendChild(row);
  });
}

async function loadActivityLog(): Promise<void> {
  const entries = await getActivityLog();
  renderActivityLog(entries);
}

// ─── Settings Panel ──────────────────────────────────────────────────────────

function openSettings(): void {
  Els.panelSettings?.classList.remove('pm-hidden');
}

function closeSettings(): void {
  Els.panelSettings?.classList.add('pm-hidden');
}

async function loadSettingsUI(): Promise<void> {
  const s = await getSettings();
  applySettingsToUI(s);
}

function applySettingsToUI(s: Settings): void {
  if (Els.setTrigger) {
    (Els.setTrigger as HTMLInputElement).checked = s.triggerMode === 'manual';
  }
  if (Els.triggerLabel) {
    Els.triggerLabel.textContent = s.triggerMode === 'auto' ? 'Auto' : 'Manual';
  }
  if (Els.setCache) {
    (Els.setCache as HTMLSelectElement).value = s.cacheDuration;
  }
  if (Els.setConfidence) {
    (Els.setConfidence as HTMLInputElement).checked = s.showConfidenceScores;
  }
  if (Els.setCompact) {
    (Els.setCompact as HTMLInputElement).checked = s.compactMode;
  }
  if (Els.setToken) {
    (Els.setToken as HTMLInputElement).value = s.apiToken;
  }
}

function showTokenFeedback(ok: boolean, msg: string): void {
  if (!Els.tokenFeedback) return;
  Els.tokenFeedback.textContent = msg;
  Els.tokenFeedback.className = `pm-token-feedback ${ok ? 'pm-token-feedback--ok' : 'pm-token-feedback--err'}`;
  Els.tokenFeedback.classList.remove('pm-hidden');
  setTimeout(() => Els.tokenFeedback?.classList.add('pm-hidden'), 3000);
}

function wireSettingsEvents(): void {
  Els.gear?.addEventListener('click', () => {
    loadSettingsUI();
    openSettings();
  });

  Els.settingsBack?.addEventListener('click', closeSettings);

  // Trigger mode toggle
  Els.setTrigger?.addEventListener('change', async () => {
    const manual = (Els.setTrigger as HTMLInputElement).checked;
    const mode = manual ? 'manual' : 'auto';
    if (Els.triggerLabel) Els.triggerLabel.textContent = manual ? 'Manual' : 'Auto';
    await saveSettings({ triggerMode: mode });
  });

  // Cache duration
  Els.setCache?.addEventListener('change', async () => {
    const val = (Els.setCache as HTMLSelectElement).value as Settings['cacheDuration'];
    await saveSettings({ cacheDuration: val });
  });

  // Confidence scores
  Els.setConfidence?.addEventListener('change', async () => {
    await saveSettings({ showConfidenceScores: (Els.setConfidence as HTMLInputElement).checked });
  });

  // Compact mode
  Els.setCompact?.addEventListener('change', async () => {
    await saveSettings({ compactMode: (Els.setCompact as HTMLInputElement).checked });
  });

  // Token show/hide
  Els.tokenEye?.addEventListener('click', () => {
    const input = Els.setToken as HTMLInputElement | null;
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Save token
  Els.saveToken?.addEventListener('click', async () => {
    const token = (Els.setToken as HTMLInputElement | null)?.value.trim() ?? '';
    if (!token) {
      showTokenFeedback(false, 'Please enter a token.');
      return;
    }
    await saveSettings({ apiToken: token });
    showTokenFeedback(true, 'Token saved successfully.');
  });
}

// ─── Background Message Listener ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToPopup) => {
  if (msg.type === 'MEETING_UPDATE') {
    const { meeting, attendees } = msg.payload;
    renderAttendees(meeting, attendees);
    refreshCredits();
  }
  if (msg.type === 'ATTENDEE_UPDATE') {
    const { email, attendee } = msg.payload;
    if (!Els.list) return;

    // Update the stored enriched attendees array
    const idx = currentAttendees.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
    if (idx !== -1) {
      currentAttendees[idx] = attendee;
    }

    // Find the existing card and replace it in-place
    const existingCard = Els.list.querySelector<HTMLElement>(`[data-email="${CSS.escape(email)}"]`);
    if (existingCard) {
      const newCard = renderAttendeeCard(attendee);
      existingCard.replaceWith(newCard);
    }

    // Update loading bar
    const isAnyPending = currentAttendees.some((a) => a.status === 'pending');
    setLoading(isAnyPending);
  }
  if (msg.type === 'CREDITS_EXHAUSTED') {
    const { meeting, resetDate } = msg.payload;
    if (Els.meetingTitle) {
      Els.meetingTitle.textContent = meeting.title;
      Els.meetingTitle.title = meeting.title;
    }
    if (Els.creditsResetDate) {
      Els.creditsResetDate.textContent = resetDate;
    }
    setLoading(false);
    showView('no-credits');
    refreshCredits();
  }
});

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function wireEvents(): void {
  // Tab switching
  Els.tabAttendees?.addEventListener('click', () => switchTab('attendees'));
  Els.tabActivity?.addEventListener('click', () => switchTab('activity'));
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
  wireSettingsEvents();
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
