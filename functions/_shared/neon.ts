// Neon serverless Postgres client for Edge Functions.
// Primary DB layer for all PreMeet backend services.
//
// Requires NEON_DATABASE_URL env var (pooled connection string from Neon dashboard).
// Format: postgres://user:pass@ep-xxx.region.neon.tech/dbname?sslmode=require

import { neon } from 'https://esm.sh/@neondatabase/serverless@1';

const databaseUrl = Deno.env.get('NEON_DATABASE_URL');

/**
 * Returns a Neon SQL tagged-template function for HTTP-based queries.
 * Throws if NEON_DATABASE_URL is not configured.
 */
export function getNeonClient() {
  if (!databaseUrl) {
    throw new Error('NEON_DATABASE_URL is not set.');
  }
  return neon(databaseUrl);
}
