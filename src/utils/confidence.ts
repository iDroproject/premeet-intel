// PreMeet – Confidence / Match Scoring
// Assesses how well an enriched profile matches the original calendar attendee.
// Produces a 0–100 score with weighted factor breakdown.

import type { PersonData, ConfidenceCitation } from '../background/waterfall-data-fetch/types';
import type { Attendee } from '../types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'high' | 'good' | 'partial' | 'low';

export interface ConfidenceFactors {
  emailMatch: number;      // 0–40
  nameMatch: number;       // 0–25
  domainMatch: number;     // 0–20
  completeness: number;    // 0–15
}

export interface ConfidenceResult {
  score: number;           // 0–100
  factors: ConfidenceFactors;
  level: ConfidenceLevel;
  citations: ConfidenceCitation[];
}

// ─── Weights ────────────────────────────────────────────────────────────────

const WEIGHT_EMAIL   = 40;
const WEIGHT_NAME    = 25;
const WEIGHT_DOMAIN  = 20;
const WEIGHT_COMPLETE = 15;

// ─── Fuzzy Name Matching ────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ');
}

function nameParts(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean);
}

/**
 * Fuzzy name comparison: handles exact match, first/last swap, and partial overlap.
 * Returns 0–1.
 */
export function fuzzyNameScore(calendarName: string, enrichedName: string): number {
  if (!calendarName || !enrichedName) return 0;

  const a = normalizeName(calendarName);
  const b = normalizeName(enrichedName);

  // Exact match after normalisation
  if (a === b) return 1.0;

  const partsA = nameParts(calendarName);
  const partsB = nameParts(enrichedName);

  if (partsA.length === 0 || partsB.length === 0) return 0;

  // Check first/last swap (e.g. "John Smith" vs "Smith John")
  if (
    partsA.length >= 2 &&
    partsB.length >= 2 &&
    partsA[0] === partsB[partsB.length - 1] &&
    partsA[partsA.length - 1] === partsB[0]
  ) {
    return 0.95;
  }

  // Count how many parts from the shorter name appear in the longer name
  const shorter = partsA.length <= partsB.length ? partsA : partsB;
  const longer = partsA.length <= partsB.length ? partsB : partsA;

  let matched = 0;
  for (const part of shorter) {
    if (longer.includes(part)) {
      matched++;
    } else {
      // Check prefix match (e.g. "Dan" vs "Daniel")
      const prefixMatch = longer.some(
        (lp) => lp.startsWith(part) || part.startsWith(lp),
      );
      if (prefixMatch) matched += 0.7;
    }
  }

  const overlap = matched / Math.max(shorter.length, 1);

  // Single first-name match when the calendar only provides one name
  if (shorter.length === 1 && matched >= 0.7) return 0.6;

  return Math.min(overlap, 1.0);
}

// ─── Domain Matching ────────────────────────────────────────────────────────

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
  'live.com', 'msn.com', 'me.com', 'mac.com',
]);

function emailDomain(email: string): string | null {
  const parts = (email || '').toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : null;
}

function domainRoot(domain: string): string {
  const parts = domain.split('.');
  // Return second-level domain (e.g. "acme" from "acme.com")
  return parts.length >= 2 ? parts[parts.length - 2] : domain;
}

/**
 * Checks whether the attendee's email domain matches the enriched company domain/website.
 * Returns 0 or 1.
 */
function domainMatchScore(
  attendeeEmail: string,
  enrichedData: PersonData,
): number {
  const domain = emailDomain(attendeeEmail);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return 0;

  const root = domainRoot(domain);

  // Check against company website
  if (enrichedData.companyWebsite) {
    const websiteDomain = enrichedData.companyWebsite
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (domainRoot(websiteDomain) === root) return 1;
  }

  // Check against company LinkedIn URL domain slug
  if (enrichedData.companyLinkedinUrl) {
    const slug = enrichedData.companyLinkedinUrl
      .replace(/^https?:\/\/.*linkedin\.com\/company\//, '')
      .replace(/\/.*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (slug && root.includes(slug)) return 1;
    if (slug && slug.includes(root)) return 1;
  }

  // Check company name contains the domain root (or vice versa)
  if (enrichedData.currentCompany) {
    const companyNorm = enrichedData.currentCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (companyNorm && (companyNorm.includes(root) || root.includes(companyNorm))) return 1;
  }

  return 0;
}

// ─── Email Match ────────────────────────────────────────────────────────────

/**
 * Checks whether the enriched person's email matches the attendee email,
 * or if the LinkedIn URL was discovered via email-based SERP search.
 * Returns 0 or 1.
 */
function emailMatchScore(
  attendeeEmail: string,
  enrichedData: PersonData,
  serpVerified: boolean,
): number {
  if (!attendeeEmail) return 0;

  const normalised = attendeeEmail.trim().toLowerCase();

  // Direct email match from enrichment
  if (enrichedData.email && enrichedData.email.trim().toLowerCase() === normalised) {
    return 1;
  }

  // SERP verified means the LinkedIn profile was found by searching for this email
  if (serpVerified) return 0.8;

  return 0;
}

// ─── Profile Completeness ───────────────────────────────────────────────────

const COMPLETENESS_FIELDS: Array<(pd: PersonData) => boolean> = [
  (pd) => !!pd.avatarUrl,
  (pd) => !!pd.currentTitle,
  (pd) => !!pd.currentCompany,
  (pd) => !!pd.bio,
  (pd) => (pd.experience?.length ?? 0) > 0,
  (pd) => (pd.education?.length ?? 0) > 0,
  (pd) => !!pd.linkedinUrl,
  (pd) => !!pd.location,
  (pd) => (pd.skills?.length ?? 0) > 0,
  (pd) => pd.connections != null,
];

function completenessScore(enrichedData: PersonData): number {
  const filled = COMPLETENESS_FIELDS.filter((fn) => fn(enrichedData)).length;
  return filled / COMPLETENESS_FIELDS.length;
}

// ─── Level Derivation ───────────────────────────────────────────────────────

function scoreToLevel(score: number): ConfidenceLevel {
  if (score >= 90) return 'high';
  if (score >= 70) return 'good';
  if (score >= 50) return 'partial';
  return 'low';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  attendeeName: string;
  attendeeEmail: string;
  attendeeCompany: string | null;
}

/**
 * Compute a 0–100 confidence score for an enriched person profile.
 */
export function computeConfidence(
  attendee: ConfidenceInput,
  enrichedData: PersonData,
  context: { serpVerified?: boolean } = {},
): ConfidenceResult {
  const citations: ConfidenceCitation[] = [];

  // 1. Email match (0–40)
  const emailRaw = emailMatchScore(attendee.attendeeEmail, enrichedData, !!context.serpVerified);
  const emailPoints = Math.round(emailRaw * WEIGHT_EMAIL);
  if (emailRaw === 1) {
    citations.push({ factor: 'Email Match', points: emailPoints, description: 'Direct email match from enrichment data' });
  } else if (emailRaw > 0) {
    citations.push({ factor: 'Email Match', points: emailPoints, description: 'LinkedIn URL found via email search (SERP)' });
  } else {
    citations.push({ factor: 'Email Match', points: 0, description: 'No email verification available' });
  }

  // 2. Name match (0–25)
  const nameRaw = fuzzyNameScore(attendee.attendeeName, enrichedData.name);
  const namePoints = Math.round(nameRaw * WEIGHT_NAME);
  if (nameRaw >= 1) {
    citations.push({ factor: 'Name Match', points: namePoints, description: 'Exact name match' });
  } else if (nameRaw >= 0.9) {
    citations.push({ factor: 'Name Match', points: namePoints, description: 'Name match (reordered)' });
  } else if (nameRaw > 0) {
    citations.push({ factor: 'Name Match', points: namePoints, description: `Partial name match (${Math.round(nameRaw * 100)}%)` });
  } else {
    citations.push({ factor: 'Name Match', points: 0, description: 'Name does not match' });
  }

  // 3. Domain match (0–20)
  const domainRaw = domainMatchScore(attendee.attendeeEmail, enrichedData);
  const domainPoints = Math.round(domainRaw * WEIGHT_DOMAIN);
  if (domainRaw > 0) {
    citations.push({ factor: 'Domain Match', points: domainPoints, description: 'Email domain matches enriched company' });
  } else {
    const domain = emailDomain(attendee.attendeeEmail);
    if (domain && FREE_EMAIL_DOMAINS.has(domain)) {
      citations.push({ factor: 'Domain Match', points: 0, description: 'Free email provider — cannot verify company' });
    } else {
      citations.push({ factor: 'Domain Match', points: 0, description: 'Email domain does not match company' });
    }
  }

  // 4. Profile completeness (0–15)
  const compRaw = completenessScore(enrichedData);
  const compPoints = Math.round(compRaw * WEIGHT_COMPLETE);
  citations.push({
    factor: 'Completeness',
    points: compPoints,
    description: `${Math.round(compRaw * 100)}% of profile fields populated`,
  });

  const factors: ConfidenceFactors = {
    emailMatch: emailPoints,
    nameMatch: namePoints,
    domainMatch: domainPoints,
    completeness: compPoints,
  };

  const score = emailPoints + namePoints + domainPoints + compPoints;
  const level = scoreToLevel(score);

  return { score, factors, level, citations };
}

/**
 * Convenience wrapper that accepts an Attendee object directly.
 */
export function computeConfidenceFromAttendee(
  attendee: Attendee,
  enrichedData: PersonData,
  context: { serpVerified?: boolean } = {},
): ConfidenceResult {
  return computeConfidence(
    {
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      attendeeCompany: attendee.company,
    },
    enrichedData,
    context,
  );
}
