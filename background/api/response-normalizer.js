/**
 * background/api/response-normalizer.js
 *
 * Bright People Intel – Bright Data Response Normalizer
 *
 * Converts raw Bright Data LinkedIn API responses into the unified
 * PersonData model. Includes confidence scoring with citations,
 * company intelligence fields, and ICP (Ideal Customer Profile) analysis.
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

// ─── ICP Analysis ────────────────────────────────────────────────────────────

/**
 * Derive ICP (Ideal Customer Profile) signals from normalized PersonData.
 *
 * Analyzes current title and available company/follower/connection data to
 * classify seniority, department, and buyer signals that sales teams use to
 * prioritize outreach.
 *
 * @param {Object} data  Normalized PersonData object (pre-ICP).
 * @param {string|null} data.currentTitle
 * @param {number|null} data.followers
 * @param {number|null} data.connections
 * @param {Array}       [data.experience]
 * @param {string|null} [data.department]
 * @returns {{
 *   isDecisionMaker: boolean,
 *   seniorityLevel: string,
 *   department: string|null,
 *   icpSignals: string[],
 * }}
 */
function deriveIcpProfile(data) {
  const result = {
    isDecisionMaker: false,
    seniorityLevel: 'individual', // individual | manager | director | vp | c-level | founder
    department: null,             // engineering | sales | marketing | product | operations | hr | finance | other
    icpSignals: [],               // array of string signals
  };

  const title = (data.currentTitle || '').toLowerCase();

  // Seniority detection — ordered from most to least senior so the first match wins.
  if (/\b(ceo|cto|cfo|coo|cmo|cpo|ciso|chief)\b/.test(title)) {
    result.seniorityLevel = 'c-level';
    result.isDecisionMaker = true;
  } else if (/\b(founder|co-founder|cofounder|owner|partner)\b/.test(title)) {
    result.seniorityLevel = 'founder';
    result.isDecisionMaker = true;
  } else if (/\b(vp|vice president|svp|evp)\b/.test(title)) {
    result.seniorityLevel = 'vp';
    result.isDecisionMaker = true;
  } else if (/\b(director|head of|principal)\b/.test(title)) {
    result.seniorityLevel = 'director';
    result.isDecisionMaker = true;
  } else if (/\b(manager|lead|team lead|supervisor)\b/.test(title)) {
    result.seniorityLevel = 'manager';
  }

  // Department detection — first match wins.
  if (/\b(engineer|developer|software|devops|sre|architect|tech|data scientist|ml |ai )\b/.test(title)) {
    result.department = 'engineering';
  } else if (/\b(sales|business development|account executive|ae |sdr|bdr)\b/.test(title)) {
    result.department = 'sales';
  } else if (/\b(marketing|growth|brand|content|seo|sem|demand gen)\b/.test(title)) {
    result.department = 'marketing';
  } else if (/\b(product|pm |product manager|product owner)\b/.test(title)) {
    result.department = 'product';
  } else if (/\b(operations|ops|supply chain|logistics)\b/.test(title)) {
    result.department = 'operations';
  } else if (/\b(hr|human resources|people|talent|recruiting)\b/.test(title)) {
    result.department = 'hr';
  } else if (/\b(finance|accounting|controller|treasurer|cpa)\b/.test(title)) {
    result.department = 'finance';
  }

  // ICP signals — build an array of human-readable buying signals.
  if (result.isDecisionMaker) result.icpSignals.push('Key Decision Maker');
  if (result.seniorityLevel === 'c-level') result.icpSignals.push('C-Level Executive');
  if (result.seniorityLevel === 'founder') result.icpSignals.push('Founder/Owner');
  if (data.followers && data.followers > 5000) result.icpSignals.push('Industry Influencer');
  if (data.connections && data.connections >= 500) result.icpSignals.push('Well-Connected');
  if (data.experience?.length > 5) result.icpSignals.push('Experienced Professional');
  if (result.department) {
    const label = result.department.charAt(0).toUpperCase() + result.department.slice(1);
    result.icpSignals.push(`${label} Leader`);
  }

  return result;
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
      // Company intelligence
      companyId: null,
      companyLogoUrl: null,
      companyLinkedinUrl: null,
      companyIndustry: null,
      companySize: null,
      companyRevenue: null,
      companyDescription: null,
      icp: null,
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
    // Company intelligence
    companyId: toStringOrNull(raw.current_company?.company_id) || null,
    companyLogoUrl: toStringOrNull(raw.current_company?.logo) || null,
    companyLinkedinUrl: toStringOrNull(raw.current_company?.link) || null,
    companyIndustry: toStringOrNull(raw.company_industry || raw.current_company?.industry) || null,
    companySize: toStringOrNull(raw.company_size || raw.employee_count) || null,
    companyRevenue: toStringOrNull(raw.company_revenue || raw.revenue) || null,
    companyDescription: toStringOrNull(raw.current_company?.description) || null,
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

  const icp = deriveIcpProfile(normalized);
  normalized.icp = icp;

  console.log(
    LOG_PREFIX,
    `Normalized "${name}" — confidence: ${conf.level} (${conf.score}/12), citations: ${conf.citations.length},`,
    `seniority: ${icp.seniorityLevel}, department: ${icp.department ?? 'unknown'},`,
    `signals: [${icp.icpSignals.join(', ')}]`
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
 * Enriched profiles from secondary lookups (e.g. deep-lookup) may carry
 * company intelligence that was absent in the primary SERP/scrape result.
 * This function fills those gaps without overwriting already-populated fields,
 * then re-derives the ICP profile so signals stay consistent with the final
 * merged state.
 *
 * @param {Object} personData      Primary normalized PersonData.
 * @param {Object} enrichedProfile Raw enriched profile object from Bright Data.
 * @returns {Object} Merged PersonData with updated company intel and ICP.
 */
export function mergeBusinessEnrichedData(personData, enrichedProfile) {
  if (!enrichedProfile || typeof enrichedProfile !== 'object') return personData;

  const merged = { ...personData };

  // Supplement missing core fields from business enrichment.
  if (!merged.currentTitle && enrichedProfile.position) {
    merged.currentTitle = toStringOrNull(enrichedProfile.position);
  }
  if (!merged.currentCompany && enrichedProfile.current_company_name) {
    merged.currentCompany = toStringOrNull(enrichedProfile.current_company_name);
  }

  // Supplement missing company intelligence fields — never overwrite populated values.
  if (!merged.companyId) {
    merged.companyId = toStringOrNull(enrichedProfile.current_company?.company_id) || null;
  }
  if (!merged.companyLogoUrl) {
    merged.companyLogoUrl = toStringOrNull(enrichedProfile.current_company?.logo) || null;
  }
  if (!merged.companyLinkedinUrl) {
    merged.companyLinkedinUrl = toStringOrNull(enrichedProfile.current_company?.link) || null;
  }
  if (!merged.companyIndustry) {
    merged.companyIndustry = toStringOrNull(
      enrichedProfile.company_industry || enrichedProfile.current_company?.industry
    ) || null;
  }
  if (!merged.companySize) {
    merged.companySize = toStringOrNull(
      enrichedProfile.company_size || enrichedProfile.employee_count
    ) || null;
  }
  if (!merged.companyRevenue) {
    merged.companyRevenue = toStringOrNull(
      enrichedProfile.company_revenue || enrichedProfile.revenue
    ) || null;
  }
  if (!merged.companyDescription) {
    merged.companyDescription = toStringOrNull(enrichedProfile.current_company?.description) || null;
  }

  // Skills — always take the enriched list if present; fall back to whatever exists.
  merged.skills = Array.isArray(enrichedProfile.skills)
    ? enrichedProfile.skills.map((s) => typeof s === 'string' ? s : toStringOrNull(s?.name)).filter(Boolean)
    : merged.skills || [];

  // Re-derive ICP so signals reflect the fully merged state (e.g. title may
  // have been filled in above, unlocking seniority/department detection).
  merged.icp = deriveIcpProfile(merged);

  console.log(LOG_PREFIX, 'Merged business enriched data for:', merged.name);
  return merged;
}
