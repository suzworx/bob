import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { uiActionInstrumentation } from './scripts/ui-action-instrumentation.ts';

export default defineConfig({
  plugins: [uiActionInstrumentation(), react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Astryx ships plain CSS next to its JS; jsdom only needs the imports to resolve.
    css: false,
    // Tests here take 0.3-0.6 s idle and hit vitest's 5 s default only under CPU
    // contention (3 timeouts per run with the cores saturated). Same reasoning
    // as the root config's budget for the api suite.
    testTimeout: 15_000,
    // CI runs on 4-vCPU runners: one worker per vCPU. Locally vitest picks.
    maxWorkers: process.env.CI ? 4 : undefined,
  },
});
