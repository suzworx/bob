/**
 * #898: unit tests must never read the developer's .env -- a local
 * BOB_TTS_CACHE=on previously changed behaviour under vitest and masked a
 * real cancel race (turn-streaming.test.ts). shouldLoadDotenv is the pure
 * gate config.ts uses before calling dotenv.config().
 */
import { describe, expect, it } from 'vitest';
import { shouldLoadDotenv } from '../src/config.ts';

describe('shouldLoadDotenv (#898)', () => {
  it('skips the developer .env under vitest by default', () => {
    expect(shouldLoadDotenv({ VITEST: 'true' })).toBe(false);
  });

  it('loads the developer .env under vitest when a suite opts in with BOB_TEST_DOTENV=1', () => {
    expect(shouldLoadDotenv({ VITEST: 'true', BOB_TEST_DOTENV: '1' })).toBe(true);
  });

  it('keeps loading the developer .env outside vitest (tsx scripts, evals, the server)', () => {
    expect(shouldLoadDotenv({})).toBe(true);
  });
});
