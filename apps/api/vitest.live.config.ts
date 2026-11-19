import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// test:live (#758): every real-model test, in apps/api/tests/live/, behind one
// entrypoint. `npm run test:live --workspace @bob/api -- memory` selects a
// suite by file name. These bill the AI Gateway key in the root .env, so
// `validate` and CI never run them. root is pinned to the repo so the include
// pattern resolves the same from either the repo root or apps/api.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  test: {
    root: rootDir,
    include: ['apps/api/tests/live/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The live suites run only here: a unit run that picks a file up skips it.
    // BOB_TEST_DOTENV (#898) opts this suite back into loading the repo-root
    // .env: it needs the developer's AI_GATEWAY_API_KEY, unlike a unit run.
    env: { BOB_LIVE_TESTS: '1', BOB_TEST_DOTENV: '1' },
    // Refuses to run without AI_GATEWAY_API_KEY, or in AI stub mode: a live
    // run that skipped or stubbed the model would pass while proving nothing.
    setupFiles: ['apps/api/tests/live/support/live-env.ts'],
    // Real model turns, real extraction and real embeddings per case.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // One account's journal is captured per case through the process-wide
    // sink, and the files share the local Supabase stack: run them serially.
    fileParallelism: false,
    // No retries: the x3 repeats are the whole spend (agent-behaviour.md §4).
    retry: 0,
    server: {
      deps: {
        inline: ['@bob/ai'],
      },
    },
  },
});
