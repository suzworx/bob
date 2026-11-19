import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // *.db.test.ts suites drive the local Supabase stack themselves (010, R6);
    // they run only under `npm run test:db` (apps/api/vitest.db.config.ts). The
    // default run needs the stack too: every api suite clones a template on it.
    // .claude/worktrees and data/ hold whole checkouts of OTHER branches (agent
    // worktrees, git-ignored scratch). A path filter like `vitest run scripts/`
    // matched their stale copies too, so a leftover worktree failed the gate.
    // .flywheel/worktrees holds the same kind of checkouts for flywheel units.
    // Root script filters are substring matches: tools/ must not select a
    // workspace's features/tools tests without that workspace's setup. These
    // patterns are relative to the test root, so app-local suites still run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts', '**/*.live.test.ts', '.claude/**', '.flywheel/**', 'data/**',
      'apps/*/src/**', 'apps/*/tests/**', 'apps/*/e2e/**'],
    // The api suites clone a Postgres template per test (createTestDb) and drop
    // it in a hook (closeTestDb). Under vitest's own worker parallelism that
    // loses the race against the 5 s test / 10 s hook defaults: the full run
    // timed out in test-db.test.ts, test-support.test.ts and, as a whole suite,
    // store-invitations.test.ts's afterAll. These are the budget those clones
    // need under load, not a licence for slow tests.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // CI runs on 4-vCPU runners: one worker per vCPU. Locally vitest picks.
    maxWorkers: process.env.CI ? 4 : undefined,
    server: {
      deps: {
        inline: ['@bob/ai'],
      },
    },
  },
});
