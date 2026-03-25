// PreMeet – Structured debug/error log storage
// Stores log entries in chrome.storage.local with FIFO eviction.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: number;
  module: string;
  level: LogLevel;
  message: string;
}

const STORAGE_KEY = 'pm_debug_log';
const MAX_ENTRIES = 300;

let writeQueue: Promise<void> = Promise.resolve();

function enqueue(fn: () => Promise<void>): void {
  writeQueue = writeQueue.then(fn).catch(() => {});
}

export async function getDebugLog(): Promise<LogEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as LogEntry[] | undefined) ?? [];
}

export async function clearDebugLog(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

function addEntry(entry: LogEntry): void {
  enqueue(async () => {
    const entries = await getDebugLog();
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    await chrome.storage.local.set({ [STORAGE_KEY]: entries });
  });
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Creates a LogBuffer compatible with WaterfallOrchestrator */
export function createLogBuffer(module: string) {
  return {
    info(category: string, message: string): void {
      addEntry({ id: uid(), timestamp: Date.now(), module: `${module}:${category}`, level: 'info', message });
    },
    warn(category: string, message: string): void {
      addEntry({ id: uid(), timestamp: Date.now(), module: `${module}:${category}`, level: 'warn', message });
    },
    error(category: string, message: string): void {
      addEntry({ id: uid(), timestamp: Date.now(), module: `${module}:${category}`, level: 'error', message });
    },
  };
}

/** Simple log helper for non-waterfall modules */
export function log(module: string, level: LogLevel, message: string): void {
  addEntry({ id: uid(), timestamp: Date.now(), module, level, message });
}
