/**
 * #550: Playwright UI suite for the web app's critical flows. See
 * docs/testing/e2e.md. Specs are `e2e/*.e2e.ts` (not *.spec.ts, which vitest
 * would pick up). Every flow runs at 1280 px and 390 px, one at a time: all
 * specs share the run's one account: a brand-new account per run, made by
 * e2e/global-setup.ts. The fresh-state project checks it starts empty before
 * any other spec runs.
 */
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { join } from 'node:path';
import {
  AUTH_FILE,
  BASE_URL,
  E2E_API_PORT,
  E2E_DATA,
  E2E_WEB_PORT,
  FOUND_BASE_URL,
  REPO_ROOT,
  UI_ROOT,
  isLive,
} from './e2e/stack.ts';

const CI = Boolean(process.env.CI);
/** CI installs Chromium; locally the suite drives the installed Microsoft Edge. */
const browser = CI ? { channel: 'chromium' } : { channel: 'msedge' };

/** The suite's own stack: an API on the dev:offline stack (e2e/start-stack.ts) plus a web server proxying to it. */
const startedStack: NonNullable<PlaywrightTestConfig['webServer']> = [
  {
    command: 'npx tsx apps/ui-v2/e2e/start-stack.ts',
    cwd: REPO_ROOT,
    url: `http://127.0.0.1:${E2E_API_PORT}/health`,
    reuseExistingServer: !CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  {
    command: 'npx vite --config e2e/vite.e2e.config.ts --strictPort',
    cwd: UI_ROOT,
    url: `http://127.0.0.1:${E2E_WEB_PORT}`,
    env: { BOB_WEB_PORT: String(E2E_WEB_PORT), BOB_E2E_API_PORT: String(E2E_API_PORT) },
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
];

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.(e2e|setup)\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  outputDir: join(E2E_DATA, 'test-results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: isLive() ? 120_000 : 60_000,
  expect: { timeout: isLive() ? 60_000 : 10_000 },
  reporter: [
    CI ? ['github'] : ['list'],
    ['html', { outputFolder: join(E2E_DATA, 'report'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    ...browser,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/, use: { ...devices['Desktop Chrome'], ...browser } },
    {
      name: 'fresh-state',
      testMatch: /fresh-state\.e2e\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], ...browser, storageState: AUTH_FILE },
    },
    {
      name: 'desktop-1280',
      testMatch: /.*\.e2e\.ts$/,
      testIgnore: /fresh-state\.e2e\.ts$/,
      dependencies: ['fresh-state'],
      use: { ...devices['Desktop Chrome'], ...browser, viewport: { width: 1280, height: 800 }, storageState: AUTH_FILE },
    },
    {
      name: 'mobile-390',
      testMatch: /.*\.e2e\.ts$/,
      testIgnore: /fresh-state\.e2e\.ts$/,
      dependencies: ['fresh-state'],
      use: {
        ...devices['Desktop Chrome'],
        ...browser,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        storageState: AUTH_FILE,
      },
    },
  ],
  webServer: FOUND_BASE_URL ? undefined : startedStack,
});
