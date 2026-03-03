/**
 * background/api/bright-data-deep-lookup.js
 *
 * Meeting Intel – Bright Data Deep Lookup API Client
 *
 * Uses Bright Data's `discover_new` / `discover_by=name` trigger endpoint
 * to perform real-time person enrichment when no LinkedIn URL is available.
 *
 * API contract:
 *   POST https://api.brightdata.com/datasets/v3/trigger
 *     ?dataset_id=<id>
 *     &type=discover_new
 *     &discover_by=name
 *     &format=json
 *     &include_errors=true
 *   Authorization: Bearer <token>
 *   Body: [{ "name": "...", "company": "..." }]
 *
 * Possible responses:
 *   - HTTP 200  – profile data returned synchronously in the body.
 *   - HTTP 202  – job accepted; body contains `{ snapshot_id }`.
 *                 In this case we poll the snapshot status and download
 *                 the results once ready.
 *
 * The function enforces a hard 60-second overall timeout across both the
 * initial request and any required polling.
 *
 * @module bright-data-deep-lookup
 */

'use strict';

import {
  pollSnapshotUntilReady,
  downloadSnapshot,
} from './bright-data-scraper.js';

const LOG_PREFIX = '[Meeting Intel][DeepLookup]';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL    = 'https://api.brightdata.com';
const DATASET_ID  = 'gd_l1viktl72bvl7bjuj0';

/**
 * Trigger endpoint for real-time name-based discovery.
 * `include_errors=true` ensures Bright Data surfaces partial errors rather
 * than silently returning an empty dataset.
 */
const DEEP_LOOKUP_ENDPOINT =
  `${BASE_URL}/datasets/v3/trigger` +
  `?dataset_id=${DATASET_ID}` +
  `&type=discover_new` +
  `&discover_by=name` +
  `&format=json` +
  `&include_errors=true`;

/**
 * Hard timeout in milliseconds for the entire deep-lookup operation
 * (initial request + optional snapshot polling).
 *
 * @type {number}
 */
const DEEP_LOOKUP_TIMEOUT_MS = 60_000;

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Build the shared Authorization header object.
 *
 * @param {string} apiToken  Bright Data API bearer token.
 * @returns {Record<string, string>}
 */
function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

/**
 * Perform a `fetch()` call guarded by an AbortController timeout.
 *
 * @param {string}      url        Target URL.
 * @param {RequestInit} options    Fetch options (method, headers, body…).
 * @param {number}      timeoutMs  Milliseconds before the request is aborted.
 * @returns {Promise<Response>}
 * @throws {Error} On network failure, timeout, or non-OK HTTP status (except 202).
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timerId    = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `Deep Lookup request to ${url} timed out after ${timeoutMs / 1000}s`
      );
    }
    throw new Error(`Network error during Deep Lookup: ${err.message}`);
  } finally {
    clearTimeout(timerId);
  }

  if (!response.ok && response.status !== 202) {
    let bodyExcerpt = '';
    try {
      const text = await response.text();
      bodyExcerpt = text.slice(0, 200);
    } catch (_) {
      // Ignore secondary read errors.
    }
    throw new Error(
      `Bright Data Deep Lookup returned HTTP ${response.status}` +
      (bodyExcerpt ? `: ${bodyExcerpt}` : '')
    );
  }

  return response;
}

/**
 * Wrap a Promise with a hard deadline.
 * Rejects with a timeout error if `promise` does not settle within `ms`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number}     ms       Deadline in milliseconds.
 * @param {string}     label    Human-readable label used in the error message.
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Deep Lookup timed out after ${ms / 1000}s (${label})`)),
      ms
    );

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err);    }
    );
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Perform a real-time person enrichment lookup using Bright Data's
 * `discover_new` / `discover_by=name` endpoint.
 *
 * The function transparently handles both synchronous (HTTP 200) and
 * asynchronous (HTTP 202 + snapshot polling) response modes.
 *
 * @param {string}      name      Full name of the person to look up,
 *                                e.g. "Jane Doe".
 * @param {string|null} company   Company name for disambiguation.  May be
 *                                null or empty; the field is omitted from the
 *                                request body when not provided so Bright Data
 *                                does not treat an empty string as a filter.
 * @param {string}      apiToken  Bright Data API bearer token.
 * @returns {Promise<Array<Object>|null>}
 *   Raw profile objects on success, or `null` if no data was returned.
 *   Callers should handle null as a "no results" signal rather than an error.
 * @throws {Error} On network failure, API error, or timeout.
 */
export async function deepLookupByName(name, company, apiToken) {
  if (!name || !name.trim()) {
    throw new Error('deepLookupByName: name is required');
  }

  if (!apiToken || !apiToken.trim()) {
    throw new Error('deepLookupByName: apiToken is required');
  }

  console.log(
    LOG_PREFIX,
    `Starting deep lookup – name: "${name}"` +
    (company ? `, company: "${company}"` : ' (no company provided)')
  );

  // Build the request body.  The `company` field is only included when a
  // non-empty value is provided so Bright Data applies it as a disambiguator.
  /** @type {{ name: string; company?: string }} */
  const lookupInput = { name: name.trim() };
  if (company && company.trim()) {
    lookupInput.company = company.trim();
  }

  const startedAt = Date.now();

  // ── 1. Trigger the deep lookup ─────────────────────────────────────────────

  // Reserve time for potential snapshot polling inside the global deadline.
  const triggerTimeoutMs = Math.min(DEEP_LOOKUP_TIMEOUT_MS, 30_000);

  const response = await withDeadline(
    fetchWithTimeout(
      DEEP_LOOKUP_ENDPOINT,
      {
        method:  'POST',
        headers: authHeaders(apiToken),
        body:    JSON.stringify([lookupInput]),
      },
      triggerTimeoutMs
    ),
    DEEP_LOOKUP_TIMEOUT_MS,
    'trigger request'
  );

  // ── 2a. Synchronous response (HTTP 200) ────────────────────────────────────
  if (response.status === 200) {
    const body = await response.json();

    // The trigger endpoint may return a top-level array or a wrapper object.
    // Normalise to an array regardless.
    const profiles = Array.isArray(body)
      ? body
      : (Array.isArray(body?.data) ? body.data : null);

    if (!profiles || profiles.length === 0) {
      console.log(LOG_PREFIX, `Deep lookup returned no profiles for "${name}"`);
      return null;
    }

    console.log(
      LOG_PREFIX,
      `Deep lookup (sync) returned ${profiles.length} profile(s) for "${name}" ` +
      `in ${Date.now() - startedAt}ms`
    );

    return profiles;
  }

  // ── 2b. Asynchronous response (HTTP 202) ───────────────────────────────────
  if (response.status === 202) {
    const body       = await response.json();
    const snapshotId = body?.snapshot_id;

    if (!snapshotId) {
      throw new Error(
        'Bright Data Deep Lookup returned 202 but no snapshot_id. Body: ' +
        JSON.stringify(body).slice(0, 200)
      );
    }

    console.log(
      LOG_PREFIX,
      `Deep lookup is async – snapshot_id: ${snapshotId}. Polling…`
    );

    // Use the remaining budget of the global deadline for polling + download.
    const elapsed       = Date.now() - startedAt;
    const remainingMs   = DEEP_LOOKUP_TIMEOUT_MS - elapsed;

    if (remainingMs <= 0) {
      throw new Error(
        `Deep Lookup snapshot ${snapshotId} queued but no time left in budget`
      );
    }

    const profiles = await withDeadline(
      (async () => {
        await pollSnapshotUntilReady(snapshotId, apiToken);
        return downloadSnapshot(snapshotId, apiToken);
      })(),
      remainingMs,
      `snapshot polling for ${snapshotId}`
    );

    if (!profiles || profiles.length === 0) {
      console.log(
        LOG_PREFIX,
        `Deep lookup snapshot returned no profiles for "${name}"`
      );
      return null;
    }

    console.log(
      LOG_PREFIX,
      `Deep lookup (async) returned ${profiles.length} profile(s) for "${name}" ` +
      `in ${Date.now() - startedAt}ms`
    );

    return profiles;
  }

  // Should be unreachable given the HTTP status guard in fetchWithTimeout, but
  // provides a clear error if Bright Data returns an unexpected 2xx code.
  throw new Error(
    `Unexpected HTTP ${response.status} from Bright Data Deep Lookup endpoint`
  );
}
