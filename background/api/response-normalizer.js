/**
 * background/api/response-normalizer.js
 *
 * Meeting Intel – Bright Data Response Normalizer
 *
 * Converts raw Bright Data LinkedIn API responses into the unified
 * `PersonData` model consumed by the side panel and cached by CacheManager.
 *
 * Raw field reference (from live API testing):
 *   name, about, avatar, banner_image, city, country_code, connections,
 *   followers, current_company: { name, title, company_id, link, location },
 *   current_company_name, position, education, experience, activity,
 *   certifications, courses, languages, linkedin_id, url, id
 *
 * @module response-normalizer
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][Normalizer]';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PersonData
 * The unified profile model used throughout the extension.
 *
 * @property {string}            name
 * @property {string}            firstName
 * @property {string}            lastName
 * @property {string|null}       avatarUrl
 * @property {string|null}       linkedinUrl
 * @property {string|null}       currentTitle
 * @property {string|null}       currentCompany
 * @property {string|null}       location
 * @property {string|null}       bio
 * @property {ExperienceEntry[]} experience
 * @property {EducationEntry[]}  education
 * @property {PostEntry[]}       recentPosts
 * @property {number|null}       connections
 * @property {number|null}       followers
 * @property {string}            _source       Which API provided this data.
 * @property {string}            _fetchedAt    ISO 8601 timestamp.
 * @property {'high'|'medium'|'low'} _confidence  Based on data completeness.
 */

/**
 * @typedef {Object} ExperienceEntry
 * @property {string|null} title
 * @property {string|null} company
 * @property {string|null} companyLogoUrl
 * @property {string|null} startDate
 * @property {string|null} endDate
 * @property {string|null} location
 * @property {string|null} description
 */

/**
 * @typedef {Object} EducationEntry
 * @property {string|null} institution
 * @property {string|null} degree
 * @property {string|null} field
 * @property {string|null} startYear
 * @property {string|null} endYear
 * @property {string|null} logoUrl
 */

/**
 * @typedef {Object} PostEntry
 * @property {string|null} title
 * @property {string|null} link
 * @property {string|null} imageUrl
 * @property {string|null} interaction
 */

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Coerce a value to a trimmed string or null.
 *
 * @param {*} value
 * @returns {string|null}
 */
function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

/**
 * Coerce a value to an integer or null.
 *
 * Handles both numeric values and strings like "1,234".
 *
 * @param {*} value
 * @returns {number|null}
 */
function toIntOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive first and last name from a full name string.
 *
 * @param {string|null} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
function splitName(fullName) {
  if (!fullName || !fullName.trim()) {
    return { firstName: '', lastName: '' };
  }

  const parts = fullName.trim().split(/\s+/);

  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '' };
  }

  const firstName = parts[0];
  const lastName  = parts.slice(1).join(' ');
  return { firstName, lastName };
}

/**
 * Build a human-readable location string from city and country_code fields.
 *
 * @param {*} raw  Raw profile object.
 * @returns {string|null}
 */
function deriveLocation(raw) {
  const city        = toStringOrNull(raw.city);
  const countryCode = toStringOrNull(raw.country_code);

  if (city && countryCode) return `${city}, ${countryCode}`;
  if (city)        return city;
  if (countryCode) return countryCode;
  return null;
}

/**
 * Resolve the current job title from multiple possible source fields.
 * Prefers `current_company.title`, then `position`, then null.
 *
 * @param {*} raw  Raw profile object.
 * @returns {string|null}
 */
function deriveCurrentTitle(raw) {
  return (
    toStringOrNull(raw.current_company?.title) ||
    toStringOrNull(raw.position)               ||
    null
  );
}

/**
 * Resolve the current company name from multiple possible source fields.
 *
 * @param {*} raw  Raw profile object.
 * @returns {string|null}
 */
function deriveCurrentCompany(raw) {
  return (
    toStringOrNull(raw.current_company?.name) ||
    toStringOrNull(raw.current_company_name)  ||
    null
  );
}

/**
 * Normalize a raw experience array entry.
 *
 * @param {*} entry  Raw experience item from the API.
 * @returns {ExperienceEntry}
 */
function normalizeExperienceEntry(entry) {
  return {
    title:          toStringOrNull(entry.title),
    company:        toStringOrNull(entry.company),
    companyLogoUrl: toStringOrNull(entry.company_logo_url),
    startDate:      toStringOrNull(entry.start_date),
    endDate:        toStringOrNull(entry.end_date),
    location:       toStringOrNull(entry.location),
    description:    toStringOrNull(entry.description),
  };
}

/**
 * Normalize a raw education array entry.
 *
 * @param {*} entry  Raw education item from the API.
 * @returns {EducationEntry}
 */
function normalizeEducationEntry(entry) {
  return {
    institution: toStringOrNull(entry.title),           // API uses "title" for school name
    degree:      toStringOrNull(entry.degree),
    field:       toStringOrNull(entry.field),
    startYear:   toStringOrNull(entry.start_year),
    endYear:     toStringOrNull(entry.end_year),
    logoUrl:     toStringOrNull(entry.institute_logo_url),
  };
}

/**
 * Normalize a raw activity/post array entry.
 *
 * @param {*} entry  Raw activity item from the API.
 * @returns {PostEntry}
 */
function normalizePostEntry(entry) {
  return {
    title:       toStringOrNull(entry.title),
    link:        toStringOrNull(entry.link),
    imageUrl:    toStringOrNull(entry.img),
    interaction: toStringOrNull(entry.interaction),
  };
}

/**
 * Assess the completeness of a normalized PersonData object and return a
 * confidence level.
 *
 * Scoring rubric (total possible: 8 points):
 *   +2  avatarUrl present (real photo = genuine profile match)
 *   +2  currentTitle present
 *   +1  currentCompany present
 *   +1  bio present
 *   +1  experience.length > 0
 *   +1  education.length > 0
 *
 * Thresholds:
 *   >= 6  → 'high'
 *   >= 3  → 'medium'
 *   < 3   → 'low'
 *
 * @param {Partial<PersonData>} data
 * @returns {'high'|'medium'|'low'}
 */
function assessConfidence(data) {
  let score = 0;

  if (data.avatarUrl)            score += 2;
  if (data.currentTitle)         score += 2;
  if (data.currentCompany)       score += 1;
  if (data.bio)                  score += 1;
  if (data.experience?.length)   score += 1;
  if (data.education?.length)    score += 1;

  if (score >= 6) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw Bright Data LinkedIn profile object into the unified
 * `PersonData` model.
 *
 * When the API returns an array (which is the common case), pass the first
 * element of that array. If it returns an empty array or a non-object, a
 * minimal placeholder PersonData is returned with `_confidence: 'low'`.
 *
 * @param {*}      rawProfile  Raw object from the Bright Data API.
 * @param {string} source      Identifier for the API call that produced this
 *                             data, e.g. 'brightdata-url' or 'brightdata-name'.
 * @returns {PersonData}
 */
export function normalizeLinkedInProfile(rawProfile, source) {
  // Guard: handle null / non-object inputs gracefully.
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    console.warn(
      LOG_PREFIX,
      'normalizeLinkedInProfile received invalid input:',
      typeof rawProfile
    );

    return {
      name:          'Unknown',
      firstName:     '',
      lastName:      '',
      avatarUrl:     null,
      linkedinUrl:   null,
      currentTitle:  null,
      currentCompany: null,
      location:      null,
      bio:           null,
      experience:    [],
      education:     [],
      recentPosts:   [],
      connections:   null,
      followers:     null,
      _source:       source || 'unknown',
      _fetchedAt:    new Date().toISOString(),
      _confidence:   'low',
    };
  }

  const raw = rawProfile;

  // ── Core identity ──────────────────────────────────────────────────────────
  const name       = toStringOrNull(raw.name) || 'Unknown';
  const { firstName, lastName } = splitName(name);
  const avatarUrl  = toStringOrNull(raw.avatar);
  const linkedinUrl = toStringOrNull(raw.url);

  // ── Current role ───────────────────────────────────────────────────────────
  const currentTitle   = deriveCurrentTitle(raw);
  const currentCompany = deriveCurrentCompany(raw);
  const location       = deriveLocation(raw);
  const bio            = toStringOrNull(raw.about);

  // ── Arrays ─────────────────────────────────────────────────────────────────
  const experience = Array.isArray(raw.experience)
    ? raw.experience.map(normalizeExperienceEntry)
    : [];

  const education = Array.isArray(raw.education)
    ? raw.education.map(normalizeEducationEntry)
    : [];

  const recentPosts = Array.isArray(raw.activity)
    ? raw.activity.map(normalizePostEntry)
    : [];

  // ── Social numbers ─────────────────────────────────────────────────────────
  const connections = toIntOrNull(raw.connections);
  const followers   = toIntOrNull(raw.followers);

  // ── Assemble ───────────────────────────────────────────────────────────────
  /** @type {PersonData} */
  const normalized = {
    name,
    firstName,
    lastName,
    avatarUrl,
    linkedinUrl,
    currentTitle,
    currentCompany,
    location,
    bio,
    experience,
    education,
    recentPosts,
    connections,
    followers,
    _source:     source || 'unknown',
    _fetchedAt:  new Date().toISOString(),
    _confidence: 'low', // filled in below
  };

  normalized._confidence = assessConfidence(normalized);

  console.log(
    LOG_PREFIX,
    `Normalized profile for "${name}" – confidence: ${normalized._confidence},`,
    `experience: ${experience.length}, education: ${education.length}`
  );

  return normalized;
}

/**
 * Pick the best profile from an array of raw profiles when a name search
 * returns multiple candidates.
 *
 * Selection strategy (in priority order):
 *   1. Exact name match (case-insensitive).
 *   2. Highest data completeness score (most fields populated).
 *   3. First record in the array.
 *
 * @param {Array<Object>} rawProfiles  Array of raw Bright Data profile objects.
 * @param {string}        targetName   The name we were looking for.
 * @param {string}        source       Source label forwarded to `normalizeLinkedInProfile`.
 * @returns {PersonData|null}          Best-match PersonData, or null if array empty.
 */
export function pickBestProfile(rawProfiles, targetName, source) {
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
    return null;
  }

  if (rawProfiles.length === 1) {
    return normalizeLinkedInProfile(rawProfiles[0], source);
  }

  const nameLower = (targetName || '').toLowerCase().trim();

  // 1. Look for an exact name match first.
  const exactMatch = rawProfiles.find(
    (p) => (toStringOrNull(p.name) || '').toLowerCase() === nameLower
  );

  if (exactMatch) {
    console.log(LOG_PREFIX, 'Exact name match found for:', targetName);
    return normalizeLinkedInProfile(exactMatch, source);
  }

  // 2. Score all profiles and pick the best.
  let bestRaw   = rawProfiles[0];
  let bestScore = -1;

  for (const p of rawProfiles) {
    const normalized = normalizeLinkedInProfile(p, source);
    const score =
      (normalized.avatarUrl     ? 2 : 0) +
      (normalized.currentTitle  ? 2 : 0) +
      (normalized.currentCompany ? 1 : 0) +
      (normalized.bio            ? 1 : 0) +
      (normalized.experience.length ? 1 : 0) +
      (normalized.education.length  ? 1 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestRaw   = p;
    }
  }

  console.log(LOG_PREFIX, `Picked best profile (score ${bestScore}) from ${rawProfiles.length} candidates`);
  return normalizeLinkedInProfile(bestRaw, source);
}
