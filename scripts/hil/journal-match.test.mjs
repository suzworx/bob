import { describe, expect, it } from 'vitest';
import { createLineStream } from './engine.mjs';
import { journalMatch } from './journal-match.mjs';
import { validateScenario } from './schema.mjs';

describe('structured HIL journal matching', () => {
  const matcher = journalMatch({ event: 'v2.hil_command', command: 'pair', outcome: 'manual' });
  it('accepts current telemetry metadata and reordered keys', async () => {
    const line = JSON.stringify({ outcome: 'manual', event: 'v2.hil_command', message: 'v2.hil_command', source: 'api', conversation_id: 'none', command: 'pair' });
    const stream = createLineStream();
    stream.push(line);
    expect(await stream.waitFor(matcher, 0, 10)).toBe(line);
  });
  it('requires all fields on the same valid JSON record', () => {
    for (const value of [
      { event: 'v2.hil_command', command: 'device', outcome: 'manual' },
      { event: 'v2.other', command: 'pair', outcome: 'manual' },
      { event: 'v2.hil_command', command: 'pair', outcome: 'auto' },
      { event: 'v2.hil_command', detail: { command: 'pair', outcome: 'manual' } },
      null,
    ]) expect(matcher.test(JSON.stringify(value))).toBe(false);
    expect(matcher.test('not JSON')).toBe(false);
    expect(matcher.test('{"event":"v2.hil_command"}\n{"command":"pair","outcome":"manual"}')).toBe(false);
  });
  it('supports bounded field patterns without missing-field coercion', () => {
    const burst = journalMatch({ event: 'v2.hil_reply_burst', writes: /^\d+$/ });
    expect(burst.test('{"event":"v2.hil_reply_burst","writes":4}')).toBe(true);
    expect(burst.test('{"event":"v2.hil_reply_burst"}')).toBe(false);
  });
  it('permits structured matchers only for server waits', () => {
    const scenario = { name: 'journal-check', issue: '#baseline', title: 'journal match', steps: [{ waitServer: matcher }] };
    expect(validateScenario(scenario)).toEqual([]);
    expect(validateScenario({ ...scenario, steps: [{ waitDevice: matcher }] })).not.toEqual([]);
  });
});
