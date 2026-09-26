// PreMeet – Chrome Storage Cache with TTL + LRU Eviction

const LOG_PREFIX = '[PreMeet][Cache]';

const KEY_PREFIX = 'pm_';
const MAX_ENTRIES = 300;
// chrome.storage.local has a ~10MB quota shared with auth tokens/settings; keep
// the enrichment cache well under it so a run of large profiles can't exhaust it.
const MAX_CACHE_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const INDEX_KEY = `${KEY_PREFIX}_index`;

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
  createdAt: number;
  lastUsed: number;
}

interface IndexEntry {
  key: string;
  createdAt: number;
  lastUsed: number;
}

export interface CacheStats {
  count: number;
  expiredCount: number;
  sizeBytesEst: number;
}

export class CacheManager {
  // Serialize every index read-modify-write through one promise chain so
  // concurrent set()/get() calls (auto-search runs attendees in parallel) can't
  // clobber each other's index updates and leave orphaned storage entries that
  // never get evicted.
  private _indexOp: Promise<void> = Promise.resolve();

  private queueIndexOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._indexOp.then(fn, fn);
    // Keep the chain alive even if an op rejects.
    this._indexOp = run.then(() => undefined, () => undefined);
    return run;
  }

  private storageKey(key: string): string {
    if (key.startsWith(KEY_PREFIX)) return key;
    return `${KEY_PREFIX}${key}`;
  }

  private async readIndex(): Promise<IndexEntry[]> {
    const result = await chrome.storage.local.get(INDEX_KEY);
    const index = result[INDEX_KEY];
    return Array.isArray(index) ? index : [];
  }

  private async writeIndex(index: IndexEntry[]): Promise<void> {
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }

  private upsertIndex(key: string, createdAt: number, lastUsed: number): Promise<void> {
    return this.queueIndexOp(async () => {
      const index = await this.readIndex();
      const existingIdx = index.findIndex((e) => e.key === key);
      if (existingIdx >= 0) {
        index[existingIdx].lastUsed = lastUsed;
        index[existingIdx].createdAt = createdAt;
      } else {
        index.push({ key, createdAt, lastUsed });
      }
      await this.writeIndex(index);
    });
  }

  private removeFromIndex(key: string): Promise<void> {
    return this.queueIndexOp(async () => {
      const index = await this.readIndex();
      await this.writeIndex(index.filter((e) => e.key !== key));
    });
  }

  private evictIfNeeded(): Promise<void> {
    return this.queueIndexOp(async () => {
      let index = await this.readIndex();

      // 1. Count-based cap.
      if (index.length > MAX_ENTRIES) {
        const sorted = [...index].sort((a, b) => a.lastUsed - b.lastUsed);
        const toEvict = sorted.slice(0, index.length - MAX_ENTRIES);
        await chrome.storage.local.remove(toEvict.map((e) => this.storageKey(e.key)));
        index = sorted.slice(index.length - MAX_ENTRIES);
        await this.writeIndex(index);
        console.log(LOG_PREFIX, `LRU eviction (count) removed ${toEvict.length} entries`);
      }

      // 2. Size-based cap: evict least-recently-used until under the byte budget.
      try {
        let used = await chrome.storage.local.getBytesInUse(null);
        if (used > MAX_CACHE_BYTES && index.length > 1) {
          const sorted = [...index].sort((a, b) => a.lastUsed - b.lastUsed);
          const evicted = new Set<string>();
          while (used > MAX_CACHE_BYTES && sorted.length > 1) {
            const victim = sorted.shift()!;
            const vk = this.storageKey(victim.key);
            const vBytes = await chrome.storage.local.getBytesInUse(vk);
            await chrome.storage.local.remove(vk);
            evicted.add(victim.key);
            used -= vBytes;
          }
          if (evicted.size > 0) {
            await this.writeIndex(index.filter((e) => !evicted.has(e.key)));
            console.log(LOG_PREFIX, `LRU eviction (size) removed ${evicted.size} entries`);
          }
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Size-based eviction check failed:', (err as Error).message);
      }
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const sk = this.storageKey(key);

    let result: Record<string, CacheEntry<T>>;
    try {
      result = await chrome.storage.local.get(sk);
    } catch (err) {
      console.error(LOG_PREFIX, `get("${key}") storage error:`, (err as Error).message);
      return null;
    }

    const entry = result[sk];
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      console.log(LOG_PREFIX, `Cache miss (expired): ${key}`);
      this.remove(key).catch(() => {});
      return null;
    }

    console.log(LOG_PREFIX, `Cache hit: ${key}`);
    const now = Date.now();
    this.upsertIndex(key, entry.createdAt, now).catch(() => {});
    return entry.data;
  }

  async set(key: string, data: unknown, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
    const sk = this.storageKey(key);
    const now = Date.now();

    const entry: CacheEntry = {
      data,
      expiresAt: now + ttlMs,
      createdAt: now,
      lastUsed: now,
    };

    try {
      await chrome.storage.local.set({ [sk]: entry });
    } catch (err) {
      console.error(LOG_PREFIX, `set("${key}") storage error:`, (err as Error).message);
      throw err;
    }

    await this.upsertIndex(key, now, now);
    await this.evictIfNeeded();

    console.log(LOG_PREFIX, `Cached "${key}" (TTL: ${(ttlMs / 3600000).toFixed(1)} h)`);
  }

  async has(key: string): Promise<boolean> {
    const sk = this.storageKey(key);

    let result: Record<string, CacheEntry>;
    try {
      result = await chrome.storage.local.get(sk);
    } catch (err) {
      console.error(LOG_PREFIX, `has("${key}") storage error:`, (err as Error).message);
      return false;
    }

    const entry = result[sk];
    if (!entry) return false;
    return Date.now() <= entry.expiresAt;
  }

  async remove(key: string): Promise<void> {
    const sk = this.storageKey(key);
    try {
      await chrome.storage.local.remove(sk);
      await this.removeFromIndex(key);
      console.log(LOG_PREFIX, `Removed cache entry: ${key}`);
    } catch (err) {
      console.error(LOG_PREFIX, `remove("${key}") error:`, (err as Error).message);
    }
  }

  async clear(): Promise<void> {
    const index = await this.readIndex();
    const storageKeys = [INDEX_KEY, ...index.map((e) => this.storageKey(e.key))];
    try {
      await chrome.storage.local.remove(storageKeys);
      console.log(LOG_PREFIX, `Cleared ${index.length} cache entries`);
    } catch (err) {
      console.error(LOG_PREFIX, 'clear() error:', (err as Error).message);
      throw err;
    }
  }

  async getStats(): Promise<CacheStats> {
    const index = await this.readIndex();
    if (index.length === 0) return { count: 0, expiredCount: 0, sizeBytesEst: 0 };

    const storageKeys = index.map((e) => this.storageKey(e.key));

    let result: Record<string, CacheEntry>;
    try {
      result = await chrome.storage.local.get(storageKeys);
    } catch (err) {
      console.error(LOG_PREFIX, 'getStats() storage error:', (err as Error).message);
      return { count: 0, expiredCount: 0, sizeBytesEst: 0 };
    }

    const now = Date.now();
    let count = 0;
    let expiredCount = 0;
    let sizeBytesEst = 0;

    for (const [, entry] of Object.entries(result)) {
      if (!entry) continue;
      try {
        sizeBytesEst += JSON.stringify(entry).length;
      } catch {
        // Non-serialisable value; skip size contribution.
      }
      if (now > entry.expiresAt) {
        expiredCount++;
      } else {
        count++;
      }
    }

    return { count, expiredCount, sizeBytesEst };
  }
}
