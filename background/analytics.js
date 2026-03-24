/**
 * background/analytics.js
 *
 * PreMeet – Lightweight Local Analytics
 *
 * Tracks usage events as local counters in chrome.storage.local.
 * No data is sent externally — all metrics stay on-device.
 *
 * Storage key: 'pm__analytics'
 * Shape: { events: { [eventName]: { count, firstAt, lastAt } }, installedAt }
 */

'use strict';

const ANALYTICS_KEY = 'pm__analytics';

/**
 * Known event names.
 * @enum {string}
 */
export const AnalyticsEvent = /** @type {const} */ ({
  EXTENSION_INSTALLED: 'extension_installed',
  BRIEF_REQUESTED:     'brief_requested',
  BRIEF_COMPLETED:     'brief_completed',
  BRIEF_ERROR:         'brief_error',
});

/**
 * Record an analytics event. Increments the counter and updates timestamps.
 *
 * @param {string} eventName - One of AnalyticsEvent values.
 * @returns {Promise<void>}
 */
export async function trackEvent(eventName) {
  try {
    const stored = await chrome.storage.local.get(ANALYTICS_KEY);
    const analytics = stored[ANALYTICS_KEY] || { events: {}, installedAt: null };

    const now = new Date().toISOString();
    const existing = analytics.events[eventName] || { count: 0, firstAt: now, lastAt: now };

    existing.count += 1;
    existing.lastAt = now;
    analytics.events[eventName] = existing;

    await chrome.storage.local.set({ [ANALYTICS_KEY]: analytics });
  } catch (err) {
    // Analytics should never break the extension.
    console.warn('[PreMeet][Analytics]', 'Failed to track event:', eventName, err.message);
  }
}

/**
 * Mark the install timestamp (idempotent — only sets once).
 *
 * @returns {Promise<void>}
 */
export async function markInstalled() {
  try {
    const stored = await chrome.storage.local.get(ANALYTICS_KEY);
    const analytics = stored[ANALYTICS_KEY] || { events: {}, installedAt: null };

    if (!analytics.installedAt) {
      analytics.installedAt = new Date().toISOString();
      await chrome.storage.local.set({ [ANALYTICS_KEY]: analytics });
    }
  } catch (err) {
    console.warn('[PreMeet][Analytics]', 'Failed to mark install:', err.message);
  }
}

/**
 * Get all analytics data for display in the popup.
 *
 * @returns {Promise<{ events: Record<string, { count: number, firstAt: string, lastAt: string }>, installedAt: string|null }>}
 */
export async function getAnalytics() {
  try {
    const stored = await chrome.storage.local.get(ANALYTICS_KEY);
    return stored[ANALYTICS_KEY] || { events: {}, installedAt: null };
  } catch (err) {
    console.warn('[PreMeet][Analytics]', 'Failed to read analytics:', err.message);
    return { events: {}, installedAt: null };
  }
}
