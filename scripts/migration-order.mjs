#!/usr/bin/env node
/**
 * Release check: would production's `supabase db push` accept the migrations
 * `--head` adds on top of `--base`?
 *
 *   npm run check:migration-order -- --base origin/main --head origin/main2
 *
 * Production applies migrations with `supabase db push` (no --include-all, see
 * .github/workflows/supabase.yml). That refuses a pending migration whose
 * version sorts before the newest one the database already has, so every
 * migration head adds must sort after the newest migration in base. Parallel
 * units pick their timestamps independently, so a later-merged unit can carry
 * an earlier timestamp (#558). Fix a failure by renaming the late file to a
 * version after the newest one in base before the release merge.
 *
 * Git only: no database, no network. Fetch first if the refs may be stale.
 * Exit 0 when the order is fine, 1 when a migration is out of order, 2 on bad
 * arguments or a git failure.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'supabase/migrations';

/** Parses `--base <ref> --head <ref>`; throws on anything else. */
export function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag !== '--base' && flag !== '--head') throw new Error(`unknown argument: ${flag}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a git ref`);
    out[flag.slice(2)] = value;
    i += 1;
  }
  if (!out.base || !out.head) throw new Error('usage: --base <ref> --head <ref>');
  return out;
}

/** The version prefix Supabase orders by: `20260926150000_x.sql` -> `20260926150000`. */
export function migrationVersion(file) {
  return file.split('/').pop().split('_')[0];
}

/** Migration .sql file names from `git ls-tree --name-only` output. */
export function parseLsTree(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim().split('/').pop())
    .filter((name) => name && name.endsWith('.sql'));
}

/**
 * Migrations in head but not in base, and the ones among them that `db push`
 * would reject: version at or before the newest version already in base.
 */
export function checkOrder(baseFiles, headFiles) {
  const inBase = new Set(baseFiles);
  const added = headFiles.filter((file) => !inBase.has(file)).sort();
  const newestBase = baseFiles.map(migrationVersion).sort().at(-1) ?? null;
  const late = newestBase ? added.filter((file) => migrationVersion(file) <= newestBase) : [];
  return { added, late, newestBase };
}

function listMigrations(ref) {
  const result = spawnSync('git', ['ls-tree', '--name-only', `${ref}:${MIGRATIONS_DIR}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-tree ${ref}:${MIGRATIONS_DIR} failed: ${(result.stderr || '').trim()}`);
  }
  return parseLsTree(result.stdout);
}

/** Human-readable report lines for a checkOrder result. */
export function formatReport({ base, head }, { added, late, newestBase }) {
  const lines = [`[migration-order] ${base}..${head}: ${added.length} new migration(s); newest in ${base}: ${newestBase ?? '(none)'}`];
  for (const file of added) lines.push(`  ${late.includes(file) ? 'LATE' : 'ok  '} ${file}`);
  if (late.length > 0) {
    lines.push(
      `[migration-order] FAIL: ${late.length} migration(s) sort at or before ${newestBase}; ` +
        '`supabase db push` would reject them. Rename each to a version after it before merging.',
    );
  } else {
    lines.push('[migration-order] OK: every new migration sorts after the newest one in base.');
  }
  return lines;
}

function main() {
  let refs;
  try {
    refs = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[migration-order] ${error.message}`);
    process.exit(2);
  }
  let result;
  try {
    result = checkOrder(listMigrations(refs.base), listMigrations(refs.head));
  } catch (error) {
    console.error(`[migration-order] ${error.message}`);
    process.exit(2);
  }
  const lines = formatReport(refs, result);
  (result.late.length > 0 ? console.error : console.log)(lines.join('\n'));
  process.exit(result.late.length > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
