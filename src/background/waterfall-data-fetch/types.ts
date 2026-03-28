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
  _confidence: 'high' | 'good' | 'partial' | 'low';
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

// ─── Company Data (from enrichment-company edge function) ────────────────────

export interface CompanyData {
  name: string;
  linkedinUrl: string | null;
  logo: string | null;
  industry: string | null;
  sizeRange: string | null;
  revenueRange: string | null;
  website: string | null;
  foundedYear: number | null;
  hqAddress: string | null;
  description: string | null;
  fundingTotal: string | null;
  fundingLastRound: string | null;
  fundingInvestors: string[];
  products: string[];
  technologies: string[];
  recentNews: Array<{ title: string; url: string; date: string }>;
  intentSignals: Array<{ signal: string; detail: string }>;
}

// ─── Contact Info (from enrichment-contact edge function) ─────────────────────

export interface ContactInfo {
  phone: string | null;
  email: string | null;
  sources: string[];
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

// ─── Company Intel (multi-source enrichment) ────────────────────────────────

/** Aggregated company intelligence from Crunchbase, ZoomInfo, and other sources. */
export interface CompanyIntel {
  // Crunchbase-sourced fields
  crunchbaseFunding: {
    totalRaised: string | null;
    lastRound: string | null;
    lastRoundDate: string | null;
    investors: string[];
    stage: string | null;
  } | null;
  crunchbaseProfile: {
    categories: string[];
    foundedDate: string | null;
    numEmployees: string | null;
    shortDescription: string | null;
    ipoStatus: string | null;
    acquiredBy: string | null;
  } | null;

  // ZoomInfo-sourced fields
  zoomInfoFirmographics: {
    revenue: string | null;
    revenueRange: string | null;
    employeeCount: number | null;
    employeeRange: string | null;
    industry: string | null;
    subIndustry: string | null;
    sicCode: string | null;
    naicsCode: string | null;
    companyType: string | null;
  } | null;

  // Combined / normalized
  techStack: string[];
  competitors: string[];
  recentNews: Array<{ title: string; url: string; date: string; source: string }>;

  // Metadata
  _sources: string[];
  _fetchedAt: string;
}

/** Hiring signals: open roles, growth trends, and team expansion indicators. */
export interface HiringSignals {
  openRoles: Array<{
    title: string;
    department: string | null;
    location: string | null;
    postedDate: string | null;
    url: string | null;
  }>;
  totalOpenRoles: number;
  growthSignals: string[];
  recentHires: Array<{
    name: string;
    title: string;
    startDate: string | null;
  }>;
  departments: Array<{ name: string; openRoles: number }>;
  _fetchedAt: string;
}

/** Stakeholder map: key decision makers and org chart context. */
export interface StakeholderMap {
  stakeholders: Array<{
    name: string;
    title: string;
    department: string | null;
    linkedinUrl: string | null;
    seniorityLevel: string | null;
    isDecisionMaker: boolean;
  }>;
  orgInsights: string[];
  _fetchedAt: string;
}

/** Social pulse: social media activity, sentiment, and brand signals. */
export interface SocialPulse {
  mentions: Array<{
    platform: string;
    content: string;
    date: string;
    url: string | null;
    sentiment: 'positive' | 'neutral' | 'negative';
  }>;
  overallSentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  trendingTopics: string[];
  socialPresence: Array<{
    platform: string;
    url: string | null;
    followers: number | null;
  }>;
  _fetchedAt: string;
}

/** Reputation data: reviews, ratings, and trust signals. */
export interface ReputationData {
  glassdoorRating: number | null;
  glassdoorReviewCount: number | null;
  g2Rating: number | null;
  g2ReviewCount: number | null;
  trustpilotRating: number | null;
  trustpilotReviewCount: number | null;
  highlights: string[];
  concerns: string[];
  _fetchedAt: string;
}

// ─── Message Types ───────────────────────────────────────────────────────────

export const MessageType = {
  FETCH_PERSON_BACKGROUND: 'FETCH_PERSON_BACKGROUND',
  FETCH_PROGRESS: 'FETCH_PROGRESS',
  INTERIM_PERSON_DATA: 'INTERIM_PERSON_DATA',
  OPEN_SIDE_PANEL: 'OPEN_SIDE_PANEL',
  PERSON_BACKGROUND_RESULT: 'PERSON_BACKGROUND_RESULT',
  SEARCH_PERSON: 'SEARCH_PERSON',
  SEARCH_PERSON_RESULT: 'SEARCH_PERSON_RESULT',
  ENRICH_PERSON: 'ENRICH_PERSON',
  ENRICH_PERSON_RESULT: 'ENRICH_PERSON_RESULT',
  GET_CACHE_STATS: 'GET_CACHE_STATS',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_LOGS: 'GET_LOGS',
  GET_HISTORY: 'GET_HISTORY',
  PING: 'PING',
  ENRICH_PROFILE: 'ENRICH_PROFILE',
  ENRICH_PROFILE_RESULT: 'ENRICH_PROFILE_RESULT',
  GET_ANALYTICS: 'GET_ANALYTICS',
  FETCH_HIRING_SIGNALS: 'FETCH_HIRING_SIGNALS',
  HIRING_SIGNALS_RESULT: 'HIRING_SIGNALS_RESULT',
  FETCH_STAKEHOLDER_MAP: 'FETCH_STAKEHOLDER_MAP',
  STAKEHOLDER_MAP_RESULT: 'STAKEHOLDER_MAP_RESULT',
  FETCH_SOCIAL_PULSE: 'FETCH_SOCIAL_PULSE',
  SOCIAL_PULSE_RESULT: 'SOCIAL_PULSE_RESULT',
  FETCH_REPUTATION: 'FETCH_REPUTATION',
  REPUTATION_RESULT: 'REPUTATION_RESULT',
} as const;

export type MessageTypeKey = keyof typeof MessageType;

// ─── Search Result (lightweight preview before full enrichment) ─────────────

/** Subset of PersonData returned during the search phase — no credits consumed. */
export interface SearchResult {
  name: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  connections: number | null;
  followers: number | null;
  linkedinUrl: string | null;
  confidence: 'high' | 'good' | 'partial' | 'low';
  confidenceScore: number;
}
