/**
 * CalendarObserver
 *
 * PreMeet — Watches the Google Calendar DOM for event popups and
 * detail panels using MutationObserver. When a popup is detected it runs the
 * attendee extractor and button injector.
 *
 * Loaded as a plain content script (no ES module imports).
 * Depends on AttendeeExtractor and ButtonInjector being defined earlier in
 * the content_scripts load order.
 */

/* global CalendarObserver, AttendeeExtractor, ButtonInjector */

(function () {
  'use strict';

  const LOG_PREFIX = '[PreMeet][CalendarObserver]';

  // ─── Popup Detection Helpers ─────────────────────────────────────────────

  /**
   * Determine whether a DOM node looks like a GCal event popup or dialog.
   *
   * @param {Node} node
   * @returns {boolean}
   */
  function isEventPopup(node) {
    if (!(node instanceof Element)) return false;

    // Explicit dialog role (most reliable across GCal versions).
    const role = node.getAttribute('role');
    if (role === 'dialog' || role === 'alertdialog') return true;

    // GCal event detail dialog – confirmed ID used in modern GCal.
    // #xDetDlgAtt is the attendees section inside the event detail popup.
    // We treat its closest dialog ancestor as the popup root.
    if (node.id === 'xDetDlgAtt') return true;

    // Google Calendar event detail popups carry data-eventid.
    if (node.hasAttribute('data-eventid')) return true;

    // Event chip expanded views (modern GCal).
    if (node.hasAttribute('data-eventchip')) return true;

    // Side-panel style event detail containers.
    if (
      node.matches(
        '[jsname="r4nke"], [jsname="VdSJob"], .VdSJob, [data-view="event-detail"], ' +
        '[jsname="CnSW2d"]'
      )
    )
      return true;

    // Some versions render event chips that expand into panels.
    if (node.classList.contains('OcVpRe') || node.classList.contains('V65ue')) return true;

    // GCal event detail panel opened as a side-panel.
    if (node.classList.contains('VdSJob') || node.classList.contains('YpDpRd')) return true;

    // Full-page event editing form – detect the Guests section container.
    if (isEditFormPage() && isEditFormGuestSection(node)) return true;

    return false;
  }

  /**
   * Determine whether a DOM node is likely a GCal event popup by scanning
   * its content for event-like patterns (time, guests, attendees).
   * Used as a broader fallback when strict selectors fail.
   *
   * @param {Node} node
   * @returns {boolean}
   */
  function looksLikeEventPopup(node) {
    if (!(node instanceof Element)) return false;
    // Must be reasonably sized to be a popup.
    const rect = node.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 100) return false;

    const text = (node.innerText || node.textContent || '').toLowerCase();
    // GCal popups typically mention guests or have attendee info.
    const hasGuestText = /\bguest|\battendee|\borganizer/.test(text);
    // And contain an email address.
    const hasEmail = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(text);
    return hasGuestText && hasEmail;
  }

  /**
   * Check whether the current URL is a GCal event editing form.
   * @returns {boolean}
   */
  function isEditFormPage() {
    const path = window.location.pathname;
    return path.includes('/eventedit/') || path.includes('/r/eventedit/');
  }

  /**
   * Check whether a DOM node looks like the Guests section on the edit form.
   * @param {Node} node
   * @returns {boolean}
   */
  function isEditFormGuestSection(node) {
    if (!(node instanceof Element)) return false;
    const label = (node.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('guest') || label.includes('attendee')) return true;
    if (node.querySelector && node.querySelector('[data-email], [data-hovercard-id], [aria-label*="guest" i]')) return true;
    return false;
  }

  /**
   * Walk up the DOM tree to find the nearest ancestor that qualifies as an
   * event popup (in case the mutated node is a child of the popup).
   *
   * @param {Element} el
   * @returns {Element|null}
   */
  function findPopupAncestor(el) {
    let current = el;
    let depth = 0;
    while (current && depth < 10) {
      if (isEventPopup(current)) return current;
      current = current.parentElement;
      depth++;
    }
    return null;
  }

  // ─── Class Definition ────────────────────────────────────────────────────

  /**
   * CalendarObserver
   * Starts/stops a MutationObserver that processes newly added event popups.
   */
  class CalendarObserver {
    constructor() {
      /** @type {MutationObserver|null} */
      this._observer = null;

      /**
       * WeakSet of popup elements that have already been processed so we don't
       * inject buttons more than once per popup instance.
       * @type {WeakSet<Element>}
       */
      this._processed = new WeakSet();

      this._extractor = new AttendeeExtractor();
      this._injector  = new ButtonInjector();

      // Bind so we can pass as a callback without losing `this`.
      this._handleMutations = this._handleMutations.bind(this);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Start observing the document body for GCal event popups.
     */
    start() {
      if (this._observer) {
        console.log(LOG_PREFIX, 'Already running – ignoring start()');
        return;
      }

      this._observer = new MutationObserver(this._handleMutations);
      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      console.log(LOG_PREFIX, 'Observer started');

      // Process any popups already present when the script loads (e.g. if
      // the user navigates with the back button).
      this._scanExisting();
    }

    /**
     * Stop observing and clean up.
     */
    stop() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
        console.log(LOG_PREFIX, 'Observer stopped');
      }
    }

    // ── Private ─────────────────────────────────────────────────────────────

    /**
     * MutationObserver callback. Uses requestAnimationFrame to let the DOM
     * settle before processing each mutated popup.
     *
     * @param {MutationRecord[]} mutations
     */
    _handleMutations(mutations) {
      const candidatePopups = new Set();

      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;

        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;

          // Check if the node itself is a popup.
          if (isEventPopup(node)) {
            candidatePopups.add(node);
            continue;
          }

          // Check descendants (GCal often inserts a wrapper then populates it).
          const descendantPopups = node.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [data-eventid], [data-eventchip], ' +
            '#xDetDlgAtt, [jsname="CnSW2d"], .OcVpRe, .V65ue, .VdSJob, .YpDpRd, ' +
            '[aria-label*="guest" i], [aria-label*="attendee" i]'
          );
          descendantPopups.forEach((p) => candidatePopups.add(p));

          // Check if an ancestor of this node is a popup (content was added
          // inside an already-mounted popup).
          const ancestor = findPopupAncestor(node);
          if (ancestor) candidatePopups.add(ancestor);
        }
      }

      if (candidatePopups.size === 0) return;

      // Deduplicate: remove any candidate that is a descendant of another
      // candidate. This prevents injecting buttons twice when both a dialog
      // wrapper and its inner guest-section are detected as separate popups.
      const deduped = [...candidatePopups].filter((el) => {
        for (const other of candidatePopups) {
          if (other !== el && other.contains(el)) return false;
        }
        return true;
      });

      // Let the DOM settle before reading attendee data.
      requestAnimationFrame(() => {
        deduped.forEach((popup) => this._processPopup(popup));
      });
    }

    /**
     * Process a single popup element: extract attendees and inject buttons.
     *
     * @param {Element} popupEl
     */
    _processPopup(popupEl) {
      if (!popupEl.isConnected) {
        // Popup was removed before we could process it.
        return;
      }

      // If we received the attendees section (#xDetDlgAtt), walk up to the
      // dialog root so we have the full popup context for injection.
      if (popupEl.id === 'xDetDlgAtt' || !popupEl.getAttribute('role')) {
        const dialogRoot = popupEl.closest('[role="dialog"], [role="alertdialog"]');
        if (dialogRoot && dialogRoot !== popupEl) {
          popupEl = dialogRoot;
        }
      }

      if (this._processed.has(popupEl)) {
        // Already handled this exact element instance.
        return;
      }

      console.log(LOG_PREFIX, 'Processing popup:', popupEl.tagName, (popupEl.id || popupEl.className.toString()).slice(0, 60));

      const attendees = this._extractor.extract(popupEl);

      if (attendees.length === 0) {
        // No attendees found yet – GCal may still be rendering guest list.
        // Schedule one retry after a short delay.
        this._retryOnce(popupEl);
        return;
      }

      const injected = this._injector.inject(popupEl, attendees);

      // Inject the single "Brief" CTA for all attendees at once.
      this._injector.injectBriefButton(popupEl, attendees);

      if (injected) {
        // Mark as processed only after a successful injection.
        this._processed.add(popupEl);
      }
    }

    /**
     * Retry processing a popup with escalating delays to handle lazy-loaded
     * guest lists. Tries at 400ms, 1200ms, and 2500ms.
     *
     * @param {Element} popupEl
     * @param {number} [attempt=0]
     */
    _retryOnce(popupEl, attempt = 0) {
      const delays = [400, 1200, 2500];
      if (attempt >= delays.length) {
        console.log(LOG_PREFIX, 'Max retries reached – popup may have no guests');
        this._processed.add(popupEl);
        return;
      }

      setTimeout(() => {
        if (!popupEl.isConnected || this._processed.has(popupEl)) return;

        console.log(LOG_PREFIX, `Retrying popup (attempt ${attempt + 1}) after ${delays[attempt]}ms`);
        const attendees = this._extractor.extract(popupEl);

        if (attendees.length > 0) {
          const injected = this._injector.inject(popupEl, attendees);
          this._injector.injectBriefButton(popupEl, attendees);
          if (injected) {
            this._processed.add(popupEl);
          } else {
            // Extraction found attendees but injection failed – still retry.
            this._retryOnce(popupEl, attempt + 1);
          }
        } else {
          // No attendees yet – keep retrying.
          this._retryOnce(popupEl, attempt + 1);
        }
      }, delays[attempt]);
    }

    /**
     * Scan for any popups already in the DOM when the observer starts.
     */
    _scanExisting() {
      const existing = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], #xDetDlgAtt, [data-eventid], [data-eventchip], ' +
        '[jsname="CnSW2d"], .OcVpRe, .V65ue, .VdSJob, .YpDpRd, ' +
        '[aria-label*="guest" i], [aria-label*="attendee" i]'
      );

      if (existing.length === 0) {
        // No strict matches — try broader content-based detection.
        this._scanExistingFallback();
        return;
      }

      console.log(LOG_PREFIX, `Found ${existing.length} existing popup(s) on start`);
      requestAnimationFrame(() => {
        existing.forEach((popup) => this._processPopup(popup));
      });
    }

    /**
     * Broader fallback scan: look for any visible element that looks like a
     * GCal event popup based on its text content (guest/attendee + email).
     */
    _scanExistingFallback() {
      // Limit to likely popup containers: fixed/absolute positioned overlays.
      const candidates = document.querySelectorAll(
        'div[style*="position: fixed"], div[style*="position:fixed"], ' +
        'div[style*="position: absolute"], div[style*="position:absolute"], ' +
        '[data-eventid], [jsaction*="eventdetail"], [jsaction*="event_detail"]'
      );

      let found = 0;
      candidates.forEach((el) => {
        if (looksLikeEventPopup(el)) {
          found++;
          requestAnimationFrame(() => this._processPopup(el));
        }
      });

      if (found > 0) {
        console.log(LOG_PREFIX, `Fallback scan found ${found} popup(s)`);
      }
    }
  }

  // Expose to shared content-script scope.
  window.CalendarObserver = CalendarObserver;
})();
