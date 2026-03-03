/**
 * AttendeeExtractor
 *
 * Bright People Intel — Extracts attendee names and emails from Google Calendar
 * event popups and detail panels using multiple fallback selector strategies.
 *
 * Loaded as a plain content script (no ES module imports).
 * The class is defined on the shared content-script scope.
 */

/* global AttendeeExtractor */

(function () {
  'use strict';

  const LOG_PREFIX = '[BPI][AttendeeExtractor]';

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Derive a best-effort display name from an email local-part.
   * "john.doe@example.com" → "John Doe"
   *
   * @param {string} email
   * @returns {string}
   */
  function nameFromEmail(email) {
    if (!email || !email.includes('@')) return email || '';
    const local = email.split('@')[0];
    return local
      .replace(/[._+\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Extract company name from an email domain.
   * Returns null for free providers (gmail, yahoo, hotmail, outlook, etc.).
   *
   * @param {string} email
   * @returns {string|null}
   */
  function deriveCompanyFromEmail(email) {
    if (!email || !email.includes('@')) return null;

    const FREE_PROVIDERS = new Set([
      'gmail.com',
      'googlemail.com',
      'yahoo.com',
      'yahoo.co.uk',
      'yahoo.co.in',
      'hotmail.com',
      'hotmail.co.uk',
      'outlook.com',
      'outlook.co.uk',
      'live.com',
      'msn.com',
      'icloud.com',
      'me.com',
      'mac.com',
      'aol.com',
      'protonmail.com',
      'proton.me',
      'tutanota.com',
      'zoho.com',
    ]);

    const domain = email.split('@')[1].toLowerCase();
    if (FREE_PROVIDERS.has(domain)) return null;

    // Strip common TLDs and sub-domains to get a human-readable company name.
    // e.g. "mail.acme.com" → "acme", "stripe.com" → "stripe"
    const parts = domain.split('.');
    const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return root.charAt(0).toUpperCase() + root.slice(1);
  }

  /**
   * Normalise and de-duplicate a raw attendee array.
   *
   * @param {Array<{name: string, email: string, company: string|null}>} attendees
   * @returns {Array<{name: string, email: string, company: string|null}>}
   */
  function deduplicateAttendees(attendees) {
    const seen = new Set();
    return attendees.filter((a) => {
      const key = (a.email || a.name || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ─── Selector Strategies ────────────────────────────────────────────────────

  /**
   * Strategy 1 – data-email / data-hovercard-id attributes.
   * Google Calendar frequently embeds the email directly as a data attribute.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null}>}
   */
  function extractViaDataAttributes(root) {
    const results = [];
    const candidates = root.querySelectorAll('[data-email], [data-hovercard-id]');

    candidates.forEach((el) => {
      const email =
        el.dataset.email ||
        // hovercard-id is often "contact:user@example.com"
        (el.dataset.hovercardId || '').replace(/^contact:/, '');

      if (!email || !email.includes('@')) return;

      // Prefer aria-label (often the full name), then textContent.
      // If the resolved text looks like an email address, derive a
      // human-readable name from the local part instead.
      let name =
        el.getAttribute('aria-label') ||
        el.textContent.trim() ||
        '';

      if (!name || name.includes('@')) {
        name = nameFromEmail(email);
      }

      results.push({
        name: name || nameFromEmail(email),
        email,
        company: deriveCompanyFromEmail(email),
      });
    });

    return results;
  }

  /**
   * Strategy 2 – ARIA guest / attendee sections.
   * Look for labelled sections that describe guests or attendees.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null}>}
   */
  function extractViaAriaLabels(root) {
    const results = [];

    // Find sections labelled as guests or attendees.
    const guestSections = root.querySelectorAll(
      '[aria-label*="guest" i], [aria-label*="attendee" i], [aria-label*="invited" i]'
    );

    guestSections.forEach((section) => {
      // Inside the section look for text that looks like an email.
      const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      const text = section.innerText || section.textContent || '';
      const matches = text.match(emailPattern) || [];

      matches.forEach((email) => {
        results.push({
          name: nameFromEmail(email),
          email,
          company: deriveCompanyFromEmail(email),
        });
      });

      // Also look for child elements with legible names adjacent to emails.
      const nameEls = section.querySelectorAll('[data-name], .attendee-name, .guest-name');
      nameEls.forEach((el) => {
        const name = el.dataset.name || el.textContent.trim();
        if (name) {
          // Try to pair with an email already found.
          const paired = results.find((r) => !r.name || r.name === nameFromEmail(r.email));
          if (paired) paired.name = name;
        }
      });
    });

    return results;
  }

  /**
   * Strategy 3 – mailto: anchor links.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null}>}
   */
  function extractViaMailtoLinks(root) {
    const results = [];
    const links = root.querySelectorAll('a[href^="mailto:"]');

    links.forEach((link) => {
      const email = link.href.replace('mailto:', '').split('?')[0].trim();
      if (!email || !email.includes('@')) return;

      let name = link.textContent.trim();
      // If the link text is the email itself, derive a readable name.
      if (!name || name.includes('@')) {
        name = nameFromEmail(email);
      }

      results.push({
        name: name || nameFromEmail(email),
        email,
        company: deriveCompanyFromEmail(email),
      });
    });

    return results;
  }

  /**
   * Strategy 4 – Known Google Calendar class patterns.
   * These class names change over time; update as needed.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null}>}
   */
  function extractViaKnownClasses(root) {
    const results = [];

    // Selector list of known GCal guest/attendee item containers.
    // The class .PoMeXc is a known attendee chip; others are observed variants.
    const ATTENDEE_SELECTORS = [
      '.PoMeXc',        // Event popup guest chip
      '.PKKqje',        // Alternate attendee chip class
      '.xYjf6e',        // Guest list item
      '[jsname="ESCLMb"]', // Guest list container children
      '[jsname="haAclf"]', // Another observed attendee element
    ];

    ATTENDEE_SELECTORS.forEach((selector) => {
      root.querySelectorAll(selector).forEach((el) => {
        // Email is often in a title, data-email, or tooltip attribute.
        const email =
          el.dataset.email ||
          el.getAttribute('title') ||
          el.getAttribute('data-tooltip') ||
          '';

        const name =
          el.querySelector('.T2tEie, .d7RUue, [jsname="r4nke"]')?.textContent.trim() ||
          el.getAttribute('aria-label') ||
          el.textContent.trim() ||
          '';

        if (!email.includes('@') && !name) return;

        const resolvedEmail = email.includes('@') ? email : '';
        results.push({
          name: name || nameFromEmail(resolvedEmail),
          email: resolvedEmail,
          company: resolvedEmail ? deriveCompanyFromEmail(resolvedEmail) : null,
        });
      });
    });

    return results;
  }

  // ─── Class Definition ───────────────────────────────────────────────────────

  /**
   * AttendeeExtractor
   * Runs all extraction strategies against an event popup element and merges
   * the results into a de-duplicated attendee list.
   */
  class AttendeeExtractor {
    /**
     * Extract attendees from an event popup or detail panel.
     *
     * @param {Element} popupEl - Root element of the event popup / dialog.
     * @returns {Array<{name: string, email: string, company: string|null}>}
     */
    extract(popupEl) {
      if (!popupEl || !(popupEl instanceof Element)) {
        console.warn(LOG_PREFIX, 'extract() called with invalid element');
        return [];
      }

      const strategies = [
        { name: 'dataAttributes', fn: extractViaDataAttributes },
        { name: 'ariaLabels',     fn: extractViaAriaLabels },
        { name: 'mailtoLinks',    fn: extractViaMailtoLinks },
        { name: 'knownClasses',   fn: extractViaKnownClasses },
      ];

      const all = [];

      strategies.forEach(({ name, fn }) => {
        try {
          const found = fn(popupEl);
          if (found.length > 0) {
            console.log(LOG_PREFIX, `Strategy "${name}" found ${found.length} attendee(s)`);
          }
          all.push(...found);
        } catch (err) {
          console.warn(LOG_PREFIX, `Strategy "${name}" threw:`, err);
        }
      });

      const deduped = deduplicateAttendees(all);
      console.log(LOG_PREFIX, `Extracted ${deduped.length} unique attendee(s) from popup`);
      return deduped;
    }
  }

  // Expose to shared content-script scope.
  window.AttendeeExtractor = AttendeeExtractor;
  window.BrightPeopleIntel = window.BrightPeopleIntel || {};
  window.BrightPeopleIntel.nameFromEmail = nameFromEmail;
  window.BrightPeopleIntel.deriveCompanyFromEmail = deriveCompanyFromEmail;
})();
