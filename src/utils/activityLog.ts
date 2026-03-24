// PreMeet activity log
// Stores enrichment history in chrome.storage.local with FIFO eviction at 500 entries.

import type { ActivityLogEntry } from '../types';

const STORAGE_KEY = 'pm_activity_log';
const MAX_ENTRIES = 500;

export async function getActivityLog(): Promise<ActivityLogEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as ActivityLogEntry[] | undefined) ?? [];
}

export async function addLogEntry(entry: ActivityLogEntry): Promise<void> {
  const entries = await getActivityLog();
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

export async function clearActivityLog(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
