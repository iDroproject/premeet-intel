/**
 * ButtonInjector
 *
 * Bright People Intel — Injects "Know [FirstName]" action buttons into Google
 * Calendar event popups near the attendee list. Buttons are styled to match
 * Google Calendar's design language and communicate with the background service
 * worker on click.
 *
 * Loaded as a plain content script (no ES module imports).
 */

/* global ButtonInjector */

(function () {
  'use strict';

  const LOG_PREFIX = '[BPI][ButtonInjector]';

  // ─── DOM Helpers ─────────────────────────────────────────────────────────

  /**
   * Find the best insertion point inside a popup element.
   * Priority order:
   *   1. A sibling just before the guest/attendee list heading.
   *   2. After the event title / heading.
   *   3. Fallback – append to the popup root.
   *
   * @param {Element} popupEl
   * @returns {Element} The parent element to append the container to.
   */
  function findInsertionParent(popupEl) {
    // 1. Try to find the guest list section container.
    const guestSection =
      popupEl.querySelector(
        '[data-attendee-section], [aria-label*="guest" i], [aria-label*="attendee" i]'
      ) ||
      popupEl.querySelector('[jsname="ESCLMb"], [jsname="haAclf"]');

    if (guestSection && guestSection.parentElement) {
      return guestSection.parentElement;
    }

    // 2. After the event title.
    const title = popupEl.querySelector(
      'h1, h2, [role="heading"], .YPqjbf, [data-eventid-title]'
    );
    if (title && title.parentElement) {
      return title.parentElement;
    }

    // 3. Fallback.
    return popupEl;
  }

  /**
   * Determine where in the parent to insert the container node.
   * Returns a reference node to insertBefore, or null to appendChild.
   *
   * @param {Element} parent
   * @param {Element} popupEl
   * @returns {Element|null}
   */
  function findInsertBefore(parent, popupEl) {
    // Try to insert before the guest section if it lives directly in parent.
    const guestSection = popupEl.querySelector(
      '[aria-label*="guest" i], [aria-label*="attendee" i], [jsname="ESCLMb"]'
    );
    if (guestSection && guestSection.parentElement === parent) {
      return guestSection;
    }
    return null;
  }

  /**
   * Check if the extension context is still valid (not invalidated by reload/update).
   * @returns {boolean}
   */
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  // ─── Button Factory ───────────────────────────────────────────────────────

  /**
   * Build a short display label from the attendee's name or email.
   * Uses the full name (truncated to 25 chars) for readability.
   *
   * @param {{ name: string, email: string }} attendee
   * @returns {string}
   */
  function displayNameFor(attendee) {
    const name = (attendee.name || '').trim();
    if (name && !name.includes('@')) {
      return name.length > 25 ? name.slice(0, 23) + '…' : name;
    }
    // Fallback: local part of email, title-cased.
    const local = (attendee.email || '').split('@')[0] || '';
    return local
      .replace(/[._+\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Create a single "Know [FullName]" button element.
   *
   * @param {{ name: string, email: string, company: string|null }} attendee
   * @returns {HTMLButtonElement}
   */
  function createAttendeeButton(attendee) {
    const displayName = displayNameFor(attendee);
    const label = `Know ${displayName}`;

    const btn = document.createElement('button');
    btn.className = 'bpi-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', `Get professional background on ${attendee.name || attendee.email}`);
    btn.dataset.bpiName = attendee.name || '';
    btn.dataset.bpiEmail = attendee.email || '';
    btn.dataset.bpiCompany = attendee.company || '';

    // Icon span.
    const icon = document.createElement('span');
    icon.className = 'bpi-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u{1F50D}'; // magnifying glass

    const text = document.createElement('span');
    text.textContent = label;

    btn.appendChild(icon);
    btn.appendChild(text);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleButtonClick(btn, attendee);
    });

    return btn;
  }

  /**
   * Handle click on a "Know" button.
   * Sends two messages to the service worker:
   *   1. FETCH_PERSON_BACKGROUND – triggers data lookup.
   *   2. OPEN_SIDE_PANEL – opens the side panel to display results.
   *
   * @param {HTMLButtonElement} btn
   * @param {{ name: string, email: string, company: string|null }} attendee
   */
  function handleButtonClick(btn, attendee) {
    if (btn.classList.contains('loading')) return;

    // Guard against stale content scripts after extension reload/update.
    if (!isContextValid()) {
      console.warn(LOG_PREFIX, 'Extension context invalidated – please refresh the page.');
      return;
    }

    console.log(LOG_PREFIX, 'Button clicked for attendee:', attendee);

    // Set loading state.
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;

    const payload = {
      name: attendee.name,
      email: attendee.email,
      company: attendee.company,
    };

    try {
      // Open side panel FIRST so it's ready to receive the loading trigger.
      chrome.runtime.sendMessage(
        { type: 'OPEN_SIDE_PANEL' },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              LOG_PREFIX,
              'Error sending OPEN_SIDE_PANEL:',
              chrome.runtime.lastError.message
            );
          } else {
            console.log(LOG_PREFIX, 'OPEN_SIDE_PANEL acknowledged:', response);
          }

          // Send fetch request AFTER side panel is open.
          chrome.runtime.sendMessage(
            { type: 'FETCH_PERSON_BACKGROUND', payload },
            (fetchResponse) => {
              if (chrome.runtime.lastError) {
                console.error(
                  LOG_PREFIX,
                  'Error sending FETCH_PERSON_BACKGROUND:',
                  chrome.runtime.lastError.message
                );
              } else {
                console.log(LOG_PREFIX, 'FETCH_PERSON_BACKGROUND acknowledged:', fetchResponse);
              }
            }
          );

          // Re-enable button after a short delay so user sees the loading state.
          setTimeout(() => {
            btn.classList.remove('loading');
            btn.removeAttribute('aria-busy');
            btn.disabled = false;
          }, 1500);
        }
      );
    } catch (err) {
      console.warn(LOG_PREFIX, 'Failed to send message (context may be invalidated):', err.message);
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  // ─── Class Definition ─────────────────────────────────────────────────────

  /**
   * ButtonInjector
   * Injects Bright People Intel action buttons into an event popup element.
   */
  class ButtonInjector {
    /**
     * Inject "Know [FirstName]" buttons into a popup for a list of attendees.
     * Safe to call multiple times – re-injection is prevented by checking for
     * an existing `.bpi-container` on the popup.
     *
     * @param {Element} popupEl - The event popup root element.
     * @param {Array<{name: string, email: string, company: string|null}>} attendees
     * @returns {boolean} True if buttons were injected, false if skipped.
     */
    inject(popupEl, attendees) {
      if (!popupEl || !(popupEl instanceof Element)) {
        console.warn(LOG_PREFIX, 'inject() called with invalid element');
        return false;
      }

      // Guard: don't inject twice into the same popup.
      if (popupEl.querySelector('.bpi-container')) {
        console.log(LOG_PREFIX, 'Buttons already injected – skipping');
        return false;
      }

      if (!attendees || attendees.length === 0) {
        console.log(LOG_PREFIX, 'No attendees to inject buttons for');
        return false;
      }

      // Build container.
      const container = document.createElement('div');
      container.className = 'bpi-container';
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', 'Bright People Intel – attendee lookup');

      // One button per attendee.
      attendees.forEach((attendee) => {
        if (!attendee.email && !attendee.name) return;
        const btn = createAttendeeButton(attendee);
        container.appendChild(btn);
      });

      if (container.childElementCount === 0) {
        console.log(LOG_PREFIX, 'All attendees were empty – nothing to inject');
        return false;
      }

      // Find the right place in the DOM.
      const parent = findInsertionParent(popupEl);
      const before = findInsertBefore(parent, popupEl);

      try {
        if (before) {
          parent.insertBefore(container, before);
        } else {
          parent.appendChild(container);
        }
        console.log(
          LOG_PREFIX,
          `Injected ${container.childElementCount} button(s) into popup`
        );
        return true;
      } catch (err) {
        console.error(LOG_PREFIX, 'Failed to inject container:', err);
        return false;
      }
    }

    /**
     * Remove all injected Bright People Intel buttons from a popup element.
     *
     * @param {Element} popupEl
     */
    remove(popupEl) {
      if (!popupEl) return;
      popupEl.querySelectorAll('.bpi-container').forEach((el) => el.remove());
    }
  }

  // Expose to shared content-script scope.
  window.ButtonInjector = ButtonInjector;
})();
