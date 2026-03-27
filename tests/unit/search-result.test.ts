import { describe, it, expect } from 'vitest';
import type { PersonData, SearchResult } from '../../src/background/waterfall-data-fetch/types';

/**
 * Tests the SearchResult ↔ PersonData contract.
 * _toSearchResult is private on WaterfallOrchestrator, so we replicate
 * the mapping here to verify the type contract stays consistent.
 */
function toSearchResult(person: PersonData): SearchResult {
  return {
    name: person.name,
    firstName: person.firstName,
    lastName: person.lastName,
    avatarUrl: person.avatarUrl,
    currentTitle: person.currentTitle,
    currentCompany: person.currentCompany,
    location: person.location,
    connections: person.connections,
    followers: person.followers,
    linkedinUrl: person.linkedinUrl,
    confidence: person._confidence,
    confidenceScore: person._confidenceScore,
  };
}

function makePersonData(): PersonData {
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
    experience: [{ title: 'VP', company: 'Acme', companyLogoUrl: null, startDate: '2020', endDate: null, location: 'SF', description: null }],
    education: [{ institution: 'MIT', degree: 'BS', field: 'CS', startYear: '2008', endYear: '2012', logoUrl: null }],
    recentPosts: [],
    skills: ['TypeScript', 'React'],
    connections: 500,
    followers: 1200,
    companyId: null,
    companyLogoUrl: null,
    companyLinkedinUrl: null,
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
    recentNews: 'Funding round',
    icp: null,
    _source: 'scraper',
    _fetchedAt: new Date().toISOString(),
    _confidence: 'high',
    _confidenceScore: 95,
    _confidenceCitations: [],
  };
}

describe('SearchResult mapping from PersonData', () => {
  it('extracts only the search-result subset of fields', () => {
    const pd = makePersonData();
    const sr = toSearchResult(pd);

    expect(sr.name).toBe('Jane Smith');
    expect(sr.firstName).toBe('Jane');
    expect(sr.lastName).toBe('Smith');
    expect(sr.avatarUrl).toBe('https://example.com/avatar.jpg');
    expect(sr.currentTitle).toBe('VP of Engineering');
    expect(sr.currentCompany).toBe('Acme Corp');
    expect(sr.location).toBe('San Francisco, CA');
    expect(sr.connections).toBe(500);
    expect(sr.followers).toBe(1200);
    expect(sr.linkedinUrl).toBe('https://linkedin.com/in/janesmith');
    expect(sr.confidence).toBe('high');
    expect(sr.confidenceScore).toBe(95);
  });

  it('does not include enrichment-only fields', () => {
    const pd = makePersonData();
    const sr = toSearchResult(pd) as Record<string, unknown>;

    // These fields should NOT appear on SearchResult
    expect(sr).not.toHaveProperty('bio');
    expect(sr).not.toHaveProperty('experience');
    expect(sr).not.toHaveProperty('education');
    expect(sr).not.toHaveProperty('skills');
    expect(sr).not.toHaveProperty('recentPosts');
    expect(sr).not.toHaveProperty('companyRevenue');
    expect(sr).not.toHaveProperty('companyFunding');
    expect(sr).not.toHaveProperty('icp');
    expect(sr).not.toHaveProperty('_source');
    expect(sr).not.toHaveProperty('_fetchedAt');
  });

  it('has exactly 12 fields', () => {
    const pd = makePersonData();
    const sr = toSearchResult(pd);
    expect(Object.keys(sr)).toHaveLength(12);
  });

  it('handles null fields gracefully', () => {
    const pd = makePersonData();
    pd.avatarUrl = null;
    pd.currentTitle = null;
    pd.currentCompany = null;
    pd.location = null;
    pd.connections = null;
    pd.followers = null;
    pd.linkedinUrl = null;

    const sr = toSearchResult(pd);
    expect(sr.avatarUrl).toBeNull();
    expect(sr.currentTitle).toBeNull();
    expect(sr.currentCompany).toBeNull();
    expect(sr.location).toBeNull();
    expect(sr.connections).toBeNull();
    expect(sr.followers).toBeNull();
    expect(sr.linkedinUrl).toBeNull();
  });

  it('maps confidence levels correctly', () => {
    const pd = makePersonData();

    for (const level of ['high', 'good', 'partial', 'low'] as const) {
      pd._confidence = level;
      pd._confidenceScore = level === 'high' ? 95 : level === 'good' ? 75 : level === 'partial' ? 55 : 30;
      const sr = toSearchResult(pd);
      expect(sr.confidence).toBe(level);
      expect(sr.confidenceScore).toBe(pd._confidenceScore);
    }
  });
});
