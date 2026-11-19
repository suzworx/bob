import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_MARKER, POLICY, hasContractMarker, lintFiles, lintMigrationSql, stripSql } from './migration-lint.mjs';

const rules = (sql) => lintMigrationSql(sql).map((f) => f.rule);

describe('lintMigrationSql: destructive statements', () => {
  it.each([
    ['drop table', 'drop table bob.notes;', 'drop_table'],
    ['drop table if exists', 'DROP TABLE IF EXISTS bob.notes CASCADE;', 'drop_table'],
    ['drop column', 'alter table bob.notes drop column body;', 'drop_column'],
    ['drop without COLUMN', 'alter table bob.notes drop if exists body;', 'drop_column'],
    ['rename column', 'alter table bob.notes rename column body to text;', 'rename'],
    ['rename table', 'alter table bob.notes rename to memos;', 'rename'],
    ['column type', 'alter table bob.notes alter column body type varchar(80);', 'alter_type'],
    ['set data type', 'alter table bob.notes alter body set data type text;', 'alter_type'],
    ['set not null', 'alter table bob.notes alter column body set not null;', 'set_not_null_without_default'],
    ['add not null column', 'alter table bob.notes add column pinned boolean not null;', 'not_null_column_without_default'],
    ['disable rls', 'alter table bob.notes disable row level security;', 'disable_rls'],
    ['no force rls', 'alter table bob.notes no force row level security;', 'disable_rls'],
    ['drop policy', 'drop policy notes_select on bob.notes;', 'drop_policy_without_replacement'],
  ])('flags %s', (_name, sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('names the statement and its line', () => {
    const [finding] = lintMigrationSql('create table bob.a (id int);\n\nalter table bob.notes\n  drop column body;\n');
    expect(finding).toEqual({ rule: 'drop_column', line: 3, statement: 'alter table bob.notes drop column body' });
  });
});

describe('lintMigrationSql: additive statements pass', () => {
  it.each([
    ['nullable column', 'alter table bob.conversations add column pinned_at timestamptz;'],
    ['not null with default', 'alter table bob.notes add column pinned boolean not null default false;'],
    ['set not null with default', 'alter table bob.notes alter column n set default 0, alter column n set not null;'],
    ['new table with not null', 'create table bob.games (id uuid primary key, name text not null);'],
    ['check constraint', 'alter table bob.notes add constraint body_set check (body is not null);'],
    ['drop not null', 'alter table bob.notes alter column body drop not null;'],
    ['drop default', 'alter table bob.notes alter column body drop default;'],
    ['drop constraint', 'alter table bob.notes drop constraint notes_body_check;'],
    ['index', 'create index if not exists notes_space_idx on bob.notes (space_id);'],
    ['enable rls', 'alter table bob.games enable row level security;\nalter table bob.games force row level security;'],
    ['column named type', 'alter table bob.notes add column type text;'],
    ['replaced policy', 'drop policy if exists notes_update on bob.notes;\ncreate policy notes_update on bob.notes for update using (true);'],
  ])('%s', (_name, sql) => {
    expect(rules(sql)).toEqual([]);
  });

  it('ignores comments and strings that only look destructive', () => {
    const sql = [
      '-- drop table bob.notes; we used to rename columns here',
      '/* alter table bob.notes drop column body; */',
      "comment on table bob.notes is 'drop table bob.notes; alter table x rename to y';",
      'create function bob_private.f() returns void language sql as $$ drop table bob.tmp $$;',
      'create function bob_private.g() returns void language plpgsql as $body$ begin drop table bob.tmp; end $body$;',
      'create table bob."drop table" (id int);',
    ].join('\n');
    expect(rules(sql)).toEqual([]);
  });

  it('keeps line numbers across blanked comments', () => {
    expect(stripSql('-- a\nb').split('\n')).toHaveLength(2);
  });
});

describe('contract marker', () => {
  const destructive = 'alter table bob.notes drop column body;\n';

  it('fails an unmarked destructive file, naming the file and rule', () => {
    const { errors, warnings } = lintFiles([{ file: 'x.sql', sql: destructive }]);
    expect(errors).toEqual([expect.objectContaining({ file: 'x.sql', rule: 'drop_column' })]);
    expect(warnings).toEqual([]);
    expect(POLICY).toContain('docs/deploy.md');
  });

  it('downgrades a marked file to warnings', () => {
    const sql = `${CONTRACT_MARKER} owner-approved: notes.body retired (#349)\n${destructive}`;
    expect(hasContractMarker(sql)).toBe(true);
    const { errors, warnings } = lintFiles([{ file: 'x.sql', sql }]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.objectContaining({ rule: 'drop_column' })]);
  });

  it('does not accept the marker inside another comment', () => {
    expect(hasContractMarker(`-- see ${CONTRACT_MARKER}\n`)).toBe(false);
  });

  it('passes an additive file with no findings', () => {
    expect(lintFiles([{ file: 'x.sql', sql: 'alter table bob.notes add column tag text;' }])).toEqual({ errors: [], warnings: [] });
  });
});

describe('the whole run', () => {
  const run = (...files) => spawnSync(process.execPath, ['scripts/migration-lint.mjs', ...files], { encoding: 'utf8' });

  it('passes a newer additive migration with no web-health.ts edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-lint-'));
    try {
      const file = join(dir, '29990101000000_newer_than_everything.sql');
      writeFileSync(file, 'alter table bob.notes add column tag text;\n');
      const { status, stdout } = run(file);
      expect(stdout).toContain('0 error(s)');
      expect(stdout).not.toMatch(/web-health|EXPECTED_SCHEMA_VERSION/);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still fails a destructive migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-lint-'));
    try {
      const file = join(dir, '29990101000000_drop.sql');
      writeFileSync(file, 'drop table bob.notes;\n');
      const { status, stdout } = run(file);
      expect(stdout).toContain('drop_table');
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every existing migration passes the lint', () => {
    const files = readdirSync('supabase/migrations').filter((n) => n.endsWith('.sql'));
    const { errors } = lintFiles(files.map((n) => ({ file: n, sql: readFileSync(`supabase/migrations/${n}`, 'utf8') })));
    expect(errors).toEqual([]);
  });
});
