/**
 * Date context injection (SCAN-DATE-AGENT): every agent call sends the current
 * date and time, so relative dates like "today" and "this week" anchor to now,
 * not the model's training data. The date line rides the one per-turn context
 * system message before the final user message; the instructions stay untouched.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createBobAgent, bobAgent, resolveTimeZone, BOB_AGENT_INSTRUCTIONS } from '@bob/ai';
import { dateContextLine } from '@bob/ai/testing';

/**
 * ToolLoopAgent keeps its constructor settings in a private field that is a
 * plain own property at runtime; the tests read it to compare the factory's
 * config with the singleton's without calling the model.
 */
function settingsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: Record<string, unknown> }).settings;
}

describe('dateContextLine', () => {
  it('formats the date in en-GB with the given timezone', () => {
    const date = new Date('2026-09-22T15:52:00Z');
    const line = dateContextLine(date, 'UTC');
    expect(line).toContain('22 September 2026');
    expect(line).toContain('15:52');
    expect(line).toContain('2026-09-22T15:52Z');
  });

  it('respects the timezone offset', () => {
    const date = new Date('2026-09-22T15:52:00Z');
    const line = dateContextLine(date, 'America/New_York');
    expect(line).toContain('22 September 2026');
    expect(line).toContain('11:52');
    expect(line).toContain('2026-09-22T15:52Z');
  });

  it('falls back to UTC for an invalid timezone without throwing', () => {
    const date = new Date('2026-09-22T15:52:00Z');
    const line = dateContextLine(date, 'Invalid/Zone');
    expect(line).toContain('22 September 2026');
    expect(line).toContain('15:52');
    expect(line).toContain('2026-09-22T15:52Z');
    expect(line).toContain('UTC');
  });

  it('includes the directive to resolve relative dates from the current time', () => {
    const line = dateContextLine(new Date('2026-09-22T15:52:00Z'));
    expect(line).toMatch(/Resolve.*today.*this week.*tomorrow/i);
    expect(line).toMatch(/relative date/i);
    expect(line).toMatch(/never assume an earlier year/i);
    expect(line).not.toMatch(/in this year/);
  });
});

type Message = { role: string; content: string };

/** Runs an agent's prepareCall over a one-message prompt and returns the settings it hands the model. */
function prepared(agent: unknown): { instructions?: unknown; messages: Message[] } {
  const prepareCall = settingsOf(agent).prepareCall as (opts: unknown) => { instructions?: unknown; messages: Message[] };
  return prepareCall({ instructions: BOB_AGENT_INSTRUCTIONS, messages: [{ role: 'user', content: 'hi' }] });
}

/** The system message the per-turn context rides in (the one before the final user message). */
function contextOf(result: { messages: Message[] }): string {
  const message = result.messages.find((m) => m.role === 'system');
  return message?.content ?? '';
}

describe('agent date context injection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts the date in the context message of the singleton, leaving the instructions untouched', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T15:52:00Z'));
    const result = prepared(bobAgent);
    expect(result.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    expect(contextOf(result)).toContain('22 September 2026');
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
  });

  it('puts the date in the context message of a factory agent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T15:52:00Z'));
    const result = prepared(createBobAgent());
    expect(result.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    expect(contextOf(result)).toContain('22 September 2026');
  });

  it('puts the date and the memory context together in the context message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T15:52:00Z'));
    const context = '[BOB MEMORY\nFact: X\n[END BOB MEMORY]';
    const result = prepared(createBobAgent({ memoryContext: context }));
    expect(result.instructions).toBe(BOB_AGENT_INSTRUCTIONS);
    expect(contextOf(result)).toContain(context);
    expect(contextOf(result)).toContain('22 September 2026');
  });

  it('builds the singleton and a no-option factory agent the same way', () => {
    const singleton = settingsOf(bobAgent);
    const factory = settingsOf(createBobAgent());
    expect(Object.keys(factory).sort()).toEqual(Object.keys(singleton).sort());
    expect(factory.instructions).toEqual(singleton.instructions);
  });
});

describe('account timezone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolveTimeZone keeps a valid IANA zone and falls back to UTC otherwise', () => {
    expect(resolveTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(resolveTimeZone('Invalid/Zone')).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone(42)).toBe('UTC');
  });

  it('a factory agent with an account zone anchors "today" in that zone', () => {
    // 02:00 UTC on the 23rd is still the evening of the 22nd in California.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T02:00:00Z'));
    const context = contextOf(prepared(createBobAgent({ timeZone: 'America/Los_Angeles' })));
    expect(context).toContain('America/Los_Angeles');
    expect(context).toContain('22 September 2026');
    expect(context).toContain('19:00');
  });

  it('an invalid account zone falls back to UTC in the prompt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T02:00:00Z'));
    const context = contextOf(prepared(createBobAgent({ timeZone: 'Not/AZone' })));
    expect(context).toContain('23 September 2026');
    expect(context).toContain('(UTC;');
  });

  it("the account zone is currentDateTime's default zone", async () => {
    const tools = settingsOf(createBobAgent({ timeZone: 'Asia/Kolkata' })).tools as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<{ timezone: string }> | { timezone: string } }
    >;
    const output = await tools.currentDateTime!.execute({}, { toolCallId: 't', messages: [] });
    expect(output.timezone).toBe('Asia/Kolkata');
  });
});
