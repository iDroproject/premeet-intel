/**
 * AttendeeExtractor
 *
 * PreMeet — Extracts attendee names and emails from Google Calendar
 * event popups and detail panels using multiple fallback selector strategies.
 *
 * Loaded as a plain content script (no ES module imports).
 * The class is defined on the shared content-script scope.
 */

/* global AttendeeExtractor */

(function () {
  'use strict';

  const LOG_PREFIX = '[PreMeet][AttendeeExtractor]';

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Google Calendar status/role suffixes that appear in aria-labels and
   * text content of attendee elements. These must be stripped to get a
   * clean person name.
   *
   * Matches patterns like:
   *   "Daniel Oren, Attending, Organizer" → "Daniel Oren"
   *   "Jane Smith, Maybe"                 → "Jane Smith"
   *   "Bob Jones, Awaiting"               → "Bob Jones"
   */
  const GCAL_STATUS_SUFFIXES = /,?\s*\b(Attending|Organizer|Maybe|Tentative|Declined|Awaiting|Not responded|Accepted|No|Yes|Optional|Required|Creator|organizer|accepted|declined|tentative|needsAction)\b/gi;

  /**
   * Strip Google Calendar attendance-status and role suffixes from a name.
   *
   * @param {string} raw
   * @returns {string}
   */
  function cleanAttendeeName(raw) {
    if (!raw) return '';
    return raw
      .replace(GCAL_STATUS_SUFFIXES, '')
      .replace(/,\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

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
    const seen = new Map();
    return attendees.filter((a) => {
      const key = (a.email || a.name || '').toLowerCase();
      if (!key) return false;
      if (seen.has(key)) {
        // Preserve the first element reference on the kept entry.
        const first = seen.get(key);
        if (!first.element && a.element) first.element = a.element;
        return false;
      }
      seen.set(key, a);
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
      // GCal often appends status: "Name, Attending, Organizer" — strip it.
      let name = cleanAttendeeName(
        el.getAttribute('aria-label') ||
        el.textContent.trim() ||
        ''
      );

      if (!name || name.includes('@')) {
        name = nameFromEmail(email);
      }

      results.push({
        name: name || nameFromEmail(email),
        email,
        company: deriveCompanyFromEmail(email),
        element: el,
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
          element: section,
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
        element: link.closest('[data-hovercard-id], .xYjf6e, [jsname="haAclf"]') || link.parentElement,
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

        const name = cleanAttendeeName(
          el.querySelector('.T2tEie, .d7RUue, [jsname="r4nke"]')?.textContent.trim() ||
          el.getAttribute('aria-label') ||
          el.textContent.trim() ||
          ''
        );

        if (!email.includes('@') && !name) return;

        const resolvedEmail = email.includes('@') ? email : '';
        results.push({
          name: name || nameFromEmail(resolvedEmail),
          email: resolvedEmail,
          company: resolvedEmail ? deriveCompanyFromEmail(resolvedEmail) : null,
          element: el,
        });
      });
    });

    return results;
  }

  /**
   * Strategy 5 – Full text-node scan for email addresses.
   * Walks every text node inside the popup. When a text node contains an
   * email address we use its nearest block-level ancestor as the attendee
   * element so the "Know" button can be injected adjacent to it.
   *
   * This is the most resilient strategy: it works regardless of GCal class
   * names or data-attribute schemes because it operates on visible text.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null, element: Element}>}
   */
  function extractViaTextScan(root) {
    const results = [];
    const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let textNode;

    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent || '';
      const matches = text.match(emailRe);
      if (!matches) continue;

      matches.forEach((email) => {
        if (!email.includes('@')) return;

        // Walk up to the nearest block-level or list element that bounds
        // this attendee row, so the button is inserted next to the chip.
        let el = textNode.parentElement;
        const BLOCK = new Set(['LI', 'TR', 'DIV', 'SPAN', 'P', 'ARTICLE', 'SECTION']);
        while (el && el !== root && !BLOCK.has(el.tagName)) {
          el = el.parentElement;
        }
        if (!el || el === root) el = textNode.parentElement;

        // Try to pull a display name from aria-label or nearby text.
        let name = cleanAttendeeName(
          el.getAttribute('aria-label') || ''
        );

        // If aria-label didn't give a clean name, look at the element's full
        // text and strip the email to see if there's a residual name.
        if (!name || name.includes('@')) {
          const fullText = (el.innerText || el.textContent || '')
            .replace(email, '')
            .replace(/,\s*$/, '')
            .trim();
          name = cleanAttendeeName(fullText);
        }

        if (!name || name.includes('@')) {
          name = nameFromEmail(email);
        }

        results.push({
          name,
          email,
          company: deriveCompanyFromEmail(email),
          element: el,
        });
      });
    }

    return results;
  }

  /**
   * Strategy 6 – Scan elements near "X guests" text.
   * Finds the section of the popup that mentions guest count and scans
   * all descendant leaf elements for names / emails.
   *
   * @param {Element} root
   * @returns {Array<{name: string, email: string, company: string|null, element: Element}>}
   */
  function extractViaGuestSection(root) {
    const results = [];
    const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

    // Find the element whose text contains "X guest(s)" or "Guests".
    const guestHeaderEl = Array.from(root.querySelectorAll('*')).find((el) => {
      if (el.children.length > 5) return false; // Skip large containers
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return /^\d+\s+guests?$/.test(t) || t === 'guests' || t === 'guest';
    });

    if (!guestHeaderEl) return results;

    // The guest list is typically a sibling or nearby ancestor's child.
    const guestSection =
      guestHeaderEl.closest('[aria-label*="guest" i], [aria-label*="attendee" i]') ||
      guestHeaderEl.parentElement?.parentElement;

    if (!guestSection || guestSection === root) return results;

    // Walk all leaf elements in the guest section.
    guestSection.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 0) return; // Leaf elements only
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) return;

      if (emailRe.test(text)) {
        const email = text.match(emailRe)[0];
        results.push({
          name: nameFromEmail(email),
          email,
          company: deriveCompanyFromEmail(email),
          element: el.parentElement || el,
        });
      } else if (text.length > 1 && text.length < 60 && !text.match(/^\d+$/) && text !== 'Organizer') {
        // Might be a display name with no visible email – still capture so
        // we can show a button (email will be blank, button shows the name).
        const ariaEmail =
          el.getAttribute('data-email') ||
          el.getAttribute('data-hovercard-id')?.replace(/^contact:/, '') ||
          '';
        if (ariaEmail.includes('@')) {
          results.push({
            name: cleanAttendeeName(text),
            email: ariaEmail,
            company: deriveCompanyFromEmail(ariaEmail),
            element: el.parentElement || el,
          });
        }
      }
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
        { name: 'guestSection',   fn: extractViaGuestSection },
        { name: 'textScan',       fn: extractViaTextScan },
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
  window.PreMeet = window.PreMeet || {};
  window.PreMeet.nameFromEmail = nameFromEmail;
  window.PreMeet.deriveCompanyFromEmail = deriveCompanyFromEmail;
  window.PreMeet.cleanAttendeeName = cleanAttendeeName;
})();
