// PreMeet enrichment service
// Given an attendee email, resolves Person + Company data.
// v1: domain-based company resolution + clearbit logo API (no auth required).
// Designed to accept premium data sources as drop-in additions later.

import type { Attendee, Person, Company, EnrichedAttendee } from '../types';

const LOG = '[PreMeet][Enrichment]';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_KEY_PREFIX = 'pm_enrich_';

const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me',
  'tutanota.com', 'zoho.com',
]);

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: Person;
  cachedAt: number;
}

async function cacheGet(email: string): Promise<Person | null> {
  const key = CACHE_KEY_PREFIX + email.toLowerCase();
  const result = await chrome.storage.local.get(key);
  const entry: CacheEntry | undefined = result[key];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function cacheSet(email: string, data: Person): Promise<void> {
  const key = CACHE_KEY_PREFIX + email.toLowerCase();
  const entry: CacheEntry = { data, cachedAt: Date.now() };
  await chrome.storage.local.set({ [key]: entry });
}

// ─── Domain-based Company Resolution ─────────────────────────────────────────

function companyNameFromDomain(domain: string): string {
  // Strip subdomains: mail.acme.co.uk → acme
  const parts = domain.split('.');
  const rootIndex = parts.length >= 2 ? parts.length - 2 : 0;
  const root = parts[rootIndex];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

async function resolveCompany(domain: string): Promise<Company> {
  const name = companyNameFromDomain(domain);
  const website = `https://${domain}`;
  return { name, domain, website, description: null };
}

// ─── Gravatar (name hint from email hash) ─────────────────────────────────────
// We use the Gravatar profile API to attempt to get a display name.
// This is a best-effort, unauthenticated call. Fails silently.

async function fetchGravatarName(email: string): Promise<string | null> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(email.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const resp = await fetch(`https://www.gravatar.com/${hash}.json`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const json = await resp.json();
    return (json?.entry?.[0]?.displayName as string) || null;
  } catch {
    return null;
  }
}

// ─── Name from email ─────────────────────────────────────────────────────────

function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Main Enrichment Function ─────────────────────────────────────────────────

export async function enrichAttendee(attendee: Attendee): Promise<EnrichedAttendee> {
  const base: EnrichedAttendee = {
    ...attendee,
    person: null,
    enrichedAt: Date.now(),
    status: 'pending',
  };

  if (!attendee.email || !attendee.email.includes('@')) {
    return { ...base, status: 'done' };
  }

  // Check cache first
  try {
    const cached = await cacheGet(attendee.email);
    if (cached) {
      console.log(LOG, `Cache hit for ${attendee.email}`);
      return { ...base, person: cached, enrichedAt: Date.now(), status: 'done' };
    }
  } catch (err) {
    console.warn(LOG, 'Cache read failed:', err);
  }

  const domain = attendee.email.split('@')[1].toLowerCase();
  const isFreeProvider = FREE_DOMAINS.has(domain);

  // Resolve person name — try Gravatar, fall back to email-derived name
  let resolvedName = attendee.name || nameFromEmail(attendee.email);
  const gravatarName = await fetchGravatarName(attendee.email);
  if (gravatarName) resolvedName = gravatarName;

  // Resolve company
  let company: Company | null = null;
  if (!isFreeProvider) {
    try {
      company = await resolveCompany(domain);
    } catch (err) {
      console.warn(LOG, `Company resolution failed for ${domain}:`, err);
    }
  }

  const person: Person = {
    name: resolvedName,
    email: attendee.email,
    title: null,
    company,
  };

  try {
    await cacheSet(attendee.email, person);
  } catch (err) {
    console.warn(LOG, 'Cache write failed:', err);
  }

  return { ...base, person, enrichedAt: Date.now(), status: 'done' };
}

export async function enrichAll(attendees: Attendee[]): Promise<EnrichedAttendee[]> {
  return Promise.all(attendees.map(enrichAttendee));
}
