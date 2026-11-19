/**
 * #396: createBobAgent's `onFinish` reaches the ToolLoopAgent (as `onEnd`),
 * so the web route can journal all-step usage while apps/ai stays
 * journal-free. Without it the factory stays config-identical to the singleton.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBobAgent, bobAgent } from '@bob/ai';

/** ToolLoopAgent keeps its constructor settings on a private `settings` field. */
function settingsOf(agent: unknown): Record<string, unknown> {
  return (agent as { settings: Record<string, unknown> }).settings;
}

describe('createBobAgent onFinish (#396)', () => {
  it('passes onFinish through as the agent end-of-run callback', () => {
    const onFinish = vi.fn();
    const settings = settingsOf(createBobAgent({ onFinish }));
    expect(settings.onEnd).toBe(onFinish);
  });

  it('passes onFinish alongside the per-turn options', () => {
    const onFinish = vi.fn();
    const settings = settingsOf(createBobAgent({ onFinish, timeZone: 'Asia/Kolkata', memoryContext: '[ctx]' }));
    expect(settings.onEnd).toBe(onFinish);
    expect(settings.instructions).not.toContain('[ctx]');
  });

  it('without onFinish sets no callback and matches the singleton', () => {
    const factory = settingsOf(createBobAgent());
    const singleton = settingsOf(bobAgent);
    // The SDK normalises its settings, so the key may exist -- but unset.
    expect(factory.onEnd).toBeUndefined();
    expect(factory.onFinish).toBeUndefined();
    expect(Object.keys(factory).sort()).toEqual(Object.keys(singleton).sort());
    expect(factory.tools).toBe(singleton.tools);
    expect(factory.instructions).toBe(singleton.instructions);
  });
});
