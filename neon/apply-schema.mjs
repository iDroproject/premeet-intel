// Apply Neon schema files in order.
// Usage: NEON_DATABASE_URL=... node neon/apply-schema.mjs [schema-file]
//
// Without arguments: runs all SQL files in neon/schema/ in filename order.
// With argument:      runs only the specified file (e.g. 002_enrichment_extensions.sql).
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

// Determine which schema files to run
const specificFile = process.argv[2];
let schemaFiles;

if (specificFile) {
  schemaFiles = [specificFile];
} else {
  schemaFiles = readdirSync(schemaDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

if (schemaFiles.length === 0) {
  console.log('No schema files found.');
  process.exit(0);
}

console.log('Connecting to Neon via WebSocket...');
const pool = new Pool({ connectionString: databaseUrl });

try {
  for (const file of schemaFiles) {
    const schemaPath = join(schemaDir, file);
    const schemaSql = readFileSync(schemaPath, 'utf-8');

    console.log(`\nApplying schema: ${file}`);
    await pool.query(schemaSql);
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

  // Verify functions
  const { rows: funcs } = await pool.query(`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public'
    ORDER BY routine_name;
  `);
  console.log('\nFunctions:');
  funcs.forEach(f => console.log(`  - ${f.routine_name}`));

  // Verify indexes
  const { rows: indexes } = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY indexname;
  `);
  console.log('\nIndexes:');
  indexes.forEach(i => console.log(`  - ${i.indexname}`));

} catch (err) {
  console.error('Schema apply failed:', err.message);
  if (err.detail) console.error('Detail:', err.detail);
  process.exit(1);
} finally {
  await pool.end();
}
