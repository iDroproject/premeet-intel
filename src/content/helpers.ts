// Pure helper functions for content script — extracted for testability.

/** GCal attendance-status/role suffixes to strip from names. */
export const STATUS_SUFFIX_RE = /,?\s*\b(Attending|Organizer|Maybe|Tentative|Declined|Awaiting|Not responded|Accepted|Optional|Required|Creator|organizer|accepted|declined|tentative|needsAction)\b/gi;

export function cleanName(raw: string): string {
  return raw.replace(STATUS_SUFFIX_RE, '').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
}

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
  'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me',
]);

export function companyFromEmail(email: string): string | null {
  if (!email.includes('@')) return null;
  const domain = email.split('@')[1].toLowerCase();
  if (FREE_DOMAINS.has(domain)) return null;
  const parts = domain.split('.');
  const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}

/** Maximum character length for a plausible person name. */
export const MAX_NAME_LENGTH = 80;

/**
 * Email domains that belong to conferencing / SIP / system services and
 * should never be treated as personal attendee emails.
 */
const NON_PERSON_EMAIL_DOMAINS = new Set([
  'zoomcrc.com', 'zoom.us', 'zoomgov.com',
  'meet.google.com', 'teams.microsoft.com', 'webex.com',
  'noreply', 'no-reply',
]);

/** Returns true if the email looks like a real person email (not SIP, conference, etc.). */
export function isPersonEmail(email: string): boolean {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1].toLowerCase();
  if (NON_PERSON_EMAIL_DOMAINS.has(domain)) return false;
  const local = email.split('@')[0];
  if (/^\d+$/.test(local)) return false;
  return true;
}

/**
 * Strings that appear as attendee names in Google Calendar but are not
 * real people. Case-insensitive exact match after trimming.
 */
const NON_PERSON_NAMES = new Set([
  'transferred from', 'forwarded invitation', 'no organizer',
  'unknown organizer', 'room', 'conference room', 'meeting room',
  'guest', 'group', 'team', 'everyone', 'all', 'calendar',
  'no reply', 'noreply', 'do not reply', 'mailer-daemon', 'postmaster',
]);

const NON_PERSON_PATTERNS = [
  /^\d+\s+more$/i,
  /^\+?\d+$/,
  /^[\W_]+$/,
  /^.{0,1}$/,
  /^(transferred|forwarded)\s/i,
  /^\d+\s+guests?/i,                   // "2 guests", "3 guests1 yes1", etc.
  /\b(yes|no|maybe|awaiting|accepted|declined|tentative)\s*\d/i, // "1 yes2 no"
];

/** Returns true if the cleaned name looks like a real person. */
export function isLikelyPersonName(name: string): boolean {
  if (!name) return false;
  if (name.length > MAX_NAME_LENGTH) return false;
  if (NON_PERSON_NAMES.has(name.toLowerCase().trim())) return false;
  return !NON_PERSON_PATTERNS.some((re) => re.test(name.trim()));
}

/** Returns true if the Chrome extension context is still valid (not invalidated by reload/update). */
export function isContextValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}
