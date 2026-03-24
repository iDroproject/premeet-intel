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

/** Returns true if the Chrome extension context is still valid (not invalidated by reload/update). */
export function isContextValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}
