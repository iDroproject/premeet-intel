/**
 * popup.js
 *
 * Meeting Intel – Settings Popup
 *
 * Handles:
 *   - Extension version and status display
 *   - API token save / show-hide toggle
 *   - Cache stats display and cache clearing
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][Popup]';

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

/** @param {string} id @returns {HTMLElement|null} */
const $ = (id) => document.getElementById(id);

// ─── Constants ────────────────────────────────────────────────────────────────

/** Duration (ms) before auto-clearing a feedback message. */
const FEEDBACK_TTL_MS = 4000;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateStaticInfo();
  pingServiceWorker();
  loadCacheStats();
  wireCacheSection();
});

// ─── Static Info ──────────────────────────────────────────────────────────────

/**
 * Populate version and copyright year from the manifest.
 */
function populateStaticInfo() {
  const manifest = chrome.runtime.getManifest();

  const versionEl = $('mp-version');
  if (versionEl) {
    versionEl.textContent = `v${manifest.version}`;
  }

  const yearEl = $('mp-year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear().toString();
  }

  console.log(LOG_PREFIX, `Meeting Intel v${manifest.version} popup opened`);
}

// ─── Service Worker Health Check ──────────────────────────────────────────────

/**
 * Ping the background service worker and reflect the result in the status pill.
 */
function pingServiceWorker() {
  const dotEl   = $('mp-status')?.querySelector('.mp-status__dot');
  const labelEl = $('mp-status-label');

  chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, 'Service worker not responding:', chrome.runtime.lastError.message);
      setStatusInactive(dotEl, labelEl);
      return;
    }

    if (response?.ok) {
      console.log(LOG_PREFIX, 'Service worker active, version:', response.version);
      // Status defaults to active; nothing to update.
    } else {
      setStatusInactive(dotEl, labelEl);
    }
  });
}

/**
 * Update status pill to the inactive / error state.
 *
 * @param {HTMLElement|null} dotEl
 * @param {HTMLElement|null} labelEl
 */
function setStatusInactive(dotEl, labelEl) {
  const statusEl = $('mp-status');
  if (dotEl) {
    dotEl.classList.remove('mp-status__dot--active');
    dotEl.classList.add('mp-status__dot--inactive');
  }
  if (labelEl) {
    labelEl.textContent = 'Service worker inactive';
  }
  if (statusEl) {
    statusEl.classList.add('mp-status--inactive');
  }
}

// ─── Cache Section ────────────────────────────────────────────────────────────

/**
 * Request cache statistics from the service worker and render them.
 */
function loadCacheStats() {
  chrome.runtime.sendMessage({ type: 'GET_CACHE_STATS' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, 'GET_CACHE_STATS failed:', chrome.runtime.lastError.message);
      renderCacheStats(null);
      return;
    }

    if (response?.ok) {
      renderCacheStats(response.stats);
    } else {
      console.warn(LOG_PREFIX, 'GET_CACHE_STATS returned error:', response?.error);
      renderCacheStats(null);
    }
  });
}

/**
 * Render cache statistics into the DOM.
 *
 * @param {{ count: number, expiredCount: number, sizeBytesEst: number }|null} stats
 */
function renderCacheStats(stats) {
  const countEl   = $('mp-cache-count');
  const sizeEl    = $('mp-cache-size');
  const expiredEl = $('mp-cache-expired');
  const expiredRowEl = $('mp-cache-expired-row');

  if (!stats) {
    if (countEl)  countEl.textContent  = '–';
    if (sizeEl)   sizeEl.textContent   = '–';
    if (expiredEl) expiredEl.textContent = '–';
    return;
  }

  if (countEl)  countEl.textContent = stats.count.toString();
  if (sizeEl)   sizeEl.textContent  = formatBytes(stats.sizeBytesEst);

  if (expiredEl) expiredEl.textContent = stats.expiredCount.toString();
  // Hide the expired row when there are no expired entries
  if (expiredRowEl) {
    expiredRowEl.hidden = stats.expiredCount === 0;
  }
}

/**
 * Wire up the Clear Cache button.
 */
function wireCacheSection() {
  const clearBtn   = $('mp-cache-clear');
  const feedbackEl = $('mp-cache-feedback');

  if (!clearBtn) return;

  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (response) => {
      clearBtn.disabled = false;

      if (chrome.runtime.lastError) {
        console.error(LOG_PREFIX, 'CLEAR_CACHE failed:', chrome.runtime.lastError.message);
        showFeedback(feedbackEl, 'Could not clear cache. Try reloading the extension.', 'error');
        return;
      }

      if (response?.ok) {
        console.log(LOG_PREFIX, 'Cache cleared');
        renderCacheStats(response.stats || { count: 0, expiredCount: 0, sizeBytesEst: 0 });
        showFeedback(feedbackEl, 'Cache cleared.', 'success');
      } else {
        const msg = response?.error || 'Unknown error';
        console.error(LOG_PREFIX, 'CLEAR_CACHE error:', msg);
        showFeedback(feedbackEl, `Failed to clear: ${msg}`, 'error');
      }
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Show a temporary feedback message in the given element.
 *
 * @param {HTMLElement|null} el
 * @param {string}           message
 * @param {'success'|'error'} type
 */
function showFeedback(el, message, type) {
  if (!el) return;

  el.textContent = message;
  el.className = `mp-feedback mp-feedback--${type}`;

  // Clear any previous auto-hide timer stored on the element.
  if (el._feedbackTimer) clearTimeout(el._feedbackTimer);

  el._feedbackTimer = setTimeout(() => {
    el.textContent = '';
    el.className = 'mp-feedback';
  }, FEEDBACK_TTL_MS);
}

/**
 * Format a byte count into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
