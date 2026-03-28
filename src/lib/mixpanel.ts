// PreMeet — Mixpanel Analytics
// Thin wrapper around mixpanel-browser for use in popup and side panel contexts.
// The background service worker cannot use this (no DOM). Instead, background
// events are tracked when their result messages arrive in the UI contexts.

import mixpanel from 'mixpanel-browser';

const MIXPANEL_TOKEN = '5224be73e82e9c29132ac3dc4908d366';
let initialized = false;

/**
 * Initialize Mixpanel. Safe to call multiple times — only inits once.
 */
export function initMixpanel(): void {
  if (initialized) return;

  // Clear stale batch-queue entries from localStorage left over from previous
  // configs (batch_requests was previously true). Corrupted queue data causes
  // the SDK to send empty payloads → "data, missing or empty" errors.
  const queuePrefix = `__mpq_${MIXPANEL_TOKEN}`;
  for (const suffix of ['_ev', '_pp', '_gr']) {
    try { localStorage.removeItem(queuePrefix + suffix); } catch (_) { /* extension storage quirks */ }
  }

  mixpanel.init(MIXPANEL_TOKEN, {
    debug: false,
    track_pageview: false,       // Chrome extension, not a web page
    persistence: 'localStorage',
    autocapture: false,          // Autocapture events (clicks, scrolls) are not meaningful in extension pages
    record_sessions_percent: 0,  // Session recording does not work reliably in Chrome extension contexts
    batch_requests: false,       // Send events immediately — avoids batch-queue timing issues in extension lifecycle
    ip: false,                   // Extension pages don't have meaningful IP context
    ignore_dnt: true,            // Extension analytics should not be blocked by browser DNT settings
  });
  initialized = true;
}

/**
 * Identify the current user after sign-in or on page load when already authenticated.
 */
export function identifyUser(user: {
  id: string;
  email: string;
  name: string | null;
  tier: 'free' | 'pro';
}): void {
  if (!initialized) return;
  mixpanel.identify(user.id);
  mixpanel.people.set({
    $name: user.name || user.email,
    $email: user.email,
    plan_type: user.tier,
  });
}

/**
 * Reset identity on sign-out.
 */
export function resetUser(): void {
  if (!initialized) return;
  mixpanel.reset();
}

/**
 * Track an event with optional properties.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  mixpanel.track(event, properties);
}
