/**
 * ButtonInjector
 *
 * PreMeet — Injects compact inline "Know" buttons next to each
 * attendee row in Google Calendar event popups and edit pages. Buttons are
 * subtle and do not interfere with Google Calendar's native guest management UI.
 *
 * Loaded as a plain content script (no ES module imports).
 */

/* global ButtonInjector */

(function () {
  'use strict';

  const LOG_PREFIX = '[PreMeet][ButtonInjector]';

  // ─── DOM Helpers ─────────────────────────────────────────────────────────

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
   * Create a compact inline "Know" button for a single attendee.
   *
   * @param {{ name: string, email: string, company: string|null }} attendee
   * @returns {HTMLButtonElement}
   */
  function createInlineButton(attendee) {
    const fullName = displayNameFor(attendee);

    const btn = document.createElement('button');
    btn.className = 'bpi-inline-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', `Know ${fullName}`);
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
    text.textContent = 'Know';

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
   *   1. OPEN_SIDE_PANEL – opens the side panel to display results.
   *   2. FETCH_PERSON_BACKGROUND – triggers data lookup.
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
   * Injects compact inline PreMeet action buttons next to each
   * attendee element in an event popup.
   */
  class ButtonInjector {
    /**
     * Inject inline "Know" buttons next to each attendee element.
     * Safe to call multiple times – re-injection is prevented by checking for
     * the [data-bpi-injected] attribute on each attendee element.
     *
     * @param {Element} popupEl - The event popup root element.
     * @param {Array<{name: string, email: string, company: string|null, element?: Element}>} attendees
     * @returns {boolean} True if any buttons were injected, false if skipped.
     */
    inject(popupEl, attendees) {
      if (!popupEl || !(popupEl instanceof Element)) {
        console.warn(LOG_PREFIX, 'inject() called with invalid element');
        return false;
      }

      if (!attendees || attendees.length === 0) {
        console.log(LOG_PREFIX, 'No attendees to inject buttons for');
        return false;
      }

      let injectedCount = 0;

      attendees.forEach((attendee) => {
        if (!attendee.email && !attendee.name) return;

        const el = attendee.element;
        if (!el || !(el instanceof Element) || !el.isConnected) return;

        // Guard: don't inject twice on the same element.
        if (el.getAttribute('data-bpi-injected') === 'true') return;

        // Also guard if any ancestor already has the button.
        if (el.closest('[data-bpi-injected="true"]')) return;

        const btn = createInlineButton(attendee);

        try {
          // Find the best insertion target: the element itself if it has a
          // parent, otherwise walk up to the nearest block-level container.
          let target = el;
          if (el.tagName === 'SPAN' || el.tagName === 'A' || el.tagName === 'STRONG') {
            // Inline elements: inject inside the parent block.
            const parentBlock = el.closest('li, div, tr, p') || el.parentElement;
            if (parentBlock && parentBlock !== popupEl) target = parentBlock;
          }

          // Append button at the end of the target element (most compatible
          // across GCal DOM variants; avoids breaking complex flex layouts).
          target.appendChild(btn);

          target.setAttribute('data-bpi-injected', 'true');
          injectedCount++;
        } catch (err) {
          console.warn(LOG_PREFIX, 'Failed to inject inline button:', err);
        }
      });

      if (injectedCount > 0) {
        console.log(LOG_PREFIX, `Injected ${injectedCount} inline button(s)`);
      }

      return injectedCount > 0;
    }

    /**
     * Inject a single prominent "Brief" CTA button that triggers background
     * lookups for all attendees at once. Injected once per popup, before the
     * attendee list, after any existing popup header.
     * Safe to call multiple times – guarded by [data-bpi-brief-wrap].
     *
     * @param {Element} popupEl - The event popup root element.
     * @param {Array<{name: string, email: string, company: string|null}>} attendees
     * @returns {boolean} True if the button was injected.
     */
    injectBriefButton(popupEl, attendees) {
      if (!popupEl || !(popupEl instanceof Element)) return false;
      if (!attendees || attendees.length === 0) return false;

      // Don't inject twice.
      if (popupEl.querySelector('[data-bpi-brief-wrap="true"]')) return false;

      const briefWrap = createBriefButton(attendees);

      // Preferred injection targets: attendee section, guest list, or popup root.
      const target =
        popupEl.querySelector('#xDetDlgAtt') ||
        popupEl.querySelector('[aria-label*="guest" i]') ||
        popupEl.querySelector('[aria-label*="attendee" i]') ||
        popupEl;

      try {
        target.insertBefore(briefWrap, target.firstChild);
        console.log(LOG_PREFIX, 'Brief button injected for', attendees.length, 'attendee(s)');
        return true;
      } catch (err) {
        console.warn(LOG_PREFIX, 'Failed to inject Brief button:', err);
        return false;
      }
    }

    /**
     * Remove all injected PreMeet inline buttons from a popup element.
     *
     * @param {Element} popupEl
     */
    remove(popupEl) {
      if (!popupEl) return;
      popupEl.querySelectorAll('.bpi-inline-btn').forEach((el) => el.remove());
      popupEl.querySelectorAll('.bpi-brief-btn-wrap').forEach((el) => el.remove());
      popupEl.querySelectorAll('[data-bpi-injected]').forEach((el) => {
        el.removeAttribute('data-bpi-injected');
      });
    }
  }

  // ─── Brief Button Factory ──────────────────────────────────────────────────

  /**
   * Create a prominent "Brief" CTA button that triggers background lookups
   * for ALL attendees in the event at once.
   *
   * @param {Array<{name: string, email: string, company: string|null}>} attendees
   * @returns {HTMLDivElement} Wrapper div containing the button.
   */
  function createBriefButton(attendees) {
    const wrap = document.createElement('div');
    wrap.className = 'bpi-brief-btn-wrap';
    wrap.dataset.bpiBriefWrap = 'true';

    const btn = document.createElement('button');
    btn.className = 'bpi-brief-btn';
    btn.setAttribute('type', 'button');
    btn.setAttribute(
      'title',
      `Brief all ${attendees.length} attendee${attendees.length !== 1 ? 's' : ''}`
    );
    btn.setAttribute(
      'aria-label',
      `Get professional background on all ${attendees.length} attendees`
    );

    const icon = document.createElement('span');
    icon.className = 'bpi-brief-btn__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '\u{1F4CB}'; // clipboard

    const label = document.createElement('span');
    label.textContent = 'Brief';

    const count = document.createElement('span');
    count.className = 'bpi-brief-btn__count';
    count.textContent = String(attendees.length);

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(count);
    wrap.appendChild(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleBriefClick(btn, attendees);
    });

    return wrap;
  }

  /**
   * Handle click on the "Brief" button.
   * Opens the side panel then fires FETCH_PERSON_BACKGROUND for each attendee
   * with a short stagger so the service worker isn't overwhelmed.
   *
   * @param {HTMLButtonElement} btn
   * @param {Array<{name: string, email: string, company: string|null}>} attendees
   */
  function handleBriefClick(btn, attendees) {
    if (btn.classList.contains('loading')) return;

    if (!isContextValid()) {
      console.warn(LOG_PREFIX, 'Extension context invalidated – please refresh the page.');
      return;
    }

    console.log(LOG_PREFIX, 'Brief clicked for', attendees.length, 'attendee(s)');

    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;

    try {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }, () => {
        if (chrome.runtime.lastError) {
          console.error(
            LOG_PREFIX,
            'Error opening side panel:',
            chrome.runtime.lastError.message
          );
        }

        // Fire a fetch for each attendee with 250 ms stagger.
        attendees.forEach((attendee, idx) => {
          setTimeout(() => {
            const payload = {
              name: attendee.name,
              email: attendee.email,
              company: attendee.company,
            };
            chrome.runtime.sendMessage({ type: 'FETCH_PERSON_BACKGROUND', payload }, () => {
              if (chrome.runtime.lastError) {
                console.error(
                  LOG_PREFIX,
                  'Error fetching background for',
                  attendee.email,
                  ':',
                  chrome.runtime.lastError.message
                );
              }
            });
          }, idx * 250);
        });

        // Re-enable the button after all requests are queued.
        setTimeout(() => {
          btn.classList.remove('loading');
          btn.removeAttribute('aria-busy');
          btn.disabled = false;
        }, Math.max(1500, attendees.length * 250 + 500));
      });
    } catch (err) {
      console.warn(LOG_PREFIX, 'Failed to send message (context may be invalidated):', err.message);
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  // ─── Expose to shared content-script scope ────────────────────────────────

  window.ButtonInjector = ButtonInjector;
})();
