/**
 * ButtonInjector
 *
 * Injects "Know [FirstName]" action buttons into Google Calendar event popups
 * near the attendee list. Buttons are styled to match Google Calendar's design
 * language and communicate with the background service worker on click.
 *
 * Loaded as a plain content script (no ES module imports).
 */

/* global ButtonInjector */

(function () {
  'use strict';

  const LOG_PREFIX = '[Meeting Intel][ButtonInjector]';

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

  // ─── Button Factory ───────────────────────────────────────────────────────

  /**
   * Build the first name from a full display name.
   *
   * @param {string} name
   * @returns {string}
   */
  function firstNameFrom(name) {
    if (!name) return '';
    return name.trim().split(/\s+/)[0];
  }

  /**
   * Create a single "Know [FirstName]" button element.
   *
   * @param {{ name: string, email: string, company: string|null }} attendee
   * @returns {HTMLButtonElement}
   */
  function createAttendeeButton(attendee) {
    const firstName = firstNameFrom(attendee.name) || attendee.email.split('@')[0];
    const label = `Know ${firstName}`;

    const btn = document.createElement('button');
    btn.className = 'meeting-intel-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', `Get professional background on ${attendee.name || attendee.email}`);
    btn.dataset.miName = attendee.name || '';
    btn.dataset.miEmail = attendee.email || '';
    btn.dataset.miCompany = attendee.company || '';

    // Icon span.
    const icon = document.createElement('span');
    icon.className = 'meeting-intel-icon';
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

    // Send fetch request to background service worker.
    chrome.runtime.sendMessage(
      { type: 'FETCH_PERSON_BACKGROUND', payload },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            LOG_PREFIX,
            'Error sending FETCH_PERSON_BACKGROUND:',
            chrome.runtime.lastError.message
          );
        } else {
          console.log(LOG_PREFIX, 'FETCH_PERSON_BACKGROUND acknowledged:', response);
        }
      }
    );

    // Request side panel to open.
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

        // Re-enable button after a short delay so user sees the loading state.
        setTimeout(() => {
          btn.classList.remove('loading');
          btn.removeAttribute('aria-busy');
          btn.disabled = false;
        }, 1500);
      }
    );
  }

  // ─── Class Definition ─────────────────────────────────────────────────────

  /**
   * ButtonInjector
   * Injects Meeting Intel action buttons into an event popup element.
   */
  class ButtonInjector {
    /**
     * Inject "Know [FirstName]" buttons into a popup for a list of attendees.
     * Safe to call multiple times – re-injection is prevented by checking for
     * an existing `.meeting-intel-container` on the popup.
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
      if (popupEl.querySelector('.meeting-intel-container')) {
        console.log(LOG_PREFIX, 'Buttons already injected – skipping');
        return false;
      }

      if (!attendees || attendees.length === 0) {
        console.log(LOG_PREFIX, 'No attendees to inject buttons for');
        return false;
      }

      // Build container.
      const container = document.createElement('div');
      container.className = 'meeting-intel-container';
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', 'Meeting Intel – attendee lookup');

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
     * Remove all injected Meeting Intel buttons from a popup element.
     *
     * @param {Element} popupEl
     */
    remove(popupEl) {
      if (!popupEl) return;
      popupEl.querySelectorAll('.meeting-intel-container').forEach((el) => el.remove());
    }
  }

  // Expose to shared content-script scope.
  window.ButtonInjector = ButtonInjector;
})();
