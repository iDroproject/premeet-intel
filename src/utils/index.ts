// PreMeet shared utilities

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0];
  return local
    .replace(/[._+\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function companyFromDomain(domain: string): string {
  const parts = domain.split('.');
  const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}
