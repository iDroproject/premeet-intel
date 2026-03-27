import { describe, it, expect } from 'vitest';
import { maskTitle, maskExperience, maskEducation, maskPersonData, skillsPreviewCount } from '../../src/utils/masking';
import type { PersonData, ExperienceEntry, EducationEntry } from '../../src/background/waterfall-data-fetch/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makePersonData(overrides: Partial<PersonData> = {}): PersonData {
  return {
    name: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    avatarUrl: 'https://example.com/avatar.jpg',
    linkedinUrl: 'https://linkedin.com/in/janesmith',
    currentTitle: 'Senior Software Engineer',
    currentCompany: 'Acme Corp',
    location: 'San Francisco, CA',
    bio: 'Experienced engineer building great products',
    email: 'jane@acme.com',
    experience: [
      { title: 'Senior Software Engineer', company: 'Acme Corp', companyLogoUrl: null, startDate: '2020-01', endDate: null, location: 'SF', description: 'Building stuff' },
      { title: 'Software Engineer', company: 'StartupCo', companyLogoUrl: null, startDate: '2017-06', endDate: '2019-12', location: 'NYC', description: 'Built things' },
    ],
    education: [
      { institution: 'MIT', degree: 'Bachelor of Science', field: 'Computer Science', startYear: '2013', endYear: '2017', logoUrl: null },
    ],
    recentPosts: [{ title: 'My post', link: 'https://example.com', imageUrl: null, interaction: '50 likes' }],
    skills: ['TypeScript', 'React', 'Node.js', 'Python', 'AWS'],
    connections: 500,
    followers: 1200,
    companyId: null,
    companyLogoUrl: null,
    companyLinkedinUrl: null,
    companyIndustry: 'Software',
    companySize: '51-200',
    companyRevenue: '$10M ARR',
    companyDescription: 'A software company',
    companyWebsite: 'https://acme.com',
    companyFounded: '2015',
    companyHeadquarters: 'San Francisco',
    companyFunding: '$50M Series B',
    companyProducts: 'SaaS Platform',
    companyTechnologies: 'React, Node.js',
    recentNews: 'Series B funding announcement',
    icp: null,
    _source: 'scraper',
    _fetchedAt: new Date().toISOString(),
    _confidence: 'high',
    _confidenceScore: 95,
    _confidenceCitations: [],
    ...overrides,
  };
}

// ─── maskTitle ──────────────────────────────────────────────────────────────

describe('maskTitle', () => {
  it('shows first word + "..." for multi-word titles', () => {
    expect(maskTitle('Senior Software Engineer')).toBe('Senior...');
  });

  it('returns single-word title unmasked', () => {
    expect(maskTitle('CEO')).toBe('CEO');
  });

  it('returns null for null input', () => {
    expect(maskTitle(null)).toBeNull();
  });
});

// ─── maskExperience ─────────────────────────────────────────────────────────

describe('maskExperience', () => {
  it('preserves company name but masks title, dates, and description', () => {
    const entries: ExperienceEntry[] = [
      { title: 'Senior Engineer', company: 'Acme', companyLogoUrl: 'logo.png', startDate: '2020', endDate: null, location: 'SF', description: 'Led team' },
    ];
    const masked = maskExperience(entries);
    expect(masked).toHaveLength(1);
    expect(masked[0].company).toBe('Acme');
    expect(masked[0].companyLogoUrl).toBe('logo.png');
    expect(masked[0].location).toBe('SF');
    expect(masked[0].title).toBe('Senior...');
    expect(masked[0].startDate).toBeNull();
    expect(masked[0].endDate).toBeNull();
    expect(masked[0].description).toBeNull();
  });

  it('handles entries with null title', () => {
    const entries: ExperienceEntry[] = [
      { title: null, company: 'Acme', companyLogoUrl: null, startDate: '2020', endDate: null, location: null, description: null },
    ];
    const masked = maskExperience(entries);
    expect(masked[0].title).toBeNull();
  });
});

// ─── maskEducation ──────────────────────────────────────────────────────────

describe('maskEducation', () => {
  it('preserves institution but masks degree, field, and years', () => {
    const entries: EducationEntry[] = [
      { institution: 'MIT', degree: 'BS', field: 'Computer Science', startYear: '2013', endYear: '2017', logoUrl: 'mit.png' },
    ];
    const masked = maskEducation(entries);
    expect(masked).toHaveLength(1);
    expect(masked[0].institution).toBe('MIT');
    expect(masked[0].logoUrl).toBe('mit.png');
    expect(masked[0].degree).toBe('****');
    expect(masked[0].field).toBe('****');
    expect(masked[0].startYear).toBeNull();
    expect(masked[0].endYear).toBeNull();
  });

  it('returns null for null degree/field instead of "****"', () => {
    const entries: EducationEntry[] = [
      { institution: 'MIT', degree: null, field: null, startYear: null, endYear: null, logoUrl: null },
    ];
    const masked = maskEducation(entries);
    expect(masked[0].degree).toBeNull();
    expect(masked[0].field).toBeNull();
  });
});

// ─── maskPersonData ─────────────────────────────────────────────────────────

describe('maskPersonData', () => {
  it('masks title to first word only', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.currentTitle).toBe('Senior...');
  });

  it('replaces bio with sign-in prompt', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.bio).toBe('Sign in to view full bio...');
  });

  it('keeps bio null if originally null', () => {
    const pd = makePersonData({ bio: null });
    const masked = maskPersonData(pd);
    expect(masked.bio).toBeNull();
  });

  it('empties skills array', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.skills).toEqual([]);
  });

  it('nullifies social stats', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.connections).toBeNull();
    expect(masked.followers).toBeNull();
  });

  it('empties recentPosts', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.recentPosts).toEqual([]);
  });

  it('masks company intelligence fields with "****"', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.companyRevenue).toBe('****');
    expect(masked.companyFunding).toBe('****');
    expect(masked.companyProducts).toBe('****');
    expect(masked.companyTechnologies).toBe('****');
    expect(masked.recentNews).toBe('****');
  });

  it('preserves null company fields as null', () => {
    const pd = makePersonData({
      companyRevenue: null,
      companyFunding: null,
      companyProducts: null,
      companyTechnologies: null,
      recentNews: null,
    });
    const masked = maskPersonData(pd);
    expect(masked.companyRevenue).toBeNull();
    expect(masked.companyFunding).toBeNull();
    expect(masked.companyProducts).toBeNull();
    expect(masked.companyTechnologies).toBeNull();
    expect(masked.recentNews).toBeNull();
  });

  it('preserves identity fields (name, avatar, company name, linkedin URL)', () => {
    const pd = makePersonData();
    const masked = maskPersonData(pd);
    expect(masked.name).toBe('Jane Smith');
    expect(masked.firstName).toBe('Jane');
    expect(masked.lastName).toBe('Smith');
    expect(masked.avatarUrl).toBe('https://example.com/avatar.jpg');
    expect(masked.currentCompany).toBe('Acme Corp');
    expect(masked.linkedinUrl).toBe('https://linkedin.com/in/janesmith');
  });

  it('does not mutate the original PersonData', () => {
    const pd = makePersonData();
    const originalTitle = pd.currentTitle;
    maskPersonData(pd);
    expect(pd.currentTitle).toBe(originalTitle);
    expect(pd.skills).toHaveLength(5);
  });
});

// ─── skillsPreviewCount ─────────────────────────────────────────────────────

describe('skillsPreviewCount', () => {
  it('returns count of skills', () => {
    const pd = makePersonData();
    expect(skillsPreviewCount(pd)).toBe(5);
  });

  it('returns 0 for empty skills', () => {
    const pd = makePersonData({ skills: [] });
    expect(skillsPreviewCount(pd)).toBe(0);
  });
});
