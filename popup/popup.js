/**
 * popup.js
 *
 * Bright People Intel – Popup Controller
 *
 * Handles:
 *   - Tab management (Settings, History, Logs)
 *   - Extension version and status display
 *   - API token save / show-hide toggle
 *   - Cache stats display and cache clearing
 *   - Lookup history from cached data
 *   - Developer log viewer with filters
 */

'use strict';

const LOG_PREFIX = '[BPI][Popup]';

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initialsFrom(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FEEDBACK_TTL_MS = 4000;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateStaticInfo();
  pingServiceWorker();
  loadCacheStats();
  wireCacheSection();
  wireTabBar();
  wireTokenSection();
  wireLogsSection();
});

// ─── Tab Management ──────────────────────────────────────────────────────────

function wireTabBar() {
  const tabBtns = document.querySelectorAll('.bp-tab');
  const tabPanels = document.querySelectorAll('.bp-tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('aria-controls');

      tabBtns.forEach(b => {
        b.classList.remove('bp-tab--active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('bp-tab--active');
      btn.setAttribute('aria-selected', 'true');

      tabPanels.forEach(panel => {
        panel.classList.toggle('bp-hidden', panel.id !== targetId);
      });

      // Lazy-load tab content
      if (targetId === 'bp-tab-history') loadHistory();
      if (targetId === 'bp-tab-logs') loadLogs();
    });
  });
}

// ─── Static Info ──────────────────────────────────────────────────────────────

function populateStaticInfo() {
  const manifest = chrome.runtime.getManifest();

  const versionEl = $('bp-version');
  if (versionEl) versionEl.textContent = `v${manifest.version}`;

  const yearEl = $('bp-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear().toString();

  console.log(LOG_PREFIX, `BPI v${manifest.version} popup opened`);
}

// ─── Service Worker Health Check ──────────────────────────────────────────────

function pingServiceWorker() {
  const dotEl   = $('bp-status')?.querySelector('.bp-status__dot');
  const labelEl = $('bp-status-label');

  chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, 'Service worker not responding:', chrome.runtime.lastError.message);
      setStatusInactive(dotEl, labelEl);
      return;
    }
    if (response?.ok) {
      console.log(LOG_PREFIX, 'Service worker active, version:', response.version);
    } else {
      setStatusInactive(dotEl, labelEl);
    }
  });
}

function setStatusInactive(dotEl, labelEl) {
  const statusEl = $('bp-status');
  if (dotEl) {
    dotEl.classList.remove('bp-status__dot--active');
    dotEl.classList.add('bp-status__dot--inactive');
  }
  if (labelEl) labelEl.textContent = 'Service worker inactive';
  if (statusEl) statusEl.classList.add('bp-status--inactive');
}

// ─── Token Settings ──────────────────────────────────────────────────────────

function wireTokenSection() {
  const inputEl   = $('bp-token-input');
  const toggleEl  = $('bp-token-toggle');
  const saveEl    = $('bp-token-save');
  const feedbackEl = $('bp-token-feedback');

  if (!inputEl || !saveEl) return;

  // Toggle visibility
  toggleEl?.addEventListener('click', () => {
    inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
  });

  // Save token
  saveEl.addEventListener('click', () => {
    const token = inputEl.value.trim();
    if (!token) {
      showFeedback(feedbackEl, 'Please enter a token.', 'error');
      return;
    }

    chrome.storage.sync.set({ brightdata_api_token: token }, () => {
      if (chrome.runtime.lastError) {
        showFeedback(feedbackEl, 'Failed to save token.', 'error');
        return;
      }
      inputEl.value = '';
      inputEl.placeholder = 'Token saved (paste to replace)';
      showFeedback(feedbackEl, 'Token saved successfully.', 'success');
    });
  });
}

// ─── Cache Section ────────────────────────────────────────────────────────────

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
      renderCacheStats(null);
    }
  });
}

function renderCacheStats(stats) {
  const countEl      = $('bp-cache-count');
  const sizeEl       = $('bp-cache-size');
  const expiredEl    = $('bp-cache-expired');
  const expiredRowEl = $('bp-cache-expired-row');

  if (!stats) {
    if (countEl)   countEl.textContent  = '\u2013';
    if (sizeEl)    sizeEl.textContent   = '\u2013';
    if (expiredEl) expiredEl.textContent = '\u2013';
    return;
  }

  if (countEl)  countEl.textContent = stats.count.toString();
  if (sizeEl)   sizeEl.textContent  = formatBytes(stats.sizeBytesEst);
  if (expiredEl) expiredEl.textContent = stats.expiredCount.toString();
  if (expiredRowEl) expiredRowEl.hidden = stats.expiredCount === 0;
}

function wireCacheSection() {
  const clearBtn   = $('bp-cache-clear');
  const feedbackEl = $('bp-cache-feedback');
  if (!clearBtn) return;

  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (response) => {
      clearBtn.disabled = false;

      if (chrome.runtime.lastError) {
        showFeedback(feedbackEl, 'Could not clear cache.', 'error');
        return;
      }

      if (response?.ok) {
        renderCacheStats(response.stats || { count: 0, expiredCount: 0, sizeBytesEst: 0 });
        showFeedback(feedbackEl, 'Cache cleared.', 'success');
      } else {
        showFeedback(feedbackEl, `Failed: ${response?.error || 'Unknown error'}`, 'error');
      }
    });
  });
}

// ─── History ──────────────────────────────────────────────────────────────────

function loadHistory() {
  chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, 'GET_HISTORY failed:', chrome.runtime.lastError.message);
    }

    const listEl  = $('bp-history-list');
    const emptyEl = $('bp-history-empty');
    if (!listEl) return;

    listEl.querySelectorAll('.bp-history-item').forEach(el => el.remove());

    if (!response?.ok || !response.history?.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;

    response.history.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'bp-history-item';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');

      const initials = initialsFrom(entry.name);
      const detail = [entry.currentTitle, entry.currentCompany].filter(Boolean).join(' at ');
      const timeStr = entry.fetchedAt
        ? new Date(entry.fetchedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';

      item.innerHTML = `
        <div class="bp-history-item__avatar">${escapeHtml(initials)}</div>
        <div class="bp-history-item__info">
          <span class="bp-history-item__name">${escapeHtml(entry.name)}</span>
          <span class="bp-history-item__detail">${escapeHtml(detail)}</span>
          <span class="bp-history-item__time">${escapeHtml(timeStr)}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_PERSON_BACKGROUND', payload: { name: entry.name, email: entry.email, company: entry.currentCompany } },
          () => { if (chrome.runtime.lastError) console.warn(LOG_PREFIX, 'History re-fetch:', chrome.runtime.lastError.message); }
        );
        showFeedback($('bp-cache-feedback'), 'Loading in side panel...', 'success');
      });

      listEl.appendChild(item);
    });
  });
}

// ─── Logs Viewer ──────────────────────────────────────────────────────────────

function loadLogs() {
  const moduleSelect = $('bp-logs-module');
  const levelSelect  = $('bp-logs-level');

  const filters = {};
  if (moduleSelect?.value) filters.module = moduleSelect.value;
  if (levelSelect?.value)  filters.level  = levelSelect.value;

  chrome.runtime.sendMessage({ type: 'GET_LOGS', payload: filters }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(LOG_PREFIX, 'GET_LOGS failed:', chrome.runtime.lastError.message);
    }

    const listEl  = $('bp-logs-list');
    const emptyEl = $('bp-logs-empty');
    if (!listEl) return;

    listEl.querySelectorAll('.bp-log-entry').forEach(el => el.remove());

    if (!response?.ok || !response.entries?.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;

    // Populate module filter
    if (moduleSelect && response.modules) {
      const current = moduleSelect.value;
      moduleSelect.innerHTML = '<option value="">All modules</option>';
      response.modules.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === current) opt.selected = true;
        moduleSelect.appendChild(opt);
      });
    }

    response.entries.forEach(entry => {
      const el = document.createElement('div');
      el.className = `bp-log-entry bp-log-entry--${entry.level}`;

      const time = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });

      let html = `
        <div class="bp-log-entry__meta">
          <span class="bp-log-entry__time">${escapeHtml(time)}</span>
          <span class="bp-log-entry__module">${escapeHtml(entry.module)}</span>
          <span class="bp-log-entry__level">${escapeHtml(entry.level)}</span>
        </div>
        <div class="bp-log-entry__message">${escapeHtml(entry.message)}</div>
      `;

      if (entry.data) {
        html += `<pre class="bp-log-entry__data">${escapeHtml(JSON.stringify(entry.data, null, 2).slice(0, 300))}</pre>`;
      }

      el.innerHTML = html;
      listEl.appendChild(el);
    });
  });
}

function wireLogsSection() {
  $('bp-logs-module')?.addEventListener('change', loadLogs);
  $('bp-logs-level')?.addEventListener('change', loadLogs);
  $('bp-logs-refresh')?.addEventListener('click', loadLogs);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showFeedback(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `bp-feedback bp-feedback--${type}`;

  if (el._feedbackTimer) clearTimeout(el._feedbackTimer);
  el._feedbackTimer = setTimeout(() => {
    el.textContent = '';
    el.className = 'bp-feedback';
  }, FEEDBACK_TTL_MS);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
