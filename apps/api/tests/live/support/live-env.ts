/**
 * The live suites' guard (#758). Loaded as the setup file of
 * vitest.live.config.ts, it fails every live file loudly when the run could
 * not reach the real model: no AI_GATEWAY_API_KEY in the root .env, or the AI
 * stubbed (BOB_AI_STUB / BOB_SYSTEM_TEST). A silent skip would report a
 * green live run that called nothing.
 *
 * The test files import `liveRun` too: outside vitest.live.config.ts (a unit
 * run whose include pattern happens to match) they skip instead of billing
 * the gateway.
 */
import { AI_GATEWAY_API_KEY, AI_STUB_MODE, refuseProductionKey } from '@bob/ai';

/** True only under vitest.live.config.ts, which sets BOB_LIVE_TESTS=1. */
export const liveRun = process.env.BOB_LIVE_TESTS === '1';

if (liveRun) {
  if (!AI_GATEWAY_API_KEY) {
    throw new Error('test:live needs AI_GATEWAY_API_KEY in the root .env; refusing to run (a skipped live run proves nothing).');
  }
  if (AI_STUB_MODE) {
    throw new Error('test:live refuses to run with the AI stubbed (BOB_AI_STUB / BOB_SYSTEM_TEST is set).');
  }
  // #1041: never on the production key's budget.
  refuseProductionKey();
  // The root .env may point BOB_DATABASE_URL at the hosted database. A live
  // suite writes only to its own per-file database on the local stack
  // (setSharedDb), so the URL is dropped here: a getDb() the suite did not
  // redirect then never writes test rows to production.
  delete process.env.BOB_DATABASE_URL;
}
