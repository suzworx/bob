import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// test:scenarios (SCEN-LIVE). The pre-release LIVE scenario suite: real model
// calls through the device-turn agent path, then assertions on the rows the
// turn saved. It costs money, so it is NOT part of `npm test` / validate: the
// files are named *.scenario.ts, which the default vitest include never
// matches. The suite skips itself when AI_GATEWAY_API_KEY is unset; .env is
// deliberately NOT loaded here, so an offline run never spends by accident.
// Needs the local Supabase stack (tests/support/test-db.ts), like test:db.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Printed here, in the main process: vitest drops console output from a
// skipped file, so a message in the suite itself is never seen.
if ((process.env.AI_GATEWAY_API_KEY ?? '') === '') {
  console.warn('[test:scenarios] AI_GATEWAY_API_KEY is unset: SKIPPING the live scenario suite (it calls the real model).');
}

export default defineConfig({
  test: {
    root: rootDir,
    include: ['apps/api/tests/scenarios/**/*.scenario.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'data/**'],
    // One model call per turn, sometimes two or three steps with tools.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    // BOB_TEST_DOTENV (#898) opts this suite back into loading the
    // repo-root .env inside @bob/ai's config.ts: it needs the developer's
    // AI_GATEWAY_API_KEY to make the real model calls once the suite decides
    // (above, against the unloaded shell env) not to skip itself.
    env: { BOB_TEST_DOTENV: '1' },
    server: {
      deps: {
        inline: ['@bob/ai'],
      },
    },
  },
});
