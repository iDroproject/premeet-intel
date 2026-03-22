// PreMeet shared TypeScript types

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

export interface EnrichedAttendee extends Attendee {
  person: Person | null;
  enrichedAt: number;
  status: 'pending' | 'done' | 'error';
  error?: string;
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export type Plan = 'free' | 'pro';

export interface Credits {
  plan: Plan;
  used: number;         // enrichments used this month
  limit: number;        // monthly limit (10 free, unlimited pro)
  resetMonth: string;   // 'YYYY-MM' — resets at start of new month
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
  | { type: 'PING' };

export type BackgroundToPopup =
  | { type: 'MEETING_UPDATE'; payload: { meeting: MeetingEvent; attendees: EnrichedAttendee[] } }
  | { type: 'ENRICHMENT_PROGRESS'; payload: { email: string; attendee: EnrichedAttendee } };

export type PopupToBackground =
  | { type: 'GET_CURRENT_MEETING' }
  | { type: 'PING' };
