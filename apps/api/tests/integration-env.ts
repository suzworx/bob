/**
 * Integration env (#551, #735): a setupFiles entry of vitest.integration.config.ts,
 * so it runs before a flow file imports anything. @bob/ai reads the stub flag
 * once at import (AI_STUB_MODE), and flow files import src/app-deps.ts
 * statically, so setting it later in bootIntegrationServer was too late: the
 * turns called the real AI Gateway.
 */
export const DEVICE_SECRET = 'integration-secret';
export const TRANSCRIPT = 'integration what is on today';

process.env.BOB_AI_STUB = '1';
process.env.BOB_SYSTEM_TEST = '1';
process.env.BOB_SYSTEM_TEST_TRANSCRIPT = TRANSCRIPT;
process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '1';
process.env.BOB_V2_HOST = '127.0.0.1';
process.env.DEVICE_SHARED_SECRET = DEVICE_SECRET;
