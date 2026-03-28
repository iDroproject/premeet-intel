// PreMeet — Client-side daily rate limit
// Soft gate for fair use: limits searches per day via chrome.storage.local.
// Not a billing wall — just prevents accidental abuse while we're pre-auth.

const STORAGE_KEY = 'pm_daily_searches';
const DAILY_LIMIT = 50;

interface DailyCounter {
  date: string; // YYYY-MM-DD
  count: number;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getCounter(): Promise<DailyCounter> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const counter: DailyCounter = result[STORAGE_KEY] ?? { date: todayStr(), count: 0 };

  // Reset if new day
  if (counter.date !== todayStr()) {
    return { date: todayStr(), count: 0 };
  }

  return counter;
}

/** Returns true if the user has remaining daily searches. */
export async function hasSearchQuota(): Promise<boolean> {
  const counter = await getCounter();
  return counter.count < DAILY_LIMIT;
}

/** Increment the daily search counter. Returns the updated count. */
export async function useSearchQuota(): Promise<number> {
  const counter = await getCounter();
  const updated: DailyCounter = { date: todayStr(), count: counter.count + 1 };
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated.count;
}

/** Returns { used, limit, remaining } for display. */
export async function getSearchQuota(): Promise<{ used: number; limit: number; remaining: number }> {
  const counter = await getCounter();
  return {
    used: counter.count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - counter.count),
  };
}
