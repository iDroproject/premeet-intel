// Shared Neon serverless Postgres client for Edge Functions.
// Uses HTTP-based queries via @neondatabase/serverless tagged templates.
//
// Requires NEON_DATABASE_URL env var.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let _sql: NeonQueryFunction<false, false> | null = null;

/** Neon SQL tagged-template function for HTTP-based queries. */
export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const databaseUrl = process.env.NEON_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('NEON_DATABASE_URL is not set.');
    }
    _sql = neon(databaseUrl);
  }
  return _sql;
}

/** Convenience: tagged-template SQL that lazily initializes the connection. */
export const sql = ((strings: TemplateStringsArray, ...values: any[]) => {
  return getSql()(strings, ...values);
}) as NeonQueryFunction<false, false>;
