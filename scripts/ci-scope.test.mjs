import { describe, expect, it } from 'vitest';

import { decide, diffRange, scope } from './ci-scope.mjs';

const EVERYTHING = { web: true, server: true, firmware: true, docker: true };
const only = (...jobs) => ({
  web: jobs.includes('web'),
  server: jobs.includes('server'),
  firmware: jobs.includes('firmware'),
  docker: jobs.includes('docker'),
});

describe('ci scope', () => {
  it('maps each app to the jobs that test or ship it', () => {
    expect(scope(['apps/ui-v2/src/app.tsx'])).toEqual(only('web', 'docker'));
    expect(scope(['apps/mobile/capacitor.config.ts'])).toEqual(only('web'));
    expect(scope(['.env.example'])).toEqual(only('web'));
    expect(scope(['apps/api/src/turn.ts'])).toEqual(only('web', 'server', 'docker'));
    expect(scope(['apps/ai/src/tools.ts'])).toEqual(only('web', 'server', 'docker'));
    expect(scope(['supabase/migrations/0001_init.sql'])).toEqual(only('web', 'server'));
    expect(scope(['apps/cardputer/src/main.cpp'])).toEqual(only('web', 'firmware'));
    expect(scope(['apps/cardputer/ca-roots/isrg-root-x1.pem'])).toEqual(only('web', 'firmware'));
    // Shared wire fixtures: parsed by the firmware host tests, checked by the api suite.
    expect(scope(['apps/cardputer/test/fixtures/wire/welcome.json'])).toEqual(only('server', 'firmware'));
    expect(scope(['apps/cardputer/test/host/test_parsers.cpp'])).toEqual(only('firmware'));
    expect(scope(['Dockerfile', '.dockerignore'])).toEqual(only('docker'));
    expect(scope(['scripts/fetch-verified.mjs', 'scripts/start-server.sh'])).toEqual(only('docker'));
  });

  it('unions the jobs of every changed file', () => {
    expect(scope(['apps/ui-v2/src/app.tsx', 'apps/cardputer/src/main.cpp']))
      .toEqual(only('web', 'firmware', 'docker'));
  });

  // The web job runs the scripts suite, whose repo-wide rules (no-agent-doubles
  // and the like) read app sources and tests. #579 changed only these two api
  // test files, the filter skipped web, and a rule it broke reached main2.
  it('runs the repo-wide rule tests (web) for any app source or test change', () => {
    expect(scope(['apps/api/tests/voice/game-modes.test.ts', 'apps/api/tests/support/game-states.ts']).web).toBe(true);
    for (const file of ['apps/api/tests/voice/turn.test.ts', 'apps/api/src/turn.ts', 'apps/ai/tests/tools.test.ts',
      'apps/cardputer/src/main.cpp', 'apps/cardputer/test/host/test_parsers.cpp', 'scripts/no-agent-doubles.test.mjs']) {
      expect(scope([file]).web, file).toBe(file !== 'apps/cardputer/test/host/test_parsers.cpp');
    }
  });

  it('runs everything for files every job depends on', () => {
    for (const file of ['.github/workflows/ci.yml', 'package.json', 'package-lock.json',
      'tsconfig.json', 'tsconfig.base.json', 'scripts/validate.mjs']) {
      expect(scope(['apps/api/src/turn.ts', file]), file).toEqual(EVERYTHING);
    }
  });

  it('runs nothing for prose no job reads', () => {
    expect(scope(['README.md', 'docs/log-reference.md', '.claude/settings.json']))
      .toEqual(only());
    expect(scope(['README.md', 'apps/api/src/turn.ts'])).toEqual(only('web', 'server', 'docker'));
    expect(scope(['apps/ui-v2/CLAUDE.md'])).toEqual(only('web', 'docker'));
  });

  it('runs everything for a path no rule knows', () => {
    expect(scope(['vitest.config.ts'])).toEqual(only('web', 'server'));
    expect(scope(['.github/workflows/pr-title.yml'])).toEqual(EVERYTHING);
    expect(scope(['scripts/dev-all.mjs'])).toEqual(EVERYTHING);
    expect(scope(['apps/new-thing/index.ts'])).toEqual(EVERYTHING);
  });

  it('does not treat a nested manifest as a root one', () => {
    expect(scope(['apps/api/package.json', 'apps/api/tsconfig.json'])).toEqual(only('server', 'docker'));
  });
});

describe('ci diff range', () => {
  it('diffs a pull request against its base', () => {
    expect(diffRange({ event: 'pull_request', baseRef: 'main' })).toBe('origin/main...HEAD');
  });

  it('diffs a push from its before commit', () => {
    expect(diffRange({ event: 'push', before: 'a'.repeat(40), sha: 'b'.repeat(40) }))
      .toBe(`${'a'.repeat(40)}..${'b'.repeat(40)}`);
  });

  it('has no range for a new branch, a manual run, or missing context', () => {
    expect(diffRange({ event: 'push', before: '0'.repeat(40), sha: 'b'.repeat(40) })).toBeNull();
    expect(diffRange({ event: 'workflow_dispatch' })).toBeNull();
    expect(diffRange({ event: 'pull_request' })).toBeNull();
  });
});

describe('ci decision', () => {
  it('runs everything when the diff failed', () => {
    expect(decide({ event: 'pull_request', files: null })).toEqual(EVERYTHING);
  });

  it.each(['push', 'pull_request'])('keeps all software checks without firmware for a known software %s', (event) => {
    const files = [
      'apps/api/src/integrations/google-tools.ts',
      'apps/ui-v2/src/features/chat/composer.tsx',
      'supabase/migrations/20261023040000_google_account_custom_name.sql',
      'scripts/demo-routines.ts', 'scripts/demo-routines-model.ts',
      'scripts/ci-scope.mjs', 'scripts/ci-scope.test.mjs', 'README.md',
    ];
    expect(decide({ event, files })).toEqual(only('web', 'server', 'docker'));
  });

  it.each(['push', 'pull_request'])('still requires firmware for hardware, wire and uncertain %s changes', (event) => {
    for (const file of [
      'apps/cardputer/src/main.cpp', 'apps/cardputer/platformio.ini',
      'apps/cardputer/test/fixtures/wire/welcome.json',
      'apps/api/src/voice/protocol.ts', 'apps/api/src/voice/protocol-timing.ts',
      'apps/api/tests/voice/protocol.test.ts', 'package-lock.json',
      '.github/workflows/ci.yml', 'scripts/validate.mjs', 'scripts/new-tool.mjs',
    ]) {
      expect(decide({ event, files: ['apps/api/src/integrations/google-tools.ts', file] }).firmware, file).toBe(true);
    }
    expect(decide({ event, files: null })).toEqual(EVERYTHING);
  });

  it('does not extend the software-script exceptions to similarly named scripts', () => {
    expect(scope(['scripts/demo-routines-build.ts'])).toEqual(EVERYTHING);
    expect(scope(['scripts/ci-scope-extra.mjs'])).toEqual(EVERYTHING);
  });

  it('runs everything for unsupported events even with supplied files', () => {
    expect(decide({ event: 'workflow_dispatch', files: ['apps/ui-v2/src/app.tsx'] })).toEqual(EVERYTHING);
  });
});
