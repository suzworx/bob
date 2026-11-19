import { describe, expect, it } from 'vitest';
import { exists, pathsIn } from './check-doc-paths.mjs';

const TRACKED = ['apps/api/src/server.ts', 'apps/api/src/store/db.ts', 'apps/api/src/schemas.ts', 'docs/log-reference.md', 'scripts/validate.mjs'];

describe('pathsIn', () => {
  it('finds backticked file and folder paths with their line numbers', () => {
    const text = 'See `apps/api/src/server.ts` and\n`store/db.ts:120` plus `scripts/`.';
    expect(pathsIn(text)).toEqual([
      { path: 'apps/api/src/server.ts', line: 1 },
      { path: 'store/db.ts', line: 2 },
      { path: 'scripts/', line: 2 },
    ]);
  });

  it('skips commands, URLs, globs, placeholders and fenced blocks', () => {
    const text = '`npm run dev` `https://x.dev/a.ts` `apps/*/src/a.ts` `<name>.ts` `a b.ts`\n```\n`fenced/path.ts`\n```\n';
    expect(pathsIn(text)).toEqual([]);
  });
});

describe('exists', () => {
  it('matches a full path, a workspace-relative suffix and a folder', () => {
    expect(exists('apps/api/src/server.ts', TRACKED)).toBe(true);
    expect(exists('store/db.ts', TRACKED)).toBe(true);
    expect(exists('schemas.ts', TRACKED)).toBe(true);
    expect(exists('scripts/', TRACKED)).toBe(true);
    expect(exists('apps/api/src/', TRACKED)).toBe(true);
  });

  it('fails a file that moved or never existed, and does not match half a file name', () => {
    expect(exists('core/outbox-worker-old.ts', TRACKED)).toBe(false);
    expect(exists('erver.ts', TRACKED)).toBe(false);
  });

  it('lets runtime-only paths through', () => {
    expect(exists('data/v2-journal.log', TRACKED)).toBe(true);
    expect(exists('apps/api/data/', TRACKED)).toBe(true);
    expect(exists('include/secrets.h', TRACKED)).toBe(true);
  });
});
