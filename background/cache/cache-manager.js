/**
 * background/cache/cache-manager.js
 *
 * Meeting Intel – Chrome Storage Cache with TTL + LRU Eviction
 *
 * Wraps chrome.storage.local to provide a simple key/value cache with:
 *   - Per-entry TTL (default 7 days).
 *   - LRU eviction when the entry count exceeds MAX_ENTRIES (500).
 *   - Namespace prefix (`mi_`) to avoid key collisions with other extensions.
 *   - Size estimation via JSON serialisation length.
 *
 * All methods are async and use Promises (no callbacks).
 *
 * Usage:
 *   const cache = new CacheManager();
 *   await cache.set('person_jane_doe', data, 7 * 24 * 60 * 60 * 1000);
 *   const cached = await cache.get('person_jane_doe');
 *
 * @module cache-manager
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][Cache]';

// ─── Constants ───────────────────────────────────────────────────────────────

/** All keys written by this manager are prefixed to avoid collisions. */
const KEY_PREFIX = 'mi_';

/**
 * Maximum number of cache entries before LRU eviction runs.
 * @type {number}
 */
const MAX_ENTRIES = 500;

/**
 * Default TTL: 7 days in milliseconds.
 * @type {number}
 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A special storage key that holds the index (ordered list of cache keys
 * with metadata used for LRU eviction).
 * @type {string}
 */
const INDEX_KEY = `${KEY_PREFIX}_index`;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CacheEntry
 * @property {*}      data       The stored value.
 * @property {number} expiresAt  Unix timestamp (ms) after which this entry
 *                               is considered stale.
 * @property {number} createdAt  Unix timestamp (ms) when the entry was stored.
 * @property {number} lastUsed   Unix timestamp (ms) of the most recent get().
 */

/**
 * @typedef {Object} IndexEntry
 * @property {string} key        Storage key (without KEY_PREFIX).
 * @property {number} createdAt  Unix timestamp (ms).
 * @property {number} lastUsed   Unix timestamp (ms).
 */

/**
 * @typedef {Object} CacheStats
 * @property {number} count          Number of valid (non-expired) entries.
 * @property {number} expiredCount   Number of expired entries still in storage.
 * @property {number} sizeBytesEst   Estimated total storage size in bytes.
 */

// ─── CacheManager Class ───────────────────────────────────────────────────────

export class CacheManager {

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Prefix a logical key with KEY_PREFIX for use in chrome.storage.local.
   *
   * @param {string} key  Logical cache key.
   * @returns {string}    Prefixed storage key.
   */
  #storageKey(key) {
    // Avoid double-prefixing if the caller already includes the prefix.
    if (key.startsWith(KEY_PREFIX)) return key;
    return `${KEY_PREFIX}${key}`;
  }

  /**
   * Read the LRU index from storage.
   *
   * @returns {Promise<IndexEntry[]>}
   */
  async #readIndex() {
    const result = await chrome.storage.local.get(INDEX_KEY);
    const index  = result[INDEX_KEY];
    return Array.isArray(index) ? index : [];
  }

  /**
   * Persist the LRU index to storage.
   *
   * @param {IndexEntry[]} index
   * @returns {Promise<void>}
   */
  async #writeIndex(index) {
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }

  /**
   * Update the index when a key is written or accessed.
   * Inserts a new entry or updates `lastUsed` for an existing one.
   *
   * @param {string} key        Logical (un-prefixed) key.
   * @param {number} createdAt  Timestamp of creation.
   * @param {number} lastUsed   Timestamp of last access.
   * @returns {Promise<void>}
   */
  async #upsertIndex(key, createdAt, lastUsed) {
    const index = await this.#readIndex();
    const existingIdx = index.findIndex((e) => e.key === key);

    if (existingIdx >= 0) {
      index[existingIdx].lastUsed = lastUsed;
      index[existingIdx].createdAt = createdAt;
    } else {
      index.push({ key, createdAt, lastUsed });
    }

    await this.#writeIndex(index);
  }

  /**
   * Remove a key from the LRU index.
   *
   * @param {string} key  Logical (un-prefixed) key.
   * @returns {Promise<void>}
   */
  async #removeFromIndex(key) {
    const index    = await this.#readIndex();
    const filtered = index.filter((e) => e.key !== key);
    await this.#writeIndex(filtered);
  }

  /**
   * Evict the oldest entries (by `lastUsed`) until the entry count is at or
   * below MAX_ENTRIES.
   *
   * @returns {Promise<void>}
   */
  async #evictIfNeeded() {
    const index = await this.#readIndex();

    if (index.length <= MAX_ENTRIES) return;

    // Sort ascending by lastUsed so oldest entries come first.
    const sorted   = [...index].sort((a, b) => a.lastUsed - b.lastUsed);
    const toEvict  = sorted.slice(0, index.length - MAX_ENTRIES);
    const toKeep   = sorted.slice(index.length - MAX_ENTRIES);

    const evictStorageKeys = toEvict.map((e) => this.#storageKey(e.key));
    await chrome.storage.local.remove(evictStorageKeys);
    await this.#writeIndex(toKeep);

    console.log(LOG_PREFIX, `LRU eviction removed ${toEvict.length} entries`);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Retrieve a cached value by key.
   *
   * Returns `null` if the key does not exist or if the entry has expired.
   * Updates `lastUsed` on a cache hit to maintain LRU ordering.
   *
   * @param {string} key  Logical cache key.
   * @returns {Promise<*|null>}
   */
  async get(key) {
    const storageKey = this.#storageKey(key);

    let result;
    try {
      result = await chrome.storage.local.get(storageKey);
    } catch (err) {
      console.error(LOG_PREFIX, `get("${key}") storage error:`, err.message);
      return null;
    }

    /** @type {CacheEntry|undefined} */
    const entry = result[storageKey];

    if (!entry) return null;

    // Check TTL.
    if (Date.now() > entry.expiresAt) {
      console.log(LOG_PREFIX, `Cache miss (expired): ${key}`);
      // Lazy-delete the stale entry.
      this.remove(key).catch(() => {});
      return null;
    }

    console.log(LOG_PREFIX, `Cache hit: ${key}`);

    // Update lastUsed in the index (fire-and-forget; don't block the caller).
    const now = Date.now();
    this.#upsertIndex(key, entry.createdAt, now).catch(() => {});

    return entry.data;
  }

  /**
   * Store a value under the given key with an optional TTL.
   *
   * @param {string} key        Logical cache key.
   * @param {*}      data       Value to cache. Must be JSON-serialisable.
   * @param {number} [ttlMs]    Time-to-live in milliseconds. Defaults to 7 days.
   * @returns {Promise<void>}
   */
  async set(key, data, ttlMs = DEFAULT_TTL_MS) {
    const storageKey = this.#storageKey(key);
    const now        = Date.now();

    /** @type {CacheEntry} */
    const entry = {
      data,
      expiresAt: now + ttlMs,
      createdAt: now,
      lastUsed:  now,
    };

    try {
      await chrome.storage.local.set({ [storageKey]: entry });
    } catch (err) {
      console.error(LOG_PREFIX, `set("${key}") storage error:`, err.message);
      throw err;
    }

    await this.#upsertIndex(key, now, now);
    await this.#evictIfNeeded();

    console.log(
      LOG_PREFIX,
      `Cached "${key}" (TTL: ${Math.round(ttlMs / 3600000).toFixed(1)} h)`
    );
  }

  /**
   * Check whether a valid (non-expired) entry exists for the given key.
   *
   * Unlike `get()`, this does NOT update `lastUsed`.
   *
   * @param {string} key  Logical cache key.
   * @returns {Promise<boolean>}
   */
  async has(key) {
    const storageKey = this.#storageKey(key);

    let result;
    try {
      result = await chrome.storage.local.get(storageKey);
    } catch (err) {
      console.error(LOG_PREFIX, `has("${key}") storage error:`, err.message);
      return false;
    }

    const entry = result[storageKey];
    if (!entry) return false;

    return Date.now() <= entry.expiresAt;
  }

  /**
   * Delete an entry from the cache by key.
   *
   * Silently succeeds if the key does not exist.
   *
   * @param {string} key  Logical cache key.
   * @returns {Promise<void>}
   */
  async remove(key) {
    const storageKey = this.#storageKey(key);

    try {
      await chrome.storage.local.remove(storageKey);
      await this.#removeFromIndex(key);
      console.log(LOG_PREFIX, `Removed cache entry: ${key}`);
    } catch (err) {
      console.error(LOG_PREFIX, `remove("${key}") error:`, err.message);
    }
  }

  /**
   * Clear all cache entries managed by this instance (keys prefixed with
   * KEY_PREFIX) without affecting unrelated extension storage.
   *
   * @returns {Promise<void>}
   */
  async clear() {
    const index = await this.#readIndex();
    const storageKeys = [
      INDEX_KEY,
      ...index.map((e) => this.#storageKey(e.key)),
    ];

    try {
      await chrome.storage.local.remove(storageKeys);
      console.log(LOG_PREFIX, `Cleared ${index.length} cache entries`);
    } catch (err) {
      console.error(LOG_PREFIX, 'clear() error:', err.message);
      throw err;
    }
  }

  /**
   * Return statistics about the current cache state.
   *
   * Size estimation: JSON.stringify each entry and measure character count
   * (approximately 1 byte per character for ASCII/Latin content).
   *
   * @returns {Promise<CacheStats>}
   */
  async getStats() {
    const index = await this.#readIndex();

    if (index.length === 0) {
      return { count: 0, expiredCount: 0, sizeBytesEst: 0 };
    }

    const storageKeys = index.map((e) => this.#storageKey(e.key));
    let result;

    try {
      result = await chrome.storage.local.get(storageKeys);
    } catch (err) {
      console.error(LOG_PREFIX, 'getStats() storage error:', err.message);
      return { count: 0, expiredCount: 0, sizeBytesEst: 0 };
    }

    const now = Date.now();
    let count        = 0;
    let expiredCount = 0;
    let sizeBytesEst = 0;

    for (const [, entry] of Object.entries(result)) {
      if (!entry) continue;

      try {
        sizeBytesEst += JSON.stringify(entry).length;
      } catch (_) {
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
