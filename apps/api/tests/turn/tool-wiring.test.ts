// SIMPLIFY-U4: one copy of the ability wiring. The device turn and the web chat turn build their first-party tool
// groups through the same registry builder, so for one account both surfaces offer the same keys in the same order.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { firstPartyToolGroups } from '../../src/turn/tool-wiring.ts';
import { deviceToolContext } from '../../src/voice/turn/tools.ts';
import { webToolContext } from '../../src/conversations/chat-tools.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { createAppDeps } from '../../src/app-deps.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { SessionDto } from '../../src/voice/protocol.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import type { TurnMemoryContext } from '../../src/voice/turn/context.ts';

const appDeps = createAppDeps();
const USER = '5e7b2c10-2222-4a3b-8c4d-9e0f1a2b3c4d';
// The binders only close over the Db; building the tools runs no query.
const db = {} as Db;

afterEach(() => getDeviceSessions().clear());

function deviceGroups(spaceId: string | null) {
  const session = { id: 'session_dev', auth: { kind: 'device', deviceId: 'device-1', name: 'Desk' } } as unknown as SessionDto;
  const memory = { db, userId: USER, timeZone: 'UTC' } as unknown as TurnMemoryContext;
  return firstPartyToolGroups(deviceToolContext(appDeps as unknown as TurnDeps, session, memory, spaceId));
}

function chatGroups(spaceId: string | null) {
  return firstPartyToolGroups(webToolContext(appDeps, db, USER, 'UTC', spaceId));
}

describe('firstPartyToolGroups', () => {
  it('gives the device and the chat turn the same first-party keys, in the same order, for one account', () => {
    const socket = { readyState: 1, send: vi.fn() };
    getDeviceSessions().register(socket as unknown as WebSocket, { id: 'session_dev', stage: 'ready' }, USER, 'device-1');
    const device = deviceGroups('space-1');
    const chat = chatGroups('space-1');
    expect(Object.keys(device.timers)).toEqual(Object.keys(chat.timers));
    expect(Object.keys(device.late)).toEqual(Object.keys(chat.late));
    // Timers lead (early); voice, apps and device trail (late).
    expect(Object.keys(device.timers)).toContain('set_timer');
    expect(Object.keys(device.late)).toContain('set_volume');
  });

  it('omits the space-bound late tools on both surfaces when no Space resolved', () => {
    const socket = { readyState: 1, send: vi.fn() };
    getDeviceSessions().register(socket as unknown as WebSocket, { id: 'session_dev', stage: 'ready' }, USER, 'device-1');
    expect(Object.keys(deviceGroups(null).late)).toEqual(Object.keys(chatGroups(null).late));
    expect(Object.keys(chatGroups(null).late)).not.toContain('create_note');
  });
});
