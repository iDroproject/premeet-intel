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
  mixpanel.init(MIXPANEL_TOKEN, {
    debug: false,
    track_pageview: false,       // Chrome extension, not a web page
    persistence: 'localStorage',
    autocapture: true,
    record_sessions_percent: 100,
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
