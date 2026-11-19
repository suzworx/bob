import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// test:integration (#551). Runs ONLY apps/api/tests/integration/*.integration.ts:
// the real server on a free loopback port on the test database, AI stubbed, driven over
// HTTP and the device WebSocket (docs/testing/integration.md). The suffix keeps
// these out of the default run (root vitest.config.ts matches *.test.ts), so
// `npm test` does not pay for them twice; CI runs them as their own job. root
// is pinned to the repo so the include resolves the same from either the repo
// root or apps/api.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  test: {
    root: rootDir,
    include: ['apps/api/tests/integration/**/*.integration.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The AI stub env must be set before any import of @bob/ai (#735).
    setupFiles: ['apps/api/tests/integration-env.ts'],
    // The first boot may build the migration template (tests/support/pg-template.ts).
    hookTimeout: 120_000,
    testTimeout: 60_000,
    server: {
      deps: {
        inline: ['@bob/ai'],
      },
    },
  },
});
