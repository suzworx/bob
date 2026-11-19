import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

process.env.BOB_ROUTINES_DEMO = '1';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: './e2e', testMatch: /routines-demo\.e2e\.ts$/, fullyParallel: false, workers: 1,
  timeout: 240_000, expect: { timeout: 15_000 }, retries: 0,
  outputDir: '../../data/routines-demo/test-results',
  reporter: [['list'], ['html', { outputFolder: '../../data/routines-demo/report', open: 'never' }]],
  use: { actionTimeout: 10_000, baseURL: 'http://127.0.0.1:5188', channel: 'msedge', screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'on' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: [
    { command: 'npx tsx scripts/demo-routines.ts', cwd: root, url: 'http://127.0.0.1:7488/health', reuseExistingServer: false, timeout: 180_000 },
    { cwd: fileURLToPath(new URL('.', import.meta.url)), command: 'npx vite --config e2e/vite.e2e.config.ts --host 127.0.0.1 --strictPort', url: 'http://127.0.0.1:5188', reuseExistingServer: false,
      env: { BOB_WEB_PORT: '5188', BOB_E2E_API_PORT: '7488' }, timeout: 120_000 },
  ],
});
