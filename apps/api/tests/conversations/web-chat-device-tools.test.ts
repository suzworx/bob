// Epic #311 on the web turn: timers and voice tools always ride with the
// productivity group (tool-wiring.test.ts proves the full registry); the device
// tools appear only while the account has a connected device, and then drive it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { webTurnTools } from '../../src/conversations/chat-tools.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import type { Db } from '../../src/platform/db/db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
const USER = '5e7b2c10-2222-4a3b-8c4d-9e0f1a2b3c4d';
const OTHER = '5e7b2c10-3333-4a3b-8c4d-9e0f1a2b3c4d';
// The binders only close over the Db; building the tools runs no query.
const db = {} as Db;

afterEach(() => getDeviceSessions().clear());

describe('webTurnTools', () => {
  it('offers timers and voice tools, and no device tools without a connected device', () => {
    const names = Object.keys(webTurnTools(appDeps, db, USER, 'Asia/Kolkata', 'space-1'));
    for (const name of ['set_timer', 'list_timers', 'create_reminder', 'read_inbox']) expect(names).toContain(name);
    expect(names).not.toContain('set_volume');
    expect(names).not.toContain('set_mode');
  });

  it('omits the voice tools with the productivity group when no Space resolved', () => {
    const names = Object.keys(webTurnTools(appDeps, db, USER, 'UTC', null));
    expect(names).toContain('set_timer');
    expect(names).not.toContain('create_note');
  });

  it('with a connected device, set_mode drives that device -- never another account\'s', async () => {
    const mine = { readyState: 1, send: vi.fn() };
    const theirs = { readyState: 1, send: vi.fn() };
    getDeviceSessions().register(mine as unknown as WebSocket, { id: 'session_web_mine', stage: 'ready' }, USER, null);
    getDeviceSessions().register(theirs as unknown as WebSocket, { id: 'session_web_other', stage: 'ready' }, OTHER, null);
    const tools = webTurnTools(appDeps, db, USER, 'UTC', 'space-1');
    const result = await tools.set_mode!.execute!({ mode: 'announce_only' } as never, {} as never);
    expect(result).toEqual({ ok: true, message: 'Switched to announcements only.' });
    expect(JSON.parse(mine.send.mock.calls[0]![0] as string)).toMatchObject({ type: 'device_control', payload: { mode: 'announce_only' } });
    expect(theirs.send).not.toHaveBeenCalled();
  });
});
