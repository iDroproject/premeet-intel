import { describe, it, expect } from 'vitest';
import { nameFromEmail, companyFromDomain } from './index';

describe('nameFromEmail', () => {
  it('converts dot-separated local part to title case', () => {
    expect(nameFromEmail('john.doe@example.com')).toBe('John Doe');
  });

  it('handles underscores', () => {
    expect(nameFromEmail('jane_smith@acme.com')).toBe('Jane Smith');
  });

  it('handles hyphens', () => {
    expect(nameFromEmail('bob-jones@acme.com')).toBe('Bob Jones');
  });

  it('handles plus addressing', () => {
    expect(nameFromEmail('alice+tag@acme.com')).toBe('Alice Tag');
  });

  it('handles single word', () => {
    expect(nameFromEmail('admin@acme.com')).toBe('Admin');
  });
});

describe('companyFromDomain', () => {
  it('extracts company name from simple domain', () => {
    expect(companyFromDomain('acme.com')).toBe('Acme');
  });

  it('capitalizes first letter', () => {
    expect(companyFromDomain('stripe.com')).toBe('Stripe');
  });

  it('handles country TLDs', () => {
    expect(companyFromDomain('acme.co.uk')).toBe('Co');
  });

  it('handles single-part domain', () => {
    expect(companyFromDomain('localhost')).toBe('Localhost');
  });
});
