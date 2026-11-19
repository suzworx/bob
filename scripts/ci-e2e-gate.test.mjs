import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const gate = workflow.jobs.e2e.steps.find((step) => step.run)?.run;
const source = gate?.split("<<'NODE'\n")[1]?.replace(/\nNODE\s*$/, '');
const states = ['success', 'failure', 'cancelled', 'skipped'];
const scopes = ['true', 'false', ''];
const cases = states.flatMap((changes) => scopes.flatMap((web) =>
  scopes.flatMap((server) => states.map((browsers) => ({ changes, web, server, browsers })))));

describe('stable e2e completion gate', () => {
  it.each(cases)('executes CI gate for $changes/$web/$server/$browsers', ({ changes, web, server, browsers }) => {
    expect(source).toBeTruthy();
    const expected = changes === 'success' && web !== '' && server !== '' &&
      browsers === (web === 'true' || server === 'true' ? 'success' : 'skipped');
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: source,
      env: { ...process.env, CHANGES: changes, WEB_NEEDED: web, SERVER_NEEDED: server, BROWSERS: browsers },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(expected ? 0 : 1);
  });
});
