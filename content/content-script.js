/**
 * content-script.js
 *
 * Main entry point for the Bright People Intel content script.
 *
 * Execution order guaranteed by manifest content_scripts array:
 *   1. attendee-extractor.js  → defines window.AttendeeExtractor
 *   2. button-injector.js     → defines window.ButtonInjector
 *   3. calendar-observer.js   → defines window.CalendarObserver
 *   4. content-script.js      → this file, wires everything together
 *
 * None of these files use ES module import/export syntax because Manifest V3
 * content scripts run in the page's isolated world but do NOT support
 * module-type scripts. Classes are shared via the window object.
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[BPI]';

  // ─── Guard: only run on Google Calendar ────────────────────────────────────

  if (!window.location.hostname.includes('calendar.google.com')) {
    console.log(LOG_PREFIX, 'Not on Google Calendar – content script inactive');
    return;
  }

  // ─── Dependency check ───────────────────────────────────────────────────────

  if (
    typeof window.CalendarObserver === 'undefined' ||
    typeof window.AttendeeExtractor === 'undefined' ||
    typeof window.ButtonInjector === 'undefined'
  ) {
    console.error(
      LOG_PREFIX,
      'One or more dependencies failed to load. Check that attendee-extractor.js, ' +
        'button-injector.js, and calendar-observer.js are all listed before ' +
        'content-script.js in manifest.json.'
    );
    return;
  }

  // ─── Initialise ─────────────────────────────────────────────────────────────

  console.log(LOG_PREFIX, 'Initialising Bright People Intel v2.0.0 on', window.location.href);

  /** @type {CalendarObserver} */
  const observer = new window.CalendarObserver();

  // Start observing immediately – Google Calendar is a SPA so the body is
  // present but content loads asynchronously.
  observer.start();

  // ─── SPA Navigation Handling ────────────────────────────────────────────────

  // Google Calendar uses pushState navigation. Re-scan on URL change so
  // popups from the new "page" are also processed.
  let lastUrl = window.location.href;

  const navObserver = new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log(LOG_PREFIX, 'SPA navigation detected, new URL:', currentUrl);

      // On event editing form, proactively scan for the Guests section
      // after a delay to let the DOM render fully.
      if (currentUrl.includes('/eventedit/') || currentUrl.includes('/r/eventedit/')) {
        console.log(LOG_PREFIX, 'Edit form detected, scheduling scan');
        setTimeout(() => observer._scanExisting(), 1200);
      }
    }
  });

  navObserver.observe(document.body, { childList: true, subtree: false });

  // ─── Message listener ──────────────────────────────────────────────────────

  /**
   * Listen for messages from the background service worker.
   * Currently handles:
   *   - PERSON_BACKGROUND_RESULT: update button state after data arrives.
   *   - PING: health-check from the service worker.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only accept messages from our own extension.
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (!message || typeof message.type !== 'string') {
      console.warn(LOG_PREFIX, 'Received malformed message:', message);
      return false;
    }

    switch (message.type) {
      case 'PERSON_BACKGROUND_RESULT': {
        console.log(
          LOG_PREFIX,
          'Received background data for:',
          message.payload?.name || message.payload?.email
        );
        // Future: update button UI or show a toast notification here.
        sendResponse({ ok: true });
        break;
      }

      case 'PING': {
        console.log(LOG_PREFIX, 'PING received from service worker');
        sendResponse({ ok: true, url: window.location.href });
        break;
      }

      default:
        console.log(LOG_PREFIX, 'Unhandled message type:', message.type);
        return false;
    }

    // Return true to keep the message channel open for async sendResponse calls
    // (not needed here but good practice).
    return true;
  });

  // ─── Cleanup on unload ─────────────────────────────────────────────────────

  window.addEventListener('unload', () => {
    observer.stop();
    navObserver.disconnect();
    console.log(LOG_PREFIX, 'Content script cleaned up on unload');
  });

  console.log(LOG_PREFIX, 'Content script ready');
})();
