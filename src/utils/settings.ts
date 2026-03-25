// PreMeet settings manager
// Stores user preferences in chrome.storage.sync for cross-device sync.
// Migrates from chrome.storage.local on first load.

import type { Settings, TriggerMode, CacheDuration } from '../types';

const STORAGE_KEY = 'pm_settings';
const MIGRATED_KEY = 'pm_settings_migrated';

const DEFAULT_SETTINGS: Settings = {
  triggerMode: 'auto',
  cacheDuration: '7d',
  showConfidenceScores: true,
  compactMode: false,
  autoSearchAttendees: false,
};

export function getDefaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS };
}

/** Read settings from chrome.storage.sync, migrating from local if needed. */
export async function getSettings(): Promise<Settings> {
  await migrateIfNeeded();

  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  if (!stored) return getDefaultSettings();

  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Persist a partial settings update to chrome.storage.sync. */
export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const updated: Settings = { ...current, ...partial };
  await chrome.storage.sync.set({ [STORAGE_KEY]: updated });
  return updated;
}

/** One-time migration from chrome.storage.local to chrome.storage.sync. */
async function migrateIfNeeded(): Promise<void> {
  const flag = await chrome.storage.sync.get(MIGRATED_KEY);
  if (flag[MIGRATED_KEY]) return;

  const local = await chrome.storage.local.get(STORAGE_KEY);
  if (local[STORAGE_KEY]) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: local[STORAGE_KEY] });
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  await chrome.storage.sync.set({ [MIGRATED_KEY]: true });
}

/** Map cache duration setting to milliseconds (0 = no caching). */
export function cacheDurationMs(duration: CacheDuration): number {
  switch (duration) {
    case '1d':    return 1 * 24 * 60 * 60 * 1000;
    case '7d':    return 7 * 24 * 60 * 60 * 1000;
    case '30d':   return 30 * 24 * 60 * 60 * 1000;
    case 'never': return 0;
  }
}
