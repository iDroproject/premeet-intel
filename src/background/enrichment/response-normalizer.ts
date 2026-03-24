// PreMeet – Response Normalizer
// Converts raw LinkedIn API responses into the unified PersonData model.

import type { PersonData, IcpProfile, ConfidenceCitation, ExperienceEntry, EducationEntry, PostEntry } from './types';

const LOG_PREFIX = '[PreMeet][Normalizer]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  if (!fullName || !fullName.trim()) return { firstName: '', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function deriveLocation(raw: Record<string, unknown>): string | null {
  const city = toStringOrNull(raw.city);
  const cc = toStringOrNull(raw.country_code);
  if (city && cc) return `${city}, ${cc}`;
  return city || cc || null;
}

function deriveCurrentTitle(raw: Record<string, unknown>): string | null {
  const cc = raw.current_company as Record<string, unknown> | undefined;
  return (
    toStringOrNull(cc?.title) ||
    toStringOrNull(raw.current_company_position) ||
    toStringOrNull(raw.position) ||
    toStringOrNull(raw.job_title) ||
    toStringOrNull(raw.headline) ||
    null
  );
}

function deriveCurrentCompany(raw: Record<string, unknown>): string | null {
  const cc = raw.current_company as Record<string, unknown> | undefined;
  return toStringOrNull(cc?.name) || toStringOrNull(raw.current_company_name) || null;
}

function normalizeExperienceEntry(entry: Record<string, unknown>): ExperienceEntry {
  return {
    title: toStringOrNull(entry.title) || toStringOrNull(entry.position) || toStringOrNull(entry.role),
    company: toStringOrNull(entry.company) || toStringOrNull(entry.company_name) || toStringOrNull(entry.organization),
    companyLogoUrl: toStringOrNull(entry.company_logo_url) || toStringOrNull(entry.logo) || toStringOrNull(entry.company_logo),
    startDate: toStringOrNull(entry.start_date),
    endDate: toStringOrNull(entry.end_date),
    location: toStringOrNull(entry.location),
    description: toStringOrNull(entry.description) || toStringOrNull(entry.summary),
  };
}

function normalizeEducationEntry(entry: Record<string, unknown>): EducationEntry {
  return {
    institution:
      toStringOrNull(entry.title) ||
      toStringOrNull(entry.school) ||
      toStringOrNull(entry.school_name) ||
      toStringOrNull(entry.institution),
    degree: toStringOrNull(entry.degree),
    field: toStringOrNull(entry.field) || toStringOrNull(entry.field_of_study),
    startYear: toStringOrNull(entry.start_year),
    endYear: toStringOrNull(entry.end_year),
    logoUrl: toStringOrNull(entry.institute_logo_url) || toStringOrNull(entry.school_logo_url) || toStringOrNull(entry.logo),
  };
}

function normalizePostEntry(entry: Record<string, unknown>): PostEntry {
  return {
    title: toStringOrNull(entry.title),
    link: toStringOrNull(entry.link),
    imageUrl: toStringOrNull(entry.img),
    interaction: toStringOrNull(entry.interaction),
  };
}

// ─── Confidence Scoring ──────────────────────────────────────────────────────

interface ConfidenceContext {
  email?: string;
  serpVerified?: boolean;
}

function assessConfidence(
  data: Partial<PersonData>,
  context: ConfidenceContext = {},
): { level: 'low' | 'medium' | 'high'; score: number; citations: ConfidenceCitation[] } {
  let score = 0;
  const citations: ConfidenceCitation[] = [];

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

  if (context.email && data.currentCompany) {
    const domain = (context.email.split('@')[1] || '').toLowerCase();
    const companyLower = data.currentCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainRoot = domain.split('.').slice(-2, -1)[0] || '';
    if (domainRoot && companyLower.includes(domainRoot)) {
      score += 1;
      citations.push({ factor: 'email-match', points: 1, description: `Email domain "${domain}" matches company` });
    }
  }

  if (context.serpVerified) {
    score += 1;
    citations.push({ factor: 'serp-verified', points: 1, description: 'LinkedIn URL found via Google Search' });
  }

  let level: 'low' | 'medium' | 'high' = 'low';
  if (score >= 8) level = 'high';
  else if (score >= 4) level = 'medium';

  return { level, score, citations };
}

// ─── ICP Analysis ────────────────────────────────────────────────────────────

export function deriveIcpProfile(data: Partial<PersonData>): IcpProfile {
  const result: IcpProfile = {
    isDecisionMaker: false,
    seniorityLevel: 'individual',
    department: null,
    icpSignals: [],
  };

  const title = (data.currentTitle || '').toLowerCase();

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

  if (result.isDecisionMaker) result.icpSignals.push('Key Decision Maker');
  if (result.seniorityLevel === 'c-level') result.icpSignals.push('C-Level Executive');
  if (result.seniorityLevel === 'founder') result.icpSignals.push('Founder/Owner');
  if (data.followers && data.followers > 5000) result.icpSignals.push('Industry Influencer');
  if (data.connections && data.connections >= 500) result.icpSignals.push('Well-Connected');
  if (data.experience && data.experience.length > 5) result.icpSignals.push('Experienced Professional');
  if (result.department) {
    const label = result.department.charAt(0).toUpperCase() + result.department.slice(1);
    result.icpSignals.push(`${label} Leader`);
  }

  return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function normalizeLinkedInProfile(
  rawProfile: Record<string, unknown> | null,
  source: PersonData['_source'],
  context: ConfidenceContext = {},
): PersonData {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    return {
      name: 'Unknown',
      firstName: '',
      lastName: '',
      avatarUrl: null,
      linkedinUrl: null,
      currentTitle: null,
      currentCompany: null,
      location: null,
      bio: null,
      experience: [],
      education: [],
      recentPosts: [],
      skills: [],
      connections: null,
      followers: null,
      companyId: null,
      companyLogoUrl: null,
      companyLinkedinUrl: null,
      companyIndustry: null,
      companySize: null,
      companyRevenue: null,
      companyDescription: null,
      companyWebsite: null,
      companyFounded: null,
      companyHeadquarters: null,
      companyFunding: null,
      companyProducts: null,
      companyTechnologies: null,
      recentNews: null,
      icp: null,
      _source: source || 'unknown',
      _fetchedAt: new Date().toISOString(),
      _confidence: 'low',
      _confidenceScore: 0,
      _confidenceCitations: [],
    };
  }

  const raw = rawProfile;
  const name = toStringOrNull(raw.name) || 'Unknown';
  const { firstName, lastName } = splitName(name);
  const cc = raw.current_company as Record<string, unknown> | undefined;

  const normalized: PersonData = {
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
    recentPosts: Array.isArray(raw.activity)
      ? raw.activity.map(normalizePostEntry)
      : Array.isArray(raw.posts)
        ? raw.posts.map(normalizePostEntry)
        : [],
    skills: [],
    connections: toIntOrNull(raw.connections),
    followers: toIntOrNull(raw.followers),
    companyId: toStringOrNull(cc?.company_id) || null,
    companyLogoUrl: toStringOrNull(cc?.logo) || null,
    companyLinkedinUrl: toStringOrNull(cc?.link) || null,
    companyIndustry: toStringOrNull(raw.company_industry || cc?.industry) || null,
    companySize: toStringOrNull(raw.company_size || raw.employee_count) || null,
    companyRevenue: toStringOrNull(raw.company_revenue || raw.revenue) || null,
    companyDescription: toStringOrNull(cc?.description) || null,
    companyWebsite: null,
    companyFounded: null,
    companyHeadquarters: null,
    companyFunding: null,
    companyProducts: null,
    companyTechnologies: null,
    recentNews: null,
    icp: null,
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
  normalized.icp = deriveIcpProfile(normalized);

  console.log(
    LOG_PREFIX,
    `Normalized "${name}" — confidence: ${conf.level} (${conf.score}/12), citations: ${conf.citations.length},`,
    `seniority: ${normalized.icp.seniorityLevel}, department: ${normalized.icp.department ?? 'unknown'},`,
    `signals: [${normalized.icp.icpSignals.join(', ')}]`,
  );

  return normalized;
}

export function pickBestProfile(
  rawProfiles: Array<Record<string, unknown>>,
  targetName: string,
  source: PersonData['_source'],
  context: ConfidenceContext = {},
): PersonData | null {
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) return null;
  if (rawProfiles.length === 1) return normalizeLinkedInProfile(rawProfiles[0], source, context);

  const nameLower = (targetName || '').toLowerCase().trim();

  const exactMatch = rawProfiles.find((p) => (toStringOrNull(p.name) || '').toLowerCase() === nameLower);
  if (exactMatch) return normalizeLinkedInProfile(exactMatch, source, context);

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

export function mergeBusinessEnrichedData(
  personData: PersonData,
  enrichedProfile: Record<string, unknown>,
): PersonData {
  if (!enrichedProfile || typeof enrichedProfile !== 'object') return personData;

  const merged = { ...personData };
  const cc = enrichedProfile.current_company as Record<string, unknown> | undefined;

  if (!merged.currentTitle && enrichedProfile.position) {
    merged.currentTitle = toStringOrNull(enrichedProfile.position);
  }
  if (!merged.currentCompany && enrichedProfile.current_company_name) {
    merged.currentCompany = toStringOrNull(enrichedProfile.current_company_name);
  }

  if (!merged.companyId) merged.companyId = toStringOrNull(cc?.company_id) || null;
  if (!merged.companyLogoUrl) merged.companyLogoUrl = toStringOrNull(cc?.logo) || null;
  if (!merged.companyLinkedinUrl) merged.companyLinkedinUrl = toStringOrNull(cc?.link) || null;
  if (!merged.companyIndustry) {
    merged.companyIndustry = toStringOrNull(enrichedProfile.company_industry || cc?.industry) || null;
  }
  if (!merged.companySize) {
    merged.companySize = toStringOrNull(enrichedProfile.company_size || enrichedProfile.employee_count) || null;
  }
  if (!merged.companyRevenue) {
    merged.companyRevenue = toStringOrNull(enrichedProfile.company_revenue || enrichedProfile.revenue) || null;
  }
  if (!merged.companyDescription) merged.companyDescription = toStringOrNull(cc?.description) || null;

  merged.skills = Array.isArray(enrichedProfile.skills)
    ? (enrichedProfile.skills as Array<unknown>)
        .map((s) => (typeof s === 'string' ? s : toStringOrNull((s as Record<string, unknown>)?.name)))
        .filter((s): s is string => !!s)
    : merged.skills || [];

  merged.icp = deriveIcpProfile(merged);

  console.log(LOG_PREFIX, 'Merged business enriched data for:', merged.name);
  return merged;
}
