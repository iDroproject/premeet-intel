/**
 * background/log-buffer.js
 *
 * Bright People Intel – Structured Log Buffer
 *
 * Circular buffer storing the last 200 structured log entries.
 * Queried by the popup log viewer via GET_LOGS message.
 *
 * @module log-buffer
 */

'use strict';

const MAX_LOG_ENTRIES = 200;

export class LogBuffer {
  constructor() {
    /** @type {Array<{timestamp: string, module: string, level: string, message: string, data?: *}>} */
    this._entries = [];
  }

  /**
   * Add a structured log entry.
   */
  log(module, level, message, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      module,
      level,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    this._entries.push(entry);

    if (this._entries.length > MAX_LOG_ENTRIES) {
      this._entries.shift();
    }
  }

  info(module, message, data) { this.log(module, 'info', message, data); }
  warn(module, message, data) { this.log(module, 'warn', message, data); }
  error(module, message, data) { this.log(module, 'error', message, data); }

  /**
   * Get entries, optionally filtered by module and/or level.
   * Returns newest first.
   */
  getEntries(filters = {}) {
    let result = [...this._entries];

    if (filters.module) {
      result = result.filter(e => e.module === filters.module);
    }
    if (filters.level) {
      result = result.filter(e => e.level === filters.level);
    }

    result.reverse();

    if (filters.limit && filters.limit > 0) {
      result = result.slice(0, filters.limit);
    }

    return result;
  }

  /** Get distinct module names present in the buffer. */
  getModules() {
    return [...new Set(this._entries.map(e => e.module))];
  }

  /** Clear all entries. */
  clear() {
    this._entries = [];
  }
}
