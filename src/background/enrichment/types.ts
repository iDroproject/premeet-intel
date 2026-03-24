// PreMeet – Enrichment Pipeline Types
// Shared TypeScript interfaces for the waterfall enrichment pipeline.

// ─── Person Data ─────────────────────────────────────────────────────────────

export interface ExperienceEntry {
  title: string | null;
  company: string | null;
  companyLogoUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  description: string | null;
}

export interface EducationEntry {
  institution: string | null;
  degree: string | null;
  field: string | null;
  startYear: string | null;
  endYear: string | null;
  logoUrl: string | null;
}

export interface PostEntry {
  title: string | null;
  link: string | null;
  imageUrl: string | null;
  interaction: string | null;
}

export interface IcpProfile {
  isDecisionMaker: boolean;
  seniorityLevel: 'individual' | 'manager' | 'director' | 'vp' | 'c-level' | 'founder';
  department: 'engineering' | 'sales' | 'marketing' | 'product' | 'operations' | 'hr' | 'finance' | 'other' | null;
  icpSignals: string[];
}

export interface ConfidenceCitation {
  factor: string;
  points: number;
  description: string;
}

export interface PersonData {
  // Identity
  name: string;
  firstName: string;
  lastName: string;

  // Profile
  avatarUrl: string | null;
  linkedinUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  bio: string | null;
  email?: string;

  // Lists
  experience: ExperienceEntry[];
  education: EducationEntry[];
  recentPosts: PostEntry[];
  skills: string[];

  // Social signals
  connections: number | null;
  followers: number | null;

  // Company intelligence
  companyId: string | null;
  companyLogoUrl: string | null;
  companyLinkedinUrl: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  companyRevenue: string | null;
  companyDescription: string | null;
  companyWebsite: string | null;
  companyFounded: string | null;
  companyHeadquarters: string | null;
  companyFunding: string | null;
  companyProducts: string | null;
  companyTechnologies: string | null;
  recentNews: string | null;

  // ICP Analysis
  icp: IcpProfile | null;

  // Metadata
  _source: 'scraper' | 'filter' | 'error' | 'unknown';
  _fetchedAt: string;
  _confidence: 'low' | 'medium' | 'high';
  _confidenceScore: number;
  _confidenceCitations: ConfidenceCitation[];
}

// ─── Pipeline Progress ───────────────────────────────────────────────────────

export interface StepState {
  id: string;
  label: string;
  icon: string;
  percent: number;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
}

export interface ProgressPayload {
  label: string;
  percent: number;
  step: number;
  totalSteps: number;
  stepId: string;
  stepStatus: string;
  personName: string;
  stepsState: StepState[];
}

// ─── Waterfall Input ─────────────────────────────────────────────────────────

export interface WaterfallPayload {
  name: string;
  email: string;
  company: string;
}

// ─── Layer Results ───────────────────────────────────────────────────────────

export interface LayerResult {
  success: boolean;
  error?: string;
  elapsedMs?: number;
  [key: string]: unknown;
}

// ─── Deep Lookup Spec ────────────────────────────────────────────────────────

export interface DeepLookupSpec {
  input_schema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
  };
  output_schema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
  };
}

// ─── Company Info (SERP) ─────────────────────────────────────────────────────

export interface CompanyInfo {
  company_description: string | null;
  company_website: string | null;
  company_industry: string | null;
  company_founded_year: string | null;
  company_headquarters: string | null;
  products_services: string | null;
  company_funding: string | null;
  recent_news: string | null;
}

// ─── Message Types ───────────────────────────────────────────────────────────

export const MessageType = {
  FETCH_PERSON_BACKGROUND: 'FETCH_PERSON_BACKGROUND',
  FETCH_PROGRESS: 'FETCH_PROGRESS',
  INTERIM_PERSON_DATA: 'INTERIM_PERSON_DATA',
  OPEN_SIDE_PANEL: 'OPEN_SIDE_PANEL',
  PERSON_BACKGROUND_RESULT: 'PERSON_BACKGROUND_RESULT',
  GET_CACHE_STATS: 'GET_CACHE_STATS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_LOGS: 'GET_LOGS',
  GET_HISTORY: 'GET_HISTORY',
  PING: 'PING',
  ENRICH_PROFILE: 'ENRICH_PROFILE',
  ENRICH_PROFILE_RESULT: 'ENRICH_PROFILE_RESULT',
  GET_ANALYTICS: 'GET_ANALYTICS',
} as const;

export type MessageTypeKey = keyof typeof MessageType;
