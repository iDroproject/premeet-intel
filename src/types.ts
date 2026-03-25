// PreMeet shared TypeScript types

import type { PersonData } from './background/enrichment/types';

export interface Attendee {
  name: string;
  email: string;
  /** Company name derived from email domain, null for free providers */
  company: string | null;
}

export interface MeetingEvent {
  title: string;
  attendees: Attendee[];
}

export interface Person {
  name: string;
  email: string;
  title: string | null;
  company: Company | null;
}

export interface Company {
  name: string;
  domain: string;
  website: string | null;
  description: string | null;
}

/** Enrichment stage for the progress stepper */
export type EnrichmentStage = 'searching' | 'resolving' | 'enriching' | 'complete';

export interface EnrichedAttendee extends Attendee {
  person: Person | null;
  enrichedAt: number;
  status: 'idle' | 'pending' | 'done' | 'error';
  error?: string;
  /** Current enrichment stage for progress display */
  stage?: EnrichmentStage;
  /** Whether this result came from cache */
  fromCache?: boolean;
  /** Whether LinkedIn data has been resolved (usable state) */
  hasLinkedIn?: boolean;
  /** Full enrichment data from the waterfall pipeline */
  personData?: PersonData;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export type TriggerMode = 'auto' | 'manual';
export type CacheDuration = '1d' | '7d' | '30d' | 'never';

export interface Settings {
  triggerMode: TriggerMode;
  cacheDuration: CacheDuration;
  showConfidenceScores: boolean;
  compactMode: boolean;
  /** Auto-search all attendees when a calendar event is clicked */
  autoSearchAttendees: boolean;
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export type Plan = 'free' | 'pro';

export interface Credits {
  plan: Plan;
  used: number;         // enrichments used this month
  limit: number;        // monthly limit (10 free, unlimited pro)
  resetMonth: string;   // 'YYYY-MM' — resets at start of new month
}

// ─── Activity Log ────────────────────────────────────────────────────────────

/** Generic data-source labels (no vendor names) */
export type DataSourceLabel = 'Web Search' | 'Profile Lookup' | 'Profile Scraper' | 'Business Data' | 'Cache';

export type LogStatus = 'success' | 'partial' | 'failed' | 'cached';

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  attendeeName: string;
  attendeeEmail: string;
  status: LogStatus;
  /** 0 = cached, 1 = new lookup */
  creditsUsed: 0 | 1;
  /** Which generic data sources returned data */
  dataSources: DataSourceLabel[];
  meetingTitle: string;
}

// ─── Feature Requests ─────────────────────────────────────────────────────────

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  votes: number;
  upvotedByUser: boolean;
  createdAt: number;
}

// ─── Message types between content script ↔ background ↔ popup

export type ContentToBackground =
  | { type: 'MEETING_DETECTED'; payload: MeetingEvent }
  | { type: 'FETCH_PERSON_BACKGROUND'; payload: { name: string; email: string; company: string } }
  | { type: 'PING' };

export type BackgroundToPopup =
  | { type: 'MEETING_UPDATE'; payload: { meeting: MeetingEvent; attendees: EnrichedAttendee[] } }
  | { type: 'ATTENDEE_UPDATE'; payload: { email: string; attendee: EnrichedAttendee } }
  | { type: 'ENRICHMENT_PROGRESS'; payload: { email: string; attendee: EnrichedAttendee } }
  | { type: 'CREDITS_EXHAUSTED'; payload: { meeting: MeetingEvent; resetDate: string } }
  | { type: 'FETCH_PROGRESS'; payload: unknown }
  | { type: 'INTERIM_PERSON_DATA'; payload: unknown }
  | { type: 'PERSON_BACKGROUND_RESULT'; payload: unknown };

export type PopupToBackground =
  | { type: 'GET_CURRENT_MEETING' }
  | { type: 'ENRICH_ATTENDEE'; payload: { email: string } }
  | { type: 'GET_CACHE_STATS' }
  | { type: 'CLEAR_CACHE' }
  | { type: 'GET_ACTIVITY_LOG' }
  | { type: 'AUTH_SIGN_IN' }
  | { type: 'AUTH_SIGN_OUT' }
  | { type: 'AUTH_GET_STATE' }
  | { type: 'AUTH_GET_USER' }
  | { type: 'PING' };
