/**
 * popup.js
 *
 * Meeting Intel – Browser Action Popup
 *
 * Displays extension status, version, and usage instructions.
 * Pings the background service worker to verify it is active.
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][Popup]';

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateStaticInfo();
  pingServiceWorker();
});

// ─── Static Info ──────────────────────────────────────────────────────────────

/**
 * Fill in the version number and copyright year from the manifest.
 */
function populateStaticInfo() {
  const manifest = chrome.runtime.getManifest();

  const versionEl = $('mp-version');
  if (versionEl) {
    versionEl.textContent = manifest.version;
  }

  const yearEl = $('mp-year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear().toString();
  }

  console.log(LOG_PREFIX, `Meeting Intel v${manifest.version} popup opened`);
}

// ─── Service Worker Health Check ─────────────────────────────────────────────

/**
 * Send a PING to the background service worker to confirm it is running.
 * Updates the status indicator based on the response.
 */
function pingServiceWorker() {
  const statusEl = $('mp-status');
  const dotEl = statusEl?.querySelector('.mp-status__dot');
  const labelEl = statusEl?.querySelector('.mp-status__label');

  chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn(
        LOG_PREFIX,
        'Service worker did not respond:',
        chrome.runtime.lastError.message
      );

      // Update status to show warning.
      if (dotEl) {
        dotEl.classList.remove('mp-status__dot--active');
        dotEl.classList.add('mp-status__dot--inactive');
      }
      if (labelEl) {
        labelEl.textContent = 'Service worker inactive';
      }
      if (statusEl) {
        statusEl.style.backgroundColor = '#fce8e6';
        statusEl.style.color = '#c5221f';
      }
      return;
    }

    if (response?.ok) {
      console.log(
        LOG_PREFIX,
        'Service worker active, version:',
        response.version
      );
    }
  });
}
