import { describe, it, expect } from 'vitest';
import { cleanName, nameFromEmail, companyFromEmail, isContextValid, isLikelyPersonName, isPersonEmail } from '../../src/content/helpers';

describe('cleanName', () => {
  it('strips attendance status suffixes', () => {
    expect(cleanName('Alice Smith, Organizer')).toBe('Alice Smith');
    expect(cleanName('Bob Jones, Accepted')).toBe('Bob Jones');
    expect(cleanName('Carol White, Tentative')).toBe('Carol White');
    expect(cleanName('Dave Brown, Declined')).toBe('Dave Brown');
  });

  it('strips multiple suffixes', () => {
    expect(cleanName('Alice, Organizer, Accepted')).toBe('Alice');
  });

  it('collapses extra whitespace', () => {
    expect(cleanName('  Alice   Smith  ')).toBe('Alice Smith');
  });

  it('returns empty string for empty input', () => {
    expect(cleanName('')).toBe('');
  });

  it('preserves names without status suffixes', () => {
    expect(cleanName('Alice Smith')).toBe('Alice Smith');
  });
});

describe('nameFromEmail', () => {
  it('converts email local part to title case name', () => {
    expect(nameFromEmail('john.doe@example.com')).toBe('John Doe');
  });

  it('handles underscores and hyphens', () => {
    expect(nameFromEmail('jane_smith@example.com')).toBe('Jane Smith');
    expect(nameFromEmail('bob-jones@example.com')).toBe('Bob Jones');
  });

  it('handles plus addressing', () => {
    expect(nameFromEmail('alice+work@example.com')).toBe('Alice Work');
  });

  it('handles single-word local part', () => {
    expect(nameFromEmail('admin@example.com')).toBe('Admin');
  });
});

describe('companyFromEmail', () => {
  it('returns company name from business domain', () => {
    expect(companyFromEmail('john@acme.com')).toBe('Acme');
    expect(companyFromEmail('jane@stripe.io')).toBe('Stripe');
  });

  it('returns null for free email providers', () => {
    expect(companyFromEmail('user@gmail.com')).toBeNull();
    expect(companyFromEmail('user@yahoo.com')).toBeNull();
    expect(companyFromEmail('user@hotmail.com')).toBeNull();
    expect(companyFromEmail('user@outlook.com')).toBeNull();
    expect(companyFromEmail('user@protonmail.com')).toBeNull();
  });

  it('returns null for emails without @', () => {
    expect(companyFromEmail('noatsign')).toBeNull();
  });

  it('capitalizes first letter', () => {
    expect(companyFromEmail('user@google.com')).toBe('Google');
  });

  it('handles subdomains', () => {
    expect(companyFromEmail('user@mail.company.co.uk')).toBe('Co');
  });
});

describe('isLikelyPersonName', () => {
  it('accepts real person names', () => {
    expect(isLikelyPersonName('Ran Heger')).toBe(true);
    expect(isLikelyPersonName('Daniel Oren')).toBe(true);
    expect(isLikelyPersonName('Alice')).toBe(true);
  });

  it('rejects "Transferred from" (GCal forwarding label)', () => {
    expect(isLikelyPersonName('Transferred from')).toBe(false);
    expect(isLikelyPersonName('transferred from')).toBe(false);
  });

  it('rejects guest count / RSVP summary text', () => {
    expect(isLikelyPersonName('2 guests1 yes1')).toBe(false);
    expect(isLikelyPersonName('2 guests')).toBe(false);
    expect(isLikelyPersonName('3 guest')).toBe(false);
    expect(isLikelyPersonName('5 guests2 yes3 no')).toBe(false);
  });

  it('rejects forwarded invitation labels', () => {
    expect(isLikelyPersonName('Forwarded invitation')).toBe(false);
    expect(isLikelyPersonName('forwarded by someone')).toBe(false);
  });

  it('rejects other non-person strings', () => {
    expect(isLikelyPersonName('conference room')).toBe(false);
    expect(isLikelyPersonName('+3')).toBe(false);
    expect(isLikelyPersonName('2 more')).toBe(false);
    expect(isLikelyPersonName('')).toBe(false);
  });
});

describe('isContextValid', () => {
  it('returns false when chrome is not defined', () => {
    // In test env, chrome global is not defined
    expect(isContextValid()).toBe(false);
  });
});
