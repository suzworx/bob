/**
 * ToolProvider registry (ADR 0002, #663): scoping, ordering and the three
 * first-party providers. Plain fakes; no store is touched (tool binding builds
 * closures only).
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { createDeviceTools, createTimerTools, createVoiceTools } from '@bob/ai';
import { createToolRegistry, type ToolProvider } from '../../src/voice/tool-registry.ts';
import { bindDeviceTools } from '../../src/voice/device-tools.ts';
import { bindVoiceTools } from '../../src/voice/voice-tools.ts';
import { bindTimerTools } from '../../src/timers/tools.ts';
import { firstPartyToolProviders, type FirstPartyToolContext } from '../../src/voice/tool-providers.ts';
import type { Db } from '../../src/platform/db/db.ts';

const fakeTool = (name: string): Tool => ({ description: name }) as unknown as Tool;
const fake = (id: string, order: number, slot: 'early' | 'late', extra: Partial<ToolProvider<{ n: number }>> = {}): ToolProvider<{ n: number }> => ({
  id, scopes: [], slot, order, needs: () => true, createTools: () => ({ [id]: fakeTool(id) }), ...extra,
});

describe('createToolRegistry', () => {
  it('merges by slot in ascending order, whatever the registration order', async () => {
    const registry = createToolRegistry<{ n: number }>([fake('c', 30, 'late'), fake('a', 10, 'early'), fake('b', 20, 'late'), fake('z', 5, 'early')]);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'early'))).toEqual(['z', 'a']);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'late'))).toEqual(['b', 'c']);
  });

  it('skips a provider whose needs are unmet without calling it', async () => {
    let called = false;
    const registry = createToolRegistry<{ n: number }>([
      fake('skipped', 1, 'late', { needs: () => false, createTools: () => { called = true; return {}; } }),
      fake('kept', 2, 'late'),
    ]);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'late'))).toEqual(['kept']);
    expect(called).toBe(false);
  });

  it('honours granted scopes: a provider needing an ungranted scope is dropped', async () => {
    const registry = createToolRegistry<{ n: number }>([
      fake('timers', 1, 'early', { scopes: ['timers'] }),
      fake('device', 2, 'early', { scopes: ['device.control'] }),
    ]);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'early', { granted: ['timers'] }))).toEqual(['timers']);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'early'))).toEqual(['timers', 'device']);
  });

  it('resolveSync matches resolve for sync providers and refuses an async one', async () => {
    const registry = createToolRegistry<{ n: number }>([fake('a', 1, 'early'), fake('b', 2, 'early')]);
    expect(Object.keys(registry.resolveSync({ n: 1 }, 'early'))).toEqual(Object.keys(await registry.resolve({ n: 1 }, 'early')));
    const asyncOne = createToolRegistry<{ n: number }>([fake('a', 1, 'early', { createTools: () => Promise.resolve({}) })]);
    expect(() => asyncOne.resolveSync({ n: 1 }, 'early')).toThrow(/async/);
  });

  it('awaits async providers and rejects duplicate ids', async () => {
    const registry = createToolRegistry<{ n: number }>([fake('a', 1, 'early', { createTools: () => Promise.resolve({ a: fakeTool('a') }) })]);
    expect(Object.keys(await registry.resolve({ n: 1 }, 'early'))).toEqual(['a']);
    expect(() => createToolRegistry([fake('a', 1, 'early'), fake('a', 2, 'late')])).toThrow(/duplicate/);
  });
});

describe('first-party providers', () => {
  const db = {} as Db;
  const notExpress = (name: string): boolean => name !== 'express';
  const registry = createToolRegistry<FirstPartyToolContext>(firstPartyToolProviders());
  const timersChanged = (): Promise<void> => Promise.resolve();
  const device = { registry: { hasCap: () => false } as never, userId: 'u', deviceId: null, state: () => undefined };
  const base = { db, userId: 'u', timeZone: 'UTC', timersChanged };

  it('offers timers early, and voice then device late, exactly as the hand-built sets did', async () => {
    const ctx: FirstPartyToolContext = { ...base, spaceId: 's1', device };
    expect(Object.keys(await registry.resolve(ctx, 'early'))).toEqual(Object.keys(createTimerTools(bindTimerTools(db, 'u', { timeZone: 'UTC', onChange: timersChanged }))));
    expect(Object.keys(await registry.resolve(ctx, 'late'))).toEqual([
      ...Object.keys(createVoiceTools(bindVoiceTools(db, 'u', { spaceId: 's1', timeZone: 'UTC' }))),
      ...Object.keys(createDeviceTools(bindDeviceTools(device))).filter(notExpress),
      'propose_bob_app', 'revise_bob_app', 'list_bob_apps', 'read_bob_app',
    ]);
  });

  it('offers express only when a target device advertises the cap', async () => {
    const capable = { ...device, registry: { hasCap: () => true } as never };
    const names = Object.keys(await registry.resolve({ ...base, spaceId: null, device: capable }, 'late'));
    expect(names).toContain('express');
    expect(Object.keys(await registry.resolve({ ...base, spaceId: null, device }, 'late'))).not.toContain('express');
  });

  it('omits voice tools without a space and device tools without a device target', async () => {
    const noSpace = Object.keys(await registry.resolve({ ...base, spaceId: null, device }, 'late'));
    expect(noSpace).toEqual(Object.keys(createDeviceTools(bindDeviceTools(device))).filter(notExpress));
    expect(await registry.resolve({ ...base, spaceId: null }, 'late')).toEqual({});
  });
});
