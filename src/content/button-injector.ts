// PreMeet button injector — injects "Brief" buttons next to attendee rows
// and a "Brief All" button in the event popup header (manual trigger mode).

import type { Attendee, MeetingEvent } from '../types';
import { isContextValid } from './helpers';

const LOG = '[PreMeet][ButtonInjector]';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AttendeeWithElement extends Attendee {
  element: Element | null;
}

// ─── Display Helpers ────────────────────────────────────────────────────────

function displayNameFor(attendee: Attendee): string {
  const name = (attendee.name || '').trim();
  if (name && !name.includes('@')) {
    return name.length > 25 ? name.slice(0, 23) + '\u2026' : name;
  }
  const local = (attendee.email || '').split('@')[0] || '';
  return local
    .replace(/[._+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Per-Attendee "Brief" Button ────────────────────────────────────────────

function createInlineButton(
  attendee: Attendee,
  onClick: (attendee: Attendee) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'pm-brief-inline';
  btn.type = 'button';
  btn.title = `Brief ${displayNameFor(attendee)}`;
  btn.setAttribute('aria-label', `Get professional background on ${attendee.name || attendee.email}`);

  const icon = document.createElement('span');
  icon.className = 'pm-brief-inline__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '\uD83D\uDD0D'; // magnifying glass

  const text = document.createElement('span');
  text.textContent = 'Brief';

  btn.appendChild(icon);
  btn.appendChild(text);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (btn.classList.contains('pm-brief--loading')) return;
    onClick(attendee);
    setButtonLoading(btn, true);
    setTimeout(() => setButtonLoading(btn, false), 1500);
  });

  return btn;
}

// ─── "Brief All" Button ─────────────────────────────────────────────────────

function createBriefAllButton(
  count: number,
  onClick: () => void,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'pm-brief-all-wrap';
  wrap.dataset.pmBriefAll = 'true';

  const btn = document.createElement('button');
  btn.className = 'pm-brief-all';
  btn.type = 'button';
  btn.title = `Brief all ${count} attendee${count !== 1 ? 's' : ''}`;
  btn.setAttribute('aria-label', `Get professional background on all ${count} attendees`);

  const icon = document.createElement('span');
  icon.className = 'pm-brief-all__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '\uD83D\uDCCB'; // clipboard

  const label = document.createElement('span');
  label.textContent = 'Brief All';

  const badge = document.createElement('span');
  badge.className = 'pm-brief-all__count';
  badge.textContent = String(count);

  btn.appendChild(icon);
  btn.appendChild(label);
  btn.appendChild(badge);
  wrap.appendChild(btn);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (btn.classList.contains('pm-brief--loading')) return;
    onClick();
    setButtonLoading(btn, true);
    setTimeout(() => setButtonLoading(btn, false), 2000);
  });

  return wrap;
}

function setButtonLoading(btn: HTMLButtonElement, loading: boolean): void {
  if (loading) {
    btn.classList.add('pm-brief--loading');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    btn.classList.remove('pm-brief--loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Inject per-attendee "Brief" buttons and a "Brief All" button into a GCal event popup.
 *
 * @param popupEl  The event popup root element
 * @param attendees  Attendees with their DOM elements for inline injection
 * @param onBriefOne  Called when a single-attendee Brief is clicked
 * @param onBriefAll  Called when Brief All is clicked
 */
export function injectButtons(
  popupEl: Element,
  attendees: AttendeeWithElement[],
  onBriefOne: (attendee: Attendee) => void,
  onBriefAll: (attendees: Attendee[]) => void,
): void {
  if (!popupEl || attendees.length === 0) return;

  // Guard: don't inject twice
  if (popupEl.querySelector('[data-pm-brief-all="true"]')) return;

  // Inject "Brief All" at the top of the attendee section
  const briefAllWrap = createBriefAllButton(attendees.length, () => {
    if (!isContextValid()) return;
    console.log(LOG, 'Brief All clicked for', attendees.length, 'attendee(s)');
    onBriefAll(attendees);
  });

  const attendeeSection =
    popupEl.querySelector('#xDetDlgAtt') ||
    popupEl.querySelector('[aria-label*="guest" i]') ||
    popupEl.querySelector('[aria-label*="attendee" i]') ||
    popupEl;

  try {
    attendeeSection.insertBefore(briefAllWrap, attendeeSection.firstChild);
  } catch {
    popupEl.appendChild(briefAllWrap);
  }

  // Inject per-attendee inline buttons
  for (const att of attendees) {
    const el = att.element;
    if (!el || !(el instanceof Element) || !el.isConnected) continue;
    if (el.getAttribute('data-pm-injected') === 'true') continue;
    if (el.closest('[data-pm-injected="true"]')) continue;

    const btn = createInlineButton(att, (a) => {
      if (!isContextValid()) return;
      console.log(LOG, 'Brief clicked for', a.name || a.email);
      onBriefOne(a);
    });

    // Find best insertion point
    let target: Element = el;
    const tag = el.tagName;
    if (tag === 'SPAN' || tag === 'A' || tag === 'STRONG') {
      const parentBlock = el.closest('li, div, tr, p');
      if (parentBlock && parentBlock !== popupEl) target = parentBlock;
    }

    try {
      target.appendChild(btn);
      target.setAttribute('data-pm-injected', 'true');
    } catch {
      // Skip if DOM manipulation fails
    }
  }

  console.log(LOG, `Injected buttons for ${attendees.length} attendee(s)`);
}

/**
 * Remove all injected PreMeet buttons from a popup element.
 */
export function removeButtons(popupEl: Element): void {
  if (!popupEl) return;
  popupEl.querySelectorAll('.pm-brief-inline').forEach((el) => el.remove());
  popupEl.querySelectorAll('.pm-brief-all-wrap').forEach((el) => el.remove());
  popupEl.querySelectorAll('[data-pm-injected]').forEach((el) => {
    el.removeAttribute('data-pm-injected');
  });
}
