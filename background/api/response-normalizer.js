/**
 * background/api/response-normalizer.js
 *
 * Bright People Intel – Bright Data Response Normalizer
 *
 * Converts raw Bright Data LinkedIn API responses into the unified
 * PersonData model. Includes confidence scoring with citations.
 *
 * @module response-normalizer
 */

'use strict';

const LOG_PREFIX = '[BPI][Normalizer]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function toIntOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function splitName(fullName) {
  if (!fullName || !fullName.trim()) return { firstName: '', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function deriveLocation(raw) {
  const city = toStringOrNull(raw.city);
  const cc = toStringOrNull(raw.country_code);
  if (city && cc) return `${city}, ${cc}`;
  return city || cc || null;
}

function deriveCurrentTitle(raw) {
  return toStringOrNull(raw.current_company?.title) || toStringOrNull(raw.position) || null;
}

function deriveCurrentCompany(raw) {
  return toStringOrNull(raw.current_company?.name) || toStringOrNull(raw.current_company_name) || null;
}

function normalizeExperienceEntry(entry) {
  return {
    title: toStringOrNull(entry.title),
    company: toStringOrNull(entry.company),
    companyLogoUrl: toStringOrNull(entry.company_logo_url),
    startDate: toStringOrNull(entry.start_date),
    endDate: toStringOrNull(entry.end_date),
    location: toStringOrNull(entry.location),
    description: toStringOrNull(entry.description),
  };
}

function normalizeEducationEntry(entry) {
  return {
    institution: toStringOrNull(entry.title),
    degree: toStringOrNull(entry.degree),
    field: toStringOrNull(entry.field),
    startYear: toStringOrNull(entry.start_year),
    endYear: toStringOrNull(entry.end_year),
    logoUrl: toStringOrNull(entry.institute_logo_url),
  };
}

function normalizePostEntry(entry) {
  return {
    title: toStringOrNull(entry.title),
    link: toStringOrNull(entry.link),
    imageUrl: toStringOrNull(entry.img),
    interaction: toStringOrNull(entry.interaction),
  };
}

// ─── Confidence Scoring with Citations ──────────────────────────────────────

/**
 * Assess confidence with detailed citations explaining each factor.
 *
 * @param {Object} data     Normalized PersonData fields.
 * @param {Object} context  Additional scoring context.
 * @param {string} [context.email]         Calendar email for domain matching.
 * @param {boolean} [context.serpVerified]  Whether LinkedIn URL came from SERP.
 * @returns {{ level: string, score: number, citations: Array }}
 */
function assessConfidence(data, context = {}) {
  let score = 0;
  const citations = [];

  if (data.avatarUrl) {
    score += 2;
    citations.push({ factor: 'avatar', points: 2, description: 'Profile photo present' });
  }

  if (data.currentTitle) {
    score += 2;
    citations.push({ factor: 'title', points: 2, description: `Current title: "${data.currentTitle}"` });
  }

  if (data.currentCompany) {
    score += 1;
    citations.push({ factor: 'company', points: 1, description: `Company: "${data.currentCompany}"` });
  }

  if (data.bio) {
    score += 1;
    citations.push({ factor: 'bio', points: 1, description: 'Bio/about section present' });
  }

  if (data.experience?.length) {
    score += 1;
    citations.push({ factor: 'experience', points: 1, description: `${data.experience.length} experience entries` });
  }

  if (data.education?.length) {
    score += 1;
    citations.push({ factor: 'education', points: 1, description: `${data.education.length} education entries` });
  }

  if (data.linkedinUrl) {
    score += 2;
    citations.push({ factor: 'linkedin', points: 2, description: 'LinkedIn profile URL verified' });
  }

  // Email domain match.
  if (context.email && data.currentCompany) {
    const domain = (context.email.split('@')[1] || '').toLowerCase();
    const companyLower = data.currentCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainRoot = domain.split('.').slice(-2, -1)[0] || '';
    if (domainRoot && companyLower.includes(domainRoot)) {
      score += 1;
      citations.push({ factor: 'email-match', points: 1, description: `Email domain "${domain}" matches company` });
    }
  }

  // SERP verification.
  if (context.serpVerified) {
    score += 1;
    citations.push({ factor: 'serp-verified', points: 1, description: 'LinkedIn URL found via Google Search' });
  }

  let level = 'low';
  if (score >= 8) level = 'high';
  else if (score >= 4) level = 'medium';

  return { level, score, citations };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw Bright Data LinkedIn profile object into PersonData.
 *
 * @param {Object} rawProfile
 * @param {string} source
 * @param {Object} [context]  Optional context for confidence scoring.
 * @returns {Object} PersonData
 */
export function normalizeLinkedInProfile(rawProfile, source, context = {}) {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    return {
      name: 'Unknown', firstName: '', lastName: '',
      avatarUrl: null, linkedinUrl: null,
      currentTitle: null, currentCompany: null, location: null, bio: null,
      experience: [], education: [], recentPosts: [],
      connections: null, followers: null,
      _source: source || 'unknown',
      _fetchedAt: new Date().toISOString(),
      _confidence: 'low', _confidenceScore: 0, _confidenceCitations: [],
    };
  }

  const raw = rawProfile;
  const name = toStringOrNull(raw.name) || 'Unknown';
  const { firstName, lastName } = splitName(name);

  const normalized = {
    name,
    firstName,
    lastName,
    avatarUrl: toStringOrNull(raw.avatar),
    linkedinUrl: toStringOrNull(raw.url),
    currentTitle: deriveCurrentTitle(raw),
    currentCompany: deriveCurrentCompany(raw),
    location: deriveLocation(raw),
    bio: toStringOrNull(raw.about),
    experience: Array.isArray(raw.experience) ? raw.experience.map(normalizeExperienceEntry) : [],
    education: Array.isArray(raw.education) ? raw.education.map(normalizeEducationEntry) : [],
    recentPosts: Array.isArray(raw.activity) ? raw.activity.map(normalizePostEntry) : [],
    connections: toIntOrNull(raw.connections),
    followers: toIntOrNull(raw.followers),
    _source: source || 'unknown',
    _fetchedAt: new Date().toISOString(),
    _confidence: 'low',
    _confidenceScore: 0,
    _confidenceCitations: [],
  };

  const conf = assessConfidence(normalized, context);
  normalized._confidence = conf.level;
  normalized._confidenceScore = conf.score;
  normalized._confidenceCitations = conf.citations;

  console.log(
    LOG_PREFIX,
    `Normalized "${name}" — confidence: ${conf.level} (${conf.score}/12), citations: ${conf.citations.length}`
  );

  return normalized;
}

/**
 * Pick the best profile from an array of raw profiles.
 *
 * @param {Array} rawProfiles
 * @param {string} targetName
 * @param {string} source
 * @param {Object} [context]
 * @returns {Object|null}
 */
export function pickBestProfile(rawProfiles, targetName, source, context = {}) {
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) return null;
  if (rawProfiles.length === 1) return normalizeLinkedInProfile(rawProfiles[0], source, context);

  const nameLower = (targetName || '').toLowerCase().trim();

  // Exact name match.
  const exactMatch = rawProfiles.find(
    (p) => (toStringOrNull(p.name) || '').toLowerCase() === nameLower
  );
  if (exactMatch) return normalizeLinkedInProfile(exactMatch, source, context);

  // Best score.
  let bestRaw = rawProfiles[0];
  let bestScore = -1;

  for (const p of rawProfiles) {
    const n = normalizeLinkedInProfile(p, source, context);
    if (n._confidenceScore > bestScore) {
      bestScore = n._confidenceScore;
      bestRaw = p;
    }
  }

  return normalizeLinkedInProfile(bestRaw, source, context);
}

/**
 * Merge business-enriched data into an existing PersonData object.
 *
 * @param {Object} personData
 * @param {Object} enrichedProfile
 * @returns {Object}
 */
export function mergeBusinessEnrichedData(personData, enrichedProfile) {
  if (!enrichedProfile || typeof enrichedProfile !== 'object') return personData;

  const merged = { ...personData };

  // Supplement missing fields from business enrichment.
  if (!merged.currentTitle && enrichedProfile.position) {
    merged.currentTitle = toStringOrNull(enrichedProfile.position);
  }
  if (!merged.currentCompany && enrichedProfile.current_company_name) {
    merged.currentCompany = toStringOrNull(enrichedProfile.current_company_name);
  }

  // Add business-specific fields.
  merged.companyRevenue = toStringOrNull(enrichedProfile.company_revenue || enrichedProfile.revenue);
  merged.companySize = toStringOrNull(enrichedProfile.company_size || enrichedProfile.employee_count);
  merged.companyIndustry = toStringOrNull(enrichedProfile.company_industry || enrichedProfile.industry);
  merged.skills = Array.isArray(enrichedProfile.skills)
    ? enrichedProfile.skills.map((s) => typeof s === 'string' ? s : toStringOrNull(s?.name)).filter(Boolean)
    : merged.skills || [];

  console.log(LOG_PREFIX, 'Merged business enriched data for:', merged.name);
  return merged;
}
