// express and scene go only to devices whose hello advertised the cap; a turn's
// succeeded tool call pushes its scene; the journal carries no label or text.
import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceSessions } from '../../src/voice/device-sessions.ts';
import { rememberSocketCaps } from '../../src/voice/device-caps.ts';
import { pushTurnScene } from '../../src/voice/turn/scenes.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

function fakeSocket(sent: string[]): WebSocket {
  return { readyState: 1, send: (text: string) => { sent.push(text); } } as unknown as WebSocket;
}

let registry: DeviceSessions;
const sent: string[] = [];
const journal: string[] = [];
const session = { id: 's1', auth: { kind: 'device', deviceId: 'dev1', name: 'Bob' } };

function add(caps: string[] | null): void {
  const socket = fakeSocket(sent);
  if (caps !== null) rememberSocketCaps(socket, caps);
  registry.register(socket, session as never, 'u1', 'dev1');
}

beforeEach(() => {
  sent.length = 0;
  journal.length = 0;
  setJournalSink((line) => { journal.push(typeof line === 'string' ? line : JSON.stringify(line)); });
  registry = new DeviceSessions({ subscribe: () => () => undefined });
});

describe('express / scene delivery', () => {
  it('sends express to a device with the express cap', () => {
    add(['express', 'scene']);
    expect(registry.sendExpress('u1', 'dev1', 'love', 6)).toBe(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'express', payload: { emotion: 'love', seconds: 6 } });
  });

  it('skips a device without the cap, and one that sent no caps at all', () => {
    add(['device_control']);
    expect(registry.sendExpress('u1', 'dev1', 'love', 6)).toBe(0);
    expect(registry.sendScene('u1', 'dev1', { scene: 'success', seconds: 4 })).toBe(0);
    registry.unregister(session as never);
    add(null);
    expect(registry.sendExpress('u1', 'dev1', 'love', 6)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('journals the scene name and seconds, never the label or value', () => {
    add(['scene']);
    registry.sendScene('u1', 'dev1', { scene: 'timer_set', seconds: 8, label: 'secret pasta', value: 600 });
    // Without the timestamp: a `.600Z` millisecond matched the value and failed main (a2e8fe6).
    const lines = journal.join('\n').replace(/"ts":"[^"]*"/g, '');
    expect(lines).toContain('v2.scene');
    expect(lines).not.toContain('secret pasta');
    expect(lines).not.toContain('600');
  });
});

describe('pushTurnScene', () => {
  const parts = (...items: Array<Record<string, unknown>>): Array<Record<string, unknown>> => items;

  it('sends the last succeeded tool call with a scene', () => {
    add(['scene']);
    const sentCount = pushTurnScene(
      { deviceSessions: registry }, session, 'u1',
      parts(
        { type: 'tool-set_timer', state: 'output-available', input: { duration: 'PT10M' }, output: { ok: true, message: 'x' } },
        { type: 'tool-list_timers', state: 'output-available', input: {}, output: { ok: true } },
      ),
    );
    expect(sentCount).toBe(1);
    expect(JSON.parse(sent[0]!).payload).toMatchObject({ scene: 'timer_set', value: 600 });
  });

  it('sends nothing for a failed call, an error part or an unpaired turn', () => {
    add(['scene']);
    const failed = parts({ type: 'tool-set_timer', state: 'output-available', input: { duration: 60 }, output: { ok: false, reason: 'no' } });
    const errored = parts({ type: 'tool-set_timer', state: 'output-error', input: { duration: 60 } });
    const done = parts({ type: 'tool-set_timer', state: 'output-available', input: { duration: 60 }, output: { ok: true, message: 'x' } });
    expect(pushTurnScene({ deviceSessions: registry }, session, 'u1', failed)).toBe(0);
    expect(pushTurnScene({ deviceSessions: registry }, session, 'u1', errored)).toBe(0);
    expect(pushTurnScene({ deviceSessions: registry }, session, undefined, done)).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('express availability', () => {
  it('hasCap is true only for a connected session whose hello has the cap', () => {
    add(['device_control']);
    expect(registry.hasCap('u1', 'dev1', 'express')).toBe(false);
    registry.unregister(session as never);
    add(['express']);
    expect(registry.hasCap('u1', 'dev1', 'express')).toBe(true);
    expect(registry.hasCap('u1', null, 'express')).toBe(true);
    expect(registry.hasCap('u2', null, 'express')).toBe(false);
  });

  it('the bound express callback throws when no device took the message', async () => {
    const { bindDeviceTools } = await import('../../src/voice/device-tools.ts');
    add(['device_control']);
    const cb = bindDeviceTools({ userId: 'u1', deviceId: 'dev1', state: () => undefined, registry });
    await expect(cb.express({ emotion: 'love', seconds: 6 })).rejects.toThrow('cannot show feelings');
    registry.unregister(session as never);
    add(['express']);
    await expect(cb.express({ emotion: 'love', seconds: 6 })).resolves.toBeUndefined();
  });
});
