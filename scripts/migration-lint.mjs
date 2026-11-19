#!/usr/bin/env node
// Additive-first migration check (#349, docs/deploy.md "Migrations: expand,
// then contract"). Scans the migration files a change ADDS under
// supabase/migrations for statements that can break the server already
// running: a destructive statement fails unless its file carries the contract
// marker, which downgrades it to a warning in the job summary. Adding a
// migration needs no other edit: /health derives the schema it expects from the
// migrations shipped with the server (apps/api/src/web-health.ts).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_MARKER = '-- bob:contract';
export const POLICY = 'docs/deploy.md#migrations-expand-then-contract';
const MIGRATION_DIR = 'supabase/migrations';

/** Blanks comments, quoted strings, quoted identifiers and dollar-quoted
 *  bodies, keeping newlines so line numbers survive. */
export function stripSql(sql) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$[A-Za-z_]*\$)[\s\S]*?\1/g,
    (match) => (match.startsWith('"') ? match.replace(/[^\n]/g, 'x') : blank(match)),
  );
}

const RULES = [
  ['drop_table', /\bdrop\s+table\b/],
  ['drop_column', /\balter\s+table\b[\s\S]*\bdrop\s+(?:column\b|(?!constraint\b|default\b|not\s+null\b|expression\b|identity\b)[a-z_"])/],
  ['rename', /\balter\s+[\s\S]*\brename\b/],
  ['alter_type', /\balter\s+table\b[\s\S]*\balter\s+(?:column\s+)?\w+\s+(?:set\s+data\s+)?type\b/],
  ['set_not_null_without_default', /\bset\s+not\s+null\b/, /\bset\s+default\b/],
  ['not_null_column_without_default', /\balter\s+table\b[\s\S]*\badd\s+(?!constraint\b)[\s\S]*(?<!\bis\s)\bnot\s+null\b/, /\bdefault\b/],
  ['disable_rls', /\b(?:disable|no\s+force)\s+row\s+level\s+security\b/],
];

const policyKey = (name, table) => `${name.replace(/"/g, '')} on ${table.replace(/"/g, '').replace(/^public\./, '')}`;

/** Findings for one migration's SQL: [{ rule, line, statement }]. */
export function lintMigrationSql(sql) {
  const clean = stripSql(sql).toLowerCase();
  const created = new Set();
  for (const m of sql.toLowerCase().matchAll(/\bcreate\s+policy\s+("[^"]+"|\w+)\s+on\s+([\w."]+)/g)) created.add(policyKey(m[1], m[2]));
  const findings = [];
  let offset = 0;
  for (const piece of clean.split(';')) {
    const start = offset + piece.search(/\S|$/);
    offset += piece.length + 1;
    const stmt = piece.trim().replace(/\s+/g, ' ');
    if (!stmt) continue;
    const line = clean.slice(0, start).split('\n').length;
    const statement = sql.slice(start, offset - 1).trim().replace(/\s+/g, ' ').slice(0, 160);
    for (const [rule, match, unless] of RULES) {
      if (match.test(stmt) && !(unless && unless.test(stmt))) findings.push({ rule, line, statement });
    }
    const drop = /\bdrop\s+policy\s+(?:if\s+exists\s+)?("[^"]+"|\w+)\s+on\s+([\w."]+)/.exec(sql.slice(start, offset - 1).toLowerCase());
    if (drop && /\bdrop\s+policy\b/.test(stmt) && !created.has(policyKey(drop[1], drop[2]))) {
      findings.push({ rule: 'drop_policy_without_replacement', line, statement });
    }
  }
  return findings;
}

export function hasContractMarker(sql) {
  return sql.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(CONTRACT_MARKER));
}

/** Errors (fail) and warnings (contract-marked) for a set of files. */
export function lintFiles(files) {
  const errors = [];
  const warnings = [];
  for (const { file, sql } of files) {
    const contract = hasContractMarker(sql);
    for (const f of lintMigrationSql(sql)) (contract ? warnings : errors).push({ file, ...f });
  }
  return { errors, warnings };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Base ref: MIGRATION_LINT_BASE, the PR base branch, the pushed range's start, else origin/main. */
function resolveBase(env) {
  if (env.MIGRATION_LINT_BASE) return env.MIGRATION_LINT_BASE;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  if (env.BEFORE && !/^0+$/.test(env.BEFORE)) return env.BEFORE;
  return 'origin/main';
}

function main(argv, env) {
  const explicit = argv.filter((a) => !a.startsWith('--'));
  let names = explicit;
  if (explicit.length === 0) {
    const base = resolveBase(env);
    // Committed additions, plus files not yet committed so a local run sees them too.
    const added = git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`, '--', `${MIGRATION_DIR}/*.sql`]);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', `${MIGRATION_DIR}/*.sql`]);
    names = [...new Set(`${added}\n${untracked}`.split('\n').filter(Boolean))];
    console.log(`migration-lint: ${names.length} new migration(s) since ${base}`);
  }
  const { errors, warnings } = lintFiles(names.map((file) => ({ file, sql: readFileSync(file, 'utf8') })));
  const say = (level, f) => `::${level} file=${f.file},line=${f.line}::${f.rule}: ${f.statement} (policy: ${POLICY})`;
  for (const f of warnings) console.log(say('warning', f));
  for (const f of errors) console.log(say('error', f));
  if (env.GITHUB_STEP_SUMMARY && warnings.length > 0) {
    const rows = warnings.map((f) => `- \`${basename(f.file)}\`:${f.line} **${f.rule}**: \`${f.statement}\``).join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### :warning: Contract migration (${CONTRACT_MARKER})\n\nOwner approval and a separate release are required (${POLICY}).\n\n${rows}\n`);
  }
  console.log(`migration-lint: ${errors.length} error(s), ${warnings.length} contract warning(s)`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
