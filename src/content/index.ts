// PreMeet content script — injected into Google Calendar pages
// Detects calendar event popups, extracts attendees, and notifies the background SW.
// Supports two trigger modes:
//   - Auto (default): sends MEETING_DETECTED immediately on popup open
//   - Manual: injects "Brief" / "Brief All" buttons; sends on click

import type { Attendee, MeetingEvent, ContentToBackground, TriggerMode } from '../types';
import { initOnboarding, onMeetingDetected, onEnrichmentComplete } from './onboarding';
import { cleanName, nameFromEmail, companyFromEmail, isContextValid, isPersonEmail, isLikelyPersonName, MAX_NAME_LENGTH } from './helpers';
import { injectButtons, removeButtons, resetAllLoadingButtons } from './button-injector';
import type { AttendeeWithElement } from './button-injector';

const LOG = '[PreMeet][Content]';

// ─── Trigger Mode State ─────────────────────────────────────────────────────

let triggerMode: TriggerMode = 'auto';

async function loadTriggerMode(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get('pm_settings');
    const settings = result.pm_settings;
    if (settings && settings.triggerMode) {
      triggerMode = settings.triggerMode;
    }
  } catch {
    // Default to auto
  }
  console.log(LOG, 'Trigger mode:', triggerMode);
}

// Listen for settings changes so mode updates without reload
function watchTriggerMode(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.pm_settings) return;
    const newSettings = changes.pm_settings.newValue;
    if (newSettings && newSettings.triggerMode && newSettings.triggerMode !== triggerMode) {
      const oldMode = triggerMode;
      triggerMode = newSettings.triggerMode;
      console.log(LOG, `Trigger mode changed: ${oldMode} → ${triggerMode}`);
      // Clean up any injected buttons if switching to auto
      if (triggerMode === 'auto') {
        document.querySelectorAll('[data-pm-brief-all="true"]').forEach((el) => {
          const popup = el.closest('[role="dialog"], [data-eventid], .OcVpRe, .V65ue');
          if (popup) removeButtons(popup);
        });
      }
    }
  });
}

// ─── Extraction Strategies ────────────────────────────────────────────────────

interface AttendeeRaw extends Attendee {
  element: Element | null;
}

function extractViaDataAttributes(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  root.querySelectorAll<HTMLElement>('[data-email], [data-hovercard-id]').forEach((el) => {
    const email =
      el.dataset.email ||
      (el.dataset.hovercardId || '').replace(/^contact:/, '');
    if (!email || !email.includes('@')) return;
    let name = cleanName(el.getAttribute('aria-label') || el.textContent?.trim() || '');
    if (!name || name.includes('@')) name = nameFromEmail(email);
    results.push({ name, email, company: companyFromEmail(email), element: el });
  });
  return results;
}

function extractViaAriaLabels(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  root.querySelectorAll('[aria-label*="guest" i], [aria-label*="attendee" i], [aria-label*="invited" i]').forEach((section) => {
    const text = (section as HTMLElement).innerText || section.textContent || '';
    for (const email of text.match(EMAIL_RE) || []) {
      results.push({ name: nameFromEmail(email), email, company: companyFromEmail(email), element: section as Element });
    }
  });
  return results;
}

function extractViaMailtoLinks(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  root.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]').forEach((link) => {
    const email = link.href.replace('mailto:', '').split('?')[0].trim();
    if (!email.includes('@')) return;
    let name = link.textContent?.trim() || '';
    if (!name || name.includes('@')) name = nameFromEmail(email);
    results.push({ name, email, company: companyFromEmail(email), element: link });
  });
  return results;
}

const ATTENDEE_SELECTORS = [
  '.PoMeXc', '.PKKqje', '.xYjf6e',
  '[jsname="ESCLMb"]', '[jsname="haAclf"]',
  '#xDetDlgAtt [data-email]', '#xDetDlgAtt .bgOWSb',
];

function extractViaKnownClasses(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  ATTENDEE_SELECTORS.forEach((sel) => {
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const email = el.dataset.email || el.getAttribute('title') || el.getAttribute('data-tooltip') || '';
      const name = cleanName(
        el.querySelector<HTMLElement>('.T2tEie, .d7RUue, [jsname="r4nke"]')?.textContent?.trim() ||
        el.getAttribute('aria-label') || el.textContent?.trim() || ''
      );
      if (!email.includes('@') && !name) return;
      const resolvedEmail = email.includes('@') ? email : '';
      results.push({ name: name || nameFromEmail(resolvedEmail), email: resolvedEmail, company: resolvedEmail ? companyFromEmail(resolvedEmail) : null, element: el });
    });
  });
  return results;
}

/**
 * Strategy 5: Title-attribute email scan.
 * GCal places attendee emails in the `title` attribute of chip elements.
 * Most direct and reliable when data-email is absent.
 */
function extractViaTitleAttribute(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  root.querySelectorAll<HTMLElement>('[title*="@"]').forEach((el) => {
    const title = el.getAttribute('title') || '';
    const emailMatch = title.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (!emailMatch) return;
    const email = emailMatch[0];

    let name = cleanName(el.getAttribute('aria-label') || '');
    if (!name || name.includes('@')) name = cleanName(el.textContent?.trim() || '');
    if (!name || name.includes('@')) {
      const nameFromTitle = title.replace(/<[^>]+>/, '').replace(email, '').trim();
      name = cleanName(nameFromTitle);
    }
    if (!name || name.includes('@')) name = nameFromEmail(email);

    const target = el.closest('li, [role="listitem"], div.PoMeXc, div.PKKqje') || el;
    results.push({ name, email, company: companyFromEmail(email), element: target });
  });
  return results;
}

/**
 * Strategy 6: Full text-node scan for email addresses.
 * Walks every text node inside the popup — most resilient fallback
 * since it works regardless of GCal class names or data attributes.
 */
function extractViaTextScan(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // Skip description/location sections — emails there are meeting body text, not attendees.
  const DESCRIPTION_SELECTORS =
    '[data-eventchip] [data-content], [data-eventid] .NMtib, [jsname="x8hBRd"], .IbTbbe, ' +
    '[aria-label*="description" i], [aria-label*="location" i], ' +
    '[aria-label*="conference" i], [aria-label*="join with" i]';

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let textNode: Node | null;

  while ((textNode = walker.nextNode())) {
    const text = textNode.textContent || '';
    const matches = text.match(emailRe);
    if (!matches) continue;

    if ((textNode as Text).parentElement?.closest(DESCRIPTION_SELECTORS)) continue;

    for (const email of matches) {
      if (!isPersonEmail(email)) continue;

      let el: Element | null = (textNode as Text).parentElement;
      const BLOCK = new Set(['LI', 'TR', 'DIV', 'SPAN', 'P', 'ARTICLE', 'SECTION']);
      while (el && el !== root && !BLOCK.has(el.tagName)) {
        el = el.parentElement;
      }
      if (!el || el === root) el = (textNode as Text).parentElement;

      let name = cleanName(el?.getAttribute('aria-label') || '');
      if (!name || name.includes('@')) {
        const fullText = ((el as HTMLElement)?.innerText || el?.textContent || '')
          .replace(email, '')
          .replace(/,\s*$/, '')
          .trim();
        name = cleanName(fullText);
      }
      if (!name || name.includes('@')) name = nameFromEmail(email);
      if (name.length > MAX_NAME_LENGTH) name = nameFromEmail(email);

      results.push({ name, email, company: companyFromEmail(email), element: el });
    }
  }
  return results;
}

/**
 * Strategy 7: Scan elements near "X guests" text.
 * Finds the guest count section and scans descendant leaf elements.
 */
function extractViaGuestSection(root: Element): AttendeeRaw[] {
  const results: AttendeeRaw[] = [];
  const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

  const guestHeaderEl = Array.from(root.querySelectorAll('*')).find((el) => {
    if (el.children.length > 5) return false;
    const t = ((el as HTMLElement).innerText || el.textContent || '').trim().toLowerCase();
    return /^\d+\s+guests?$/.test(t) || t === 'guests' || t === 'guest';
  });

  if (!guestHeaderEl) return results;

  const guestSection =
    guestHeaderEl.closest('[aria-label*="guest" i], [aria-label*="attendee" i]') ||
    guestHeaderEl.parentElement?.parentElement;

  if (!guestSection || guestSection === root) return results;

  guestSection.querySelectorAll('*').forEach((el) => {
    if (el.children.length > 0) return;
    const text = ((el as HTMLElement).innerText || el.textContent || '').trim();
    if (!text) return;

    if (emailRe.test(text)) {
      const email = text.match(emailRe)![0];
      results.push({ name: nameFromEmail(email), email, company: companyFromEmail(email), element: (el.parentElement || el) as Element });
    } else if (text.length > 1 && text.length < 60 && !/^\d+$/.test(text) && text !== 'Organizer') {
      const ariaEmail =
        el.getAttribute('data-email') ||
        (el.getAttribute('data-hovercard-id') || '').replace(/^contact:/, '');
      if (ariaEmail.includes('@')) {
        results.push({ name: cleanName(text), email: ariaEmail, company: companyFromEmail(ariaEmail), element: (el.parentElement || el) as Element });
      }
    }
  });
  return results;
}

function extractAttendees(popup: Element): AttendeeRaw[] {
  const strategies = [
    extractViaTitleAttribute,    // Highest confidence — title attr emails
    extractViaDataAttributes,
    extractViaAriaLabels,
    extractViaMailtoLinks,
    extractViaKnownClasses,
    extractViaGuestSection,
    extractViaTextScan,          // Broadest fallback — scans all text nodes
  ];
  const all: AttendeeRaw[] = [];
  for (const fn of strategies) {
    try { all.push(...fn(popup)); } catch { /* ignore */ }
  }
  // Deduplicate by email (fallback: name)
  const seen = new Map<string, AttendeeRaw>();
  for (const a of all) {
    const key = (a.email || a.name).toLowerCase();
    if (key && !seen.has(key)) seen.set(key, a);
  }
  // Filter out non-person emails and non-person names
  return [...seen.values()].filter((a) => {
    if (a.email && !isPersonEmail(a.email)) return false;
    if (a.name && a.name.length > MAX_NAME_LENGTH) {
      a.name = a.email ? nameFromEmail(a.email) : a.name.slice(0, MAX_NAME_LENGTH);
    }
    // If attendee has a valid email, keep them even with an odd name
    if (a.email && a.email.includes('@')) return true;
    // Name-only attendees must pass the person-name check
    if (!isLikelyPersonName(a.name)) return false;
    return true;
  });
}

// ─── Title Extraction ─────────────────────────────────────────────────────────

function extractTitle(popup: Element): string {
  const titleEl =
    popup.querySelector<HTMLElement>('h1, [data-eventid] h1, .UblTBe, [jsname="r4nke"] .P7O229, [aria-label^="Event:"]');
  if (titleEl) return titleEl.textContent?.trim() || 'Meeting';
  const label = popup.getAttribute('aria-label') || '';
  if (label && !label.toLowerCase().includes('dialog')) return label.trim();
  return 'Meeting';
}

// ─── Popup Detection ──────────────────────────────────────────────────────────

function isEventPopup(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.getAttribute('role') === 'dialog') return true;
  if (node.hasAttribute('data-eventid')) return true;
  if (node.matches('[jsname="r4nke"], [jsname="VdSJob"], .VdSJob, [data-view="event-detail"]')) return true;
  if (node.classList.contains('OcVpRe') || node.classList.contains('V65ue')) return true;
  return false;
}

function findPopupAncestor(el: Element): Element | null {
  let cur: Element | null = el;
  for (let i = 0; i < 10; i++) {
    if (cur === null) break;
    const checked: Element = cur;
    if (isEventPopup(checked)) return checked;
    cur = checked.parentElement;
  }
  return null;
}

// ─── Message Sending ─────────────────────────────────────────────────────────

function sendMeetingDetected(meeting: MeetingEvent): void {
  if (!isContextValid()) {
    console.warn(LOG, 'Extension context invalidated — skipping sendMessage.');
    return;
  }
  onMeetingDetected();
  const msg: ContentToBackground = { type: 'MEETING_DETECTED', payload: meeting };
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      console.warn(LOG, 'sendMessage error:', chrome.runtime.lastError.message);
    }
  });
}

function sendSingleBrief(attendee: Attendee): void {
  if (!isContextValid()) return;
  // Build a single-attendee meeting event
  const meeting: MeetingEvent = { title: 'Meeting', attendees: [attendee] };
  onMeetingDetected();
  const msg: ContentToBackground = { type: 'MEETING_DETECTED', payload: meeting };
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      console.warn(LOG, 'sendMessage error:', chrome.runtime.lastError.message);
    }
  });
}

// ─── Observer ────────────────────────────────────────────────────────────────

const processed = new WeakSet<Element>();

function processPopup(popup: Element): void {
  if (!popup.isConnected || processed.has(popup)) return;

  const attendees = extractAttendees(popup);
  if (attendees.length === 0) {
    // Escalating retry — 3 attempts at increasing delays
    const RETRY_DELAYS = [400, 1200, 2500];
    let attempt = 0;
    const tryRetry = (): void => {
      if (attempt >= RETRY_DELAYS.length) {
        processed.add(popup); // No guests after all retries
        return;
      }
      setTimeout(() => {
        if (!popup.isConnected || processed.has(popup) || !isContextValid()) return;
        const retried = extractAttendees(popup);
        if (retried.length > 0) {
          processed.add(popup);
          handlePopupWithAttendees(popup, retried);
        } else {
          attempt++;
          tryRetry();
        }
      }, RETRY_DELAYS[attempt]);
    };
    tryRetry();
    return;
  }

  processed.add(popup);
  handlePopupWithAttendees(popup, attendees);
}

function handlePopupWithAttendees(popup: Element, attendees: AttendeeRaw[]): void {
  const title = extractTitle(popup);
  const meeting: MeetingEvent = {
    title,
    attendees: attendees.map(({ name, email, company }) => ({ name, email, company })),
  };

  console.log(LOG, `Meeting detected: "${title}" (${attendees.length} attendee(s)) [mode: ${triggerMode}]`);

  if (triggerMode === 'auto') {
    sendMeetingDetected(meeting);
  } else {
    // Manual mode: inject buttons
    const withElements: AttendeeWithElement[] = attendees.map((a) => ({
      name: a.name,
      email: a.email,
      company: a.company,
      element: a.element,
    }));

    injectButtons(
      popup,
      withElements,
      // Single-attendee brief
      (attendee) => {
        console.log(LOG, `Manual brief for: ${attendee.name || attendee.email}`);
        sendSingleBrief(attendee);
      },
      // Brief all
      (allAttendees) => {
        console.log(LOG, `Manual brief all: ${allAttendees.length} attendee(s)`);
        sendMeetingDetected({ title, attendees: allAttendees });
      },
    );
  }
}

function handleMutations(mutations: MutationRecord[]): void {
  if (!isContextValid()) return; // extension reloaded — stop processing
  const candidates = new Set<Element>();

  for (const { addedNodes } of mutations) {
    Array.from(addedNodes).forEach((node) => {
      if (!(node instanceof Element)) return;
      const el = node as Element;
      if (isEventPopup(el)) { candidates.add(el); return; }
      el.querySelectorAll<Element>('[role="dialog"], [data-eventid], .OcVpRe, .V65ue').forEach((p: Element) => candidates.add(p));
      const ancestor = findPopupAncestor(el);
      if (ancestor) candidates.add(ancestor);
    });
  }

  if (candidates.size === 0) return;

  // Remove descendants that are duplicates of an ancestor in the set
  const deduped = [...candidates].filter((el) => {
    for (const other of candidates) {
      if (other !== el && other.contains(el)) return false;
    }
    return true;
  });

  requestAnimationFrame(() => deduped.forEach(processPopup));
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await loadTriggerMode();
  watchTriggerMode();

  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true });
  console.log(LOG, 'Observer started on', window.location.href);

  // Scan for any already-open popups on load
  document.querySelectorAll<Element>('[role="dialog"], [data-eventid], .OcVpRe, .V65ue').forEach(processPopup);
}

// ─── Message Listener (from background) ──────────────────────────────────────

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isContextValid()) return false;
    if (msg?.type === 'ENRICHMENT_COMPLETE') {
      onEnrichmentComplete();
      resetAllLoadingButtons();
      sendResponse({ ok: true });
    }
    return false;
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); initOnboarding(); });
} else {
  init();
  initOnboarding();
}
