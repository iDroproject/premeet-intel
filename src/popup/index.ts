// PreMeet popup entry point
// Renders enriched meeting attendees and feature requests. Communicates with the background SW.

import type { MeetingEvent, EnrichedAttendee, BackgroundToPopup, FeatureRequest, Settings, ActivityLogEntry, DataSourceLabel } from '../types';
import { getCredits, remainingCredits } from '../utils/credits';
import { maskTitle } from '../utils/masking';
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
  planBadge:      $('pm-plan-badge'),
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
  setAutoSearch:  $<HTMLInputElement>('pm-set-auto-search'),
  ctaBanner:      $('pm-cta-banner'),
  ctaSignin:      $('pm-cta-signin'),
  // Auth UI
  headerSignin:   $('pm-header-signin'),
  headerUser:     $('pm-header-user'),
  headerUserAvatar: $('pm-header-user-avatar'),
  authSigninSection: $('pm-auth-signin-section'),
  authUserSection: $('pm-auth-user-section'),
  authSigninBtn:  $('pm-auth-signin-btn'),
  authSignoutBtn: $('pm-auth-signout-btn'),
  authAvatar:     $('pm-auth-avatar'),
  authName:       $('pm-auth-name'),
  authEmail:      $('pm-auth-email'),
  authError:      $('pm-auth-error'),
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentAttendees: EnrichedAttendee[] = [];
let currentMeeting: MeetingEvent | null = null;
let isAuthenticated = false;

interface AuthUserInfo {
  email: string;
  name: string | null;
}
let currentUser: AuthUserInfo | null = null;

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

// ─── Auth State ──────────────────────────────────────────────────────────────

async function checkAuthState(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'AUTH_GET_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(false);
        return;
      }
      if (response.isAuthenticated && response.user) {
        currentUser = { email: response.user.email, name: response.user.name };
      }
      resolve(response.isAuthenticated === true);
    });
  });
}

function updateAuthUI(): void {
  const hidden = 'pm-hidden';

  // Header controls
  Els.headerSignin?.classList.toggle(hidden, isAuthenticated);
  Els.headerUser?.classList.toggle(hidden, !isAuthenticated);

  if (isAuthenticated && currentUser) {
    const avi = initials(currentUser.name || currentUser.email);
    if (Els.headerUserAvatar) Els.headerUserAvatar.textContent = avi;

    // Settings panel
    if (Els.authAvatar) Els.authAvatar.textContent = avi;
    if (Els.authName) Els.authName.textContent = currentUser.name || 'PreMeet User';
    if (Els.authEmail) Els.authEmail.textContent = currentUser.email;
  }

  Els.authSigninSection?.classList.toggle(hidden, isAuthenticated);
  Els.authUserSection?.classList.toggle(hidden, !isAuthenticated);
  Els.authError?.classList.add(hidden);
}

async function handleSignIn(): Promise<void> {
  Els.authError?.classList.add('pm-hidden');

  // Disable buttons during sign-in
  const btns = [Els.headerSignin, Els.authSigninBtn, Els.ctaSignin].filter(Boolean) as HTMLButtonElement[];
  btns.forEach((b) => { b.disabled = true; });

  return new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: 'AUTH_SIGN_IN' }, (response) => {
      btns.forEach((b) => { b.disabled = false; });

      if (chrome.runtime.lastError) {
        showAuthError(chrome.runtime.lastError.message || 'Sign-in failed');
        resolve();
        return;
      }
      if (!response?.ok) {
        showAuthError(response?.error || 'Sign-in failed. Please try again.');
        resolve();
        return;
      }

      isAuthenticated = true;
      if (response.user) {
        currentUser = { email: response.user.email, name: response.user.name };
      }

      updateAuthUI();
      Els.ctaBanner?.classList.add('pm-hidden');

      // Re-render attendees to unmask preview data
      if (currentMeeting && currentAttendees.length > 0) {
        renderAttendees(currentMeeting, currentAttendees);
      }
      refreshCredits();
      resolve();
    });
  });
}

async function handleSignOut(): Promise<void> {
  return new Promise<void>((resolve) => {
    chrome.runtime.sendMessage({ type: 'AUTH_SIGN_OUT' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG, 'Sign-out error:', chrome.runtime.lastError.message);
      }

      isAuthenticated = false;
      currentUser = null;
      updateAuthUI();

      // Show CTA banner if attendees are visible
      if (currentAttendees.length > 0) {
        Els.ctaBanner?.classList.remove('pm-hidden');
      }

      // Re-render attendees with masked data
      if (currentMeeting && currentAttendees.length > 0) {
        renderAttendees(currentMeeting, currentAttendees);
      }
      refreshCredits();
      resolve();
    });
  });
}

function showAuthError(msg: string): void {
  if (!Els.authError) return;
  Els.authError.textContent = msg;
  Els.authError.classList.remove('pm-hidden');
}

// ─── Credits Display ──────────────────────────────────────────────────────────

function nextResetLabel(resetMonth: string): string {
  const [y, m] = resetMonth.split('-').map(Number);
  const next = new Date(y, m, 1); // month is 0-indexed, so m (1-indexed) gives next month
  return next.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function refreshCredits(): Promise<void> {
  const credits = await getCredits();
  const remaining = remainingCredits(credits);
  const isPro = credits.plan === 'pro';

  // Plan badge
  if (Els.planBadge) {
    Els.planBadge.textContent = isPro ? 'Pro' : 'Free';
    Els.planBadge.classList.remove('pm-hidden', 'pm-plan-badge--free', 'pm-plan-badge--pro');
    Els.planBadge.classList.add(isPro ? 'pm-plan-badge--pro' : 'pm-plan-badge--free');
  }

  // Credits counter (only shown for free plan)
  if (!Els.credits) return;
  if (isPro) {
    Els.credits.classList.add('pm-hidden');
    return;
  }

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
  const rawTitle = attendee.person?.title || '';
  const title = (!isAuthenticated && rawTitle) ? (maskTitle(rawTitle) || '') : rawTitle;
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
      card.classList.add('pm-card--pending');
      chrome.runtime.sendMessage({ type: 'ENRICH_ATTENDEE', payload: { email: attendee.email } }, () => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, 'ENRICH_ATTENDEE failed:', chrome.runtime.lastError.message);
          card.classList.remove('pm-card--pending');
        }
      });
    }

    // Open the side panel for the active GCal tab
    chrome.tabs.query({ url: 'https://calendar.google.com/*' }, (tabs) => {
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
  currentMeeting = meeting;

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

  // Show CTA banner when attendees are visible but user is not authenticated
  Els.ctaBanner?.classList.toggle('pm-hidden', isAuthenticated);

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
  if (Els.setAutoSearch) {
    (Els.setAutoSearch as HTMLInputElement).checked = s.autoSearchAttendees;
  }
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

  // Auto-search attendees
  Els.setAutoSearch?.addEventListener('change', async () => {
    await saveSettings({ autoSearchAttendees: (Els.setAutoSearch as HTMLInputElement).checked });
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

document.addEventListener('DOMContentLoaded', async () => {
  if (Els.year) Els.year.textContent = String(new Date().getFullYear());

  // Check auth state for freemium preview mode
  isAuthenticated = await checkAuthState();
  updateAuthUI();
  Els.ctaBanner?.classList.toggle('pm-hidden', isAuthenticated);

  // Auth event handlers — header, settings panel, and CTA banner sign-in buttons
  Els.headerSignin?.addEventListener('click', () => handleSignIn());
  Els.authSigninBtn?.addEventListener('click', () => handleSignIn());
  Els.ctaSignin?.addEventListener('click', () => handleSignIn());

  // Header user avatar opens settings
  Els.headerUser?.addEventListener('click', () => {
    loadSettingsUI();
    openSettings();
  });

  // Sign out
  Els.authSignoutBtn?.addEventListener('click', () => handleSignOut());

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
