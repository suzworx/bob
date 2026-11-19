import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkOrder, formatReport, migrationVersion, parseArgs, parseLsTree } from './migration-order.mjs';

const SCRIPT = fileURLToPath(new URL('./migration-order.mjs', import.meta.url));

describe('parseArgs', () => {
  it('reads --base and --head', () => {
    expect(parseArgs(['--base', 'origin/main', '--head', 'origin/main2'])).toEqual({ base: 'origin/main', head: 'origin/main2' });
  });

  it('rejects missing refs and unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['--base', 'a'])).toThrow(/usage/);
    expect(() => parseArgs(['--base', '--head', 'b'])).toThrow(/--base needs a git ref/);
    expect(() => parseArgs(['--base', 'a', '--head', 'b', '--include-all'])).toThrow(/unknown argument/);
  });
});

describe('parseLsTree', () => {
  it('keeps .sql file names only', () => {
    const text = '20260911233109_init.sql\r\nREADME.md\n20260926150000_task_follow_notifications.sql\n\n';
    expect(parseLsTree(text)).toEqual(['20260911233109_init.sql', '20260926150000_task_follow_notifications.sql']);
  });
});

describe('migrationVersion', () => {
  it('is the prefix before the first underscore', () => {
    expect(migrationVersion('20260926150000_task_follow_notifications.sql')).toBe('20260926150000');
    expect(migrationVersion('supabase/migrations/20260927010000_x.sql')).toBe('20260927010000');
  });
});

describe('checkOrder', () => {
  const base = ['20260911233109_init.sql', '20260927010000_erase_email_effects.sql'];

  it('passes when every new migration sorts after the newest in base', () => {
    expect(checkOrder(base, [...base, '20260928000000_next.sql'])).toEqual({
      added: ['20260928000000_next.sql'],
      late: [],
      newestBase: '20260927010000',
    });
  });

  it('flags a new migration that sorts before the newest in base (#558)', () => {
    const result = checkOrder(base, [...base, '20260926150000_task_follow_notifications.sql', '20260928000000_next.sql']);
    expect(result.late).toEqual(['20260926150000_task_follow_notifications.sql']);
  });

  it('flags a new migration that reuses the newest base version', () => {
    expect(checkOrder(base, [...base, '20260927010000_other.sql']).late).toEqual(['20260927010000_other.sql']);
  });

  it('passes when nothing is new, or base has no migrations yet', () => {
    expect(checkOrder(base, base)).toEqual({ added: [], late: [], newestBase: '20260927010000' });
    expect(checkOrder([], ['1_a.sql']).late).toEqual([]);
  });
});

describe('formatReport', () => {
  it('names each late migration and says what push would do', () => {
    const lines = formatReport(
      { base: 'origin/main', head: 'origin/main2' },
      { added: ['1_a.sql', '3_c.sql'], late: ['1_a.sql'], newestBase: '2' },
    );
    expect(lines[1]).toMatch(/LATE 1_a\.sql/);
    expect(lines[2]).toMatch(/ok {3}3_c\.sql/);
    expect(lines.at(-1)).toMatch(/FAIL: 1 migration\(s\).*db push/);
  });
});

describe('CLI', () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('exits 0 for a ref against itself, using git only', () => {
    const result = run(['--base', 'HEAD', '--head', 'HEAD']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/0 new migration\(s\)/);
  });

  it('exits 2 on bad arguments and on an unknown ref', () => {
    expect(run([]).status).toBe(2);
    expect(run(['--base', 'no-such-ref-558', '--head', 'HEAD']).status).toBe(2);
  });
});
