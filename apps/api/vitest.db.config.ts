import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// test:db (010, T009, research R6). Runs ONLY the *.db.test.ts suites, which
// drive the LOCAL Supabase stack in Docker itself (`npx supabase start` +
// `migration up --local`, through db-harness.ts) rather than a per-file
// template copy: vector retrieval and the two-account isolation matrix. root
// is pinned to the repo so the include pattern resolves the same from either
// the repo root or apps/api. The default run excludes the pattern (root
// vitest.config.ts); its suites use per-file template copies on the same stack.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  test: {
    root: rootDir,
    include: ['apps/api/tests/**/*.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // db-harness.ts brings the stack up and applies migrations in beforeAll,
    // which exceeds the default 10 s hook timeout.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Every *.db.test.ts shares the one local Supabase stack and the harness
    // runs `npx supabase` CLI calls (start/status/db query), so two files
    // running at once step on each other. Run them serially.
    fileParallelism: false,
    server: {
      deps: {
        inline: ['@bob/ai'],
      },
    },
  },
});