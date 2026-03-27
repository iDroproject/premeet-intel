import { describe, it, expect } from 'vitest';
import { computeConfidence, fuzzyNameScore } from '../../src/utils/confidence';
import type { PersonData } from '../../src/background/waterfall-data-fetch/types';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makePersonData(overrides: Partial<PersonData> = {}): PersonData {
  return {
    name: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    avatarUrl: 'https://example.com/avatar.jpg',
    linkedinUrl: 'https://linkedin.com/in/janesmith',
    currentTitle: 'VP of Engineering',
    currentCompany: 'Acme Corp',
    location: 'San Francisco, CA',
    bio: 'Experienced engineering leader',
    email: 'jane@acme.com',
    experience: [{ title: 'VP Engineering', company: 'Acme Corp', companyLogoUrl: null, startDate: '2020', endDate: null, location: 'SF', description: null }],
    education: [{ institution: 'MIT', degree: 'BS', field: 'CS', startYear: '2008', endYear: '2012', logoUrl: null }],
    recentPosts: [],
    skills: ['Leadership', 'TypeScript'],
    connections: 500,
    followers: 1200,
    companyId: null,
    companyLogoUrl: null,
    companyLinkedinUrl: 'https://linkedin.com/company/acme',
    companyIndustry: 'Software',
    companySize: '51-200',
    companyRevenue: '$10M',
    companyDescription: 'A software company',
    companyWebsite: 'https://acme.com',
    companyFounded: '2015',
    companyHeadquarters: 'San Francisco',
    companyFunding: '$50M',
    companyProducts: 'SaaS Platform',
    companyTechnologies: 'React, Node.js',
    recentNews: 'Series B funding',
    icp: null,
    _source: 'scraper',
    _fetchedAt: new Date().toISOString(),
    _confidence: 'high',
    _confidenceScore: 95,
    _confidenceCitations: [],
    ...overrides,
  };
}

// ─── fuzzyNameScore ─────────────────────────────────────────────────────────

describe('fuzzyNameScore', () => {
  it('returns 1.0 for exact match', () => {
    expect(fuzzyNameScore('John Smith', 'John Smith')).toBe(1.0);
  });

  it('returns 1.0 for case-insensitive exact match', () => {
    expect(fuzzyNameScore('john smith', 'JOHN SMITH')).toBe(1.0);
  });

  it('returns 1.0 ignoring punctuation and extra whitespace', () => {
    expect(fuzzyNameScore('  Jane  O\'Brien  ', 'jane obrien')).toBe(1.0);
  });

  it('returns 0.95 for first/last name swap', () => {
    expect(fuzzyNameScore('John Smith', 'Smith John')).toBe(0.95);
  });

  it('handles partial name overlap', () => {
    const score = fuzzyNameScore('John Michael Smith', 'John Smith');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0.6 for single first-name match', () => {
    expect(fuzzyNameScore('John', 'John Smith')).toBe(0.6);
  });

  it('handles prefix matching (Dan vs Daniel)', () => {
    const score = fuzzyNameScore('Dan Smith', 'Daniel Smith');
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns 0 for empty strings', () => {
    expect(fuzzyNameScore('', 'John')).toBe(0);
    expect(fuzzyNameScore('John', '')).toBe(0);
    expect(fuzzyNameScore('', '')).toBe(0);
  });

  it('returns 0 for completely different names', () => {
    expect(fuzzyNameScore('Alice Brown', 'Bob Johnson')).toBe(0);
  });
});

// ─── computeConfidence ──────────────────────────────────────────────────────

describe('computeConfidence', () => {
  it('returns high confidence for exact email + name + domain match with complete profile', () => {
    const pd = makePersonData({ email: 'jane@acme.com' });
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      pd,
    );
    expect(result.level).toBe('high');
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.factors.emailMatch).toBe(40); // direct email match = 1 * 40
    expect(result.factors.nameMatch).toBe(25);  // exact name = 1 * 25
    expect(result.factors.domainMatch).toBe(20); // domain match = 1 * 20
    expect(result.citations).toHaveLength(4);
  });

  it('returns lower score when email does not match', () => {
    const pd = makePersonData({ email: 'different@other.com' });
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      pd,
    );
    expect(result.factors.emailMatch).toBe(0);
    expect(result.score).toBeLessThan(90);
  });

  it('gives 0.8 * 40 = 32 email points when SERP verified', () => {
    const pd = makePersonData({ email: undefined });
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      pd,
      { serpVerified: true },
    );
    expect(result.factors.emailMatch).toBe(32); // 0.8 * 40
  });

  it('gives 0 domain points for free email providers', () => {
    const pd = makePersonData();
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@gmail.com', attendeeCompany: null },
      pd,
    );
    expect(result.factors.domainMatch).toBe(0);
    const domainCitation = result.citations.find(c => c.factor === 'Domain Match');
    expect(domainCitation?.description).toContain('Free email provider');
  });

  it('gives full domain points when email domain matches company website', () => {
    const pd = makePersonData({ companyWebsite: 'https://acme.com' });
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      pd,
    );
    expect(result.factors.domainMatch).toBe(20);
  });

  it('maps score to correct confidence levels', () => {
    // Low score: no matches, minimal profile
    const sparse = makePersonData({
      email: undefined,
      name: 'Completely Different',
      avatarUrl: null,
      currentTitle: null,
      currentCompany: null,
      bio: null,
      experience: [],
      education: [],
      linkedinUrl: null,
      location: null,
      skills: [],
      connections: null,
    });
    const low = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@gmail.com', attendeeCompany: null },
      sparse,
    );
    expect(low.level).toBe('low');
    expect(low.score).toBeLessThan(50);
  });

  it('completeness score reflects filled fields', () => {
    const full = makePersonData();
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      full,
    );
    // All 10 completeness fields filled → 15 points
    expect(result.factors.completeness).toBe(15);
  });

  it('completeness is 0 when no profile fields are filled', () => {
    const empty = makePersonData({
      avatarUrl: null,
      currentTitle: null,
      currentCompany: null,
      bio: null,
      experience: [],
      education: [],
      linkedinUrl: null,
      location: null,
      skills: [],
      connections: null,
    });
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@gmail.com', attendeeCompany: null },
      empty,
    );
    expect(result.factors.completeness).toBe(0);
  });

  it('generates exactly 4 citations', () => {
    const pd = makePersonData();
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: null },
      pd,
    );
    expect(result.citations).toHaveLength(4);
    const factors = result.citations.map(c => c.factor);
    expect(factors).toEqual(['Email Match', 'Name Match', 'Domain Match', 'Completeness']);
  });

  it('score equals sum of all factor points', () => {
    const pd = makePersonData();
    const result = computeConfidence(
      { attendeeName: 'Jane Smith', attendeeEmail: 'jane@acme.com', attendeeCompany: 'Acme Corp' },
      pd,
    );
    const sum = result.factors.emailMatch + result.factors.nameMatch + result.factors.domainMatch + result.factors.completeness;
    expect(result.score).toBe(sum);
  });
});
