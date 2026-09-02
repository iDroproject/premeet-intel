// Apply Neon schema files in order.
// Usage: NEON_DATABASE_URL=... node neon/apply-schema.mjs [options] [schema-file ...]
//
// Options:
//   --baseline   Record the given files (or all files) as applied WITHOUT
//                executing them. Use this once to adopt a database that was
//                provisioned before the schema_migrations ledger existed.
//   --force      Re-run a file even if the ledger says it was already applied.
//
// Without arguments: runs every SQL file in neon/schema/ in filename order,
// skipping the ones the ledger already records.
//
// Uses Pool (WebSocket) to support multi-statement SQL files.
// NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction, so each
// file is executed as a single query string (implicit auto-commit).

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

neonConfig.webSocketConstructor = ws;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(__dirname, 'schema');

const databaseUrl = process.env.NEON_DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: NEON_DATABASE_URL environment variable is required.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const baselineOnly = argv.includes('--baseline');
const namedFiles = argv.filter((a) => !a.startsWith('--'));

const allFiles = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const schemaFiles = namedFiles.length > 0 ? namedFiles : allFiles;

if (schemaFiles.length === 0) {
  console.log('No schema files found.');
  process.exit(0);
}

console.log('Connecting to Neon via WebSocket...');
const pool = new Pool({ connectionString: databaseUrl });

try {
  // Does the ledger already exist? We need to know BEFORE creating it, so we
  // can tell "fresh database" apart from "pre-ledger database that is already
  // fully provisioned" — re-running 001 on the latter would fail hard.
  const { rows: ledgerRows } = await pool.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  const ledgerExisted = ledgerRows[0].present;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  // ── Baseline mode: record without executing ──────────────────────────────
  if (baselineOnly) {
    for (const file of schemaFiles) {
      await pool.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
        [file],
      );
      console.log(`  = ${file} recorded as applied (not executed).`);
    }
    console.log('\nBaseline complete. Re-run without --baseline to apply the remaining files.');
    await pool.end();
    process.exit(0);
  }

  // ── Guard: pre-ledger database that is already provisioned ───────────────
  // If the ledger is brand new but the schema is already there, the unrecorded
  // early migrations are NOT safe to replay (001 uses bare CREATE TYPE/TABLE).
  if (!ledgerExisted && appliedSet.size === 0) {
    const { rows: probe } = await pool.query(
      `SELECT to_regclass('public.users') IS NOT NULL AS provisioned`,
    );
    if (probe[0].provisioned) {
      console.error(
        '\nRefusing to run: this database is already provisioned but has no migration ledger.\n' +
        'Replaying the early migrations would fail (001 uses bare CREATE TYPE/TABLE).\n\n' +
        'Baseline the migrations that are already applied, then re-run. For example:\n' +
        '  node neon/apply-schema.mjs --baseline 001_initial_schema.sql 002_enrichment_extensions.sql\n' +
        '  node neon/apply-schema.mjs\n',
      );
      await pool.end();
      process.exit(1);
    }
  }

  for (const file of schemaFiles) {
    if (appliedSet.has(file) && !force) {
      console.log(`\nSkipping ${file} (already applied). Use --force to re-run.`);
      continue;
    }

    const schemaPath = join(schemaDir, file);
    const schemaSql = readFileSync(schemaPath, 'utf-8');

    console.log(`\nApplying schema: ${file}`);
    await pool.query(schemaSql);
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)
       ON CONFLICT (filename) DO UPDATE SET applied_at = now()`,
      [file],
    );
    console.log(`  ✓ ${file} applied successfully.`);
  }

  // Verify tables
  const { rows: tables } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log('\nTables:');
  tables.forEach(t => console.log(`  - ${t.table_name}`));

  // Verify custom enums
  const { rows: types } = await pool.query(`
    SELECT typname FROM pg_type
    WHERE typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    AND typtype = 'e'
    ORDER BY typname;
  `);
  console.log('\nCustom enums:');
  types.forEach(t => console.log(`  - ${t.typname}`));

  // Verify functions defined by our schema (excludes extension-provided ones)
  const { rows: funcs } = await pool.query(`
    SELECT p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND d.objid IS NULL
    ORDER BY p.proname;
  `);
  console.log('\nFunctions:');
  funcs.forEach(f => console.log(`  - ${f.proname}`));

  // Verify indexes
  const { rows: indexes } = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY indexname;
  `);
  console.log('\nIndexes:');
  indexes.forEach(i => console.log(`  - ${i.indexname}`));

  // Ledger state
  const { rows: ledger } = await pool.query(
    'SELECT filename, applied_at FROM schema_migrations ORDER BY filename',
  );
  console.log('\nMigration ledger:');
  ledger.forEach(r => console.log(`  - ${r.filename} @ ${r.applied_at.toISOString()}`));

} catch (err) {
  console.error('Schema apply failed:', err.message);
  if (err.detail) console.error('Detail:', err.detail);
  process.exit(1);
} finally {
  await pool.end();
}
