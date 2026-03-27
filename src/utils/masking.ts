// PreMeet — Freemium Data Masking
// Masks high-value fields for unauthenticated users to encourage sign-in.

import type { PersonData, ExperienceEntry, EducationEntry } from '../background/waterfall-data-fetch/types';

/**
 * Masks a job title: show first word only + "..."
 * e.g. "Senior Software Engineer" → "Senior..."
 */
export function maskTitle(title: string | null): string | null {
  if (!title) return null;
  const firstWord = title.split(/\s+/)[0];
  if (firstWord === title) return title; // single word, nothing to mask
  return `${firstWord}...`;
}

/**
 * Masks experience: show company names but mask titles/dates
 */
export function maskExperience(entries: ExperienceEntry[]): ExperienceEntry[] {
  return entries.map((e) => ({
    ...e,
    title: e.title ? maskTitle(e.title) : null,
    startDate: null,
    endDate: null,
    description: null,
  }));
}

/**
 * Masks education: show school names but mask degree/field
 */
export function maskEducation(entries: EducationEntry[]): EducationEntry[] {
  return entries.map((e) => ({
    ...e,
    degree: e.degree ? '****' : null,
    field: e.field ? '****' : null,
    startYear: null,
    endYear: null,
  }));
}

/**
 * Returns a masked copy of PersonData for freemium preview.
 * Visible: name, company name, masked title, company logos, avatars.
 * Hidden/masked: full title, experience dates/titles, education details, skills, bio, social stats.
 */
export function maskPersonData(pd: PersonData): PersonData {
  return {
    ...pd,
    // Mask title
    currentTitle: maskTitle(pd.currentTitle),
    // Hide bio
    bio: pd.bio ? 'Sign in to view full bio...' : null,
    // Mask experience
    experience: maskExperience(pd.experience),
    // Mask education
    education: maskEducation(pd.education),
    // Hide skills entirely (will show count in UI)
    skills: [],
    // Hide social stats
    connections: null,
    followers: null,
    // Hide recent posts
    recentPosts: [],
    // Keep company intelligence headers but mask values
    companyRevenue: pd.companyRevenue ? '****' : null,
    companyFunding: pd.companyFunding ? '****' : null,
    companyProducts: pd.companyProducts ? '****' : null,
    companyTechnologies: pd.companyTechnologies ? '****' : null,
    recentNews: pd.recentNews ? '****' : null,
  };
}

/** Count of skills to display in preview (e.g. "12 skills") */
export function skillsPreviewCount(pd: PersonData): number {
  return pd.skills?.length ?? 0;
}
