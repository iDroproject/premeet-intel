// PreMeet content script — injected into Google Calendar pages
// Detects calendar event popups, extracts attendees, and notifies the background SW.

import type { Attendee, MeetingEvent, ContentToBackground } from '../types';
import { initOnboarding, onMeetingDetected, onEnrichmentComplete } from './onboarding';
import { cleanName, nameFromEmail, companyFromEmail, isContextValid } from './helpers';

const LOG = '[PreMeet][Content]';

// ─── Extraction Strategies ────────────────────────────────────────────────────

function extractViaDataAttributes(root: Element): Attendee[] {
  const results: Attendee[] = [];
  root.querySelectorAll<HTMLElement>('[data-email], [data-hovercard-id]').forEach((el) => {
    const email =
      el.dataset.email ||
      (el.dataset.hovercardId || '').replace(/^contact:/, '');
    if (!email || !email.includes('@')) return;
    let name = cleanName(el.getAttribute('aria-label') || el.textContent?.trim() || '');
    if (!name || name.includes('@')) name = nameFromEmail(email);
    results.push({ name, email, company: companyFromEmail(email) });
  });
  return results;
}

function extractViaAriaLabels(root: Element): Attendee[] {
  const results: Attendee[] = [];
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  root.querySelectorAll('[aria-label*="guest" i], [aria-label*="attendee" i], [aria-label*="invited" i]').forEach((section) => {
    const text = (section as HTMLElement).innerText || section.textContent || '';
    for (const email of text.match(EMAIL_RE) || []) {
      results.push({ name: nameFromEmail(email), email, company: companyFromEmail(email) });
    }
  });
  return results;
}

function extractViaMailtoLinks(root: Element): Attendee[] {
  const results: Attendee[] = [];
  root.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]').forEach((link) => {
    const email = link.href.replace('mailto:', '').split('?')[0].trim();
    if (!email.includes('@')) return;
    let name = link.textContent?.trim() || '';
    if (!name || name.includes('@')) name = nameFromEmail(email);
    results.push({ name, email, company: companyFromEmail(email) });
  });
  return results;
}

const ATTENDEE_SELECTORS = ['.PoMeXc', '.PKKqje', '.xYjf6e', '[jsname="ESCLMb"]', '[jsname="haAclf"]'];

function extractViaKnownClasses(root: Element): Attendee[] {
  const results: Attendee[] = [];
  ATTENDEE_SELECTORS.forEach((sel) => {
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const email = el.dataset.email || el.getAttribute('title') || el.getAttribute('data-tooltip') || '';
      const name = cleanName(
        el.querySelector<HTMLElement>('.T2tEie, .d7RUue, [jsname="r4nke"]')?.textContent?.trim() ||
        el.getAttribute('aria-label') || el.textContent?.trim() || ''
      );
      if (!email.includes('@') && !name) return;
      const resolvedEmail = email.includes('@') ? email : '';
      results.push({ name: name || nameFromEmail(resolvedEmail), email: resolvedEmail, company: resolvedEmail ? companyFromEmail(resolvedEmail) : null });
    });
  });
  return results;
}

function extractAttendees(popup: Element): Attendee[] {
  const strategies = [extractViaDataAttributes, extractViaAriaLabels, extractViaMailtoLinks, extractViaKnownClasses];
  const all: Attendee[] = [];
  for (const fn of strategies) {
    try { all.push(...fn(popup)); } catch { /* ignore */ }
  }
  // Deduplicate by email (fallback: name)
  const seen = new Map<string, Attendee>();
  for (const a of all) {
    const key = (a.email || a.name).toLowerCase();
    if (key && !seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}

// ─── Title Extraction ─────────────────────────────────────────────────────────

function extractTitle(popup: Element): string {
  // Try common title element selectors in GCal event popups
  const titleEl =
    popup.querySelector<HTMLElement>('h1, [data-eventid] h1, .UblTBe, [jsname="r4nke"] .P7O229, [aria-label^="Event:"]');
  if (titleEl) return titleEl.textContent?.trim() || 'Meeting';
  // Fallback: aria-label on the dialog itself
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

// ─── Observer ────────────────────────────────────────────────────────────────

const processed = new WeakSet<Element>();

function processPopup(popup: Element): void {
  if (!popup.isConnected || processed.has(popup)) return;

  const attendees = extractAttendees(popup);
  if (attendees.length === 0) {
    // Retry once after DOM settles
    setTimeout(() => {
      if (!popup.isConnected || processed.has(popup) || !isContextValid()) return;
      const retried = extractAttendees(popup);
      if (retried.length > 0) {
        processed.add(popup);
        const meeting: MeetingEvent = { title: extractTitle(popup), attendees: retried };
        console.log(LOG, `Meeting detected: "${meeting.title}" (${retried.length} attendee(s))`);
        sendMeetingDetected(meeting);
      } else {
        processed.add(popup); // No guests — mark done to avoid loops
      }
    }, 800);
    return;
  }

  processed.add(popup);
  const meeting: MeetingEvent = { title: extractTitle(popup), attendees };
  console.log(LOG, `Meeting detected: "${meeting.title}" (${attendees.length} attendee(s))`);
  sendMeetingDetected(meeting);
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

function init(): void {
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
