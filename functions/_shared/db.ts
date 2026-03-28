// Shared Neon serverless Postgres client for Edge Functions.
// Uses HTTP-based queries via @neondatabase/serverless tagged templates.
//
// Requires NEON_DATABASE_URL env var.

import { neon } from 'https://esm.sh/@neondatabase/serverless@1';

const databaseUrl = Deno.env.get('NEON_DATABASE_URL');
if (!databaseUrl) {
  throw new Error('NEON_DATABASE_URL is not set.');
}

/** Neon SQL tagged-template function for HTTP-based queries. */
export const sql = neon(databaseUrl);
