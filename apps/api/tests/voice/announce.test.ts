// #319 announcements through the device registry: delivered when ready, held
// while busy or in DND, deduped, replayed on reconnect, expired, cleared by
// announce_ack, bounded, and spoken through the injected player.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ANNOUNCE_OUTBOX_CAP, DeviceSessions, type Announcement } from '../../src/voice/device-sessions.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import type { SessionStage } from '../../src/voice/protocol.ts';

type FakeSession = { id: string; stage: SessionStage; deviceState?: { volume: number; muted: boolean; mode: 'ptt'; dnd: boolean } };
const USER = '11111111-1111-4111-8111-111111111111';
let clock = 1_000_000;
let registry: DeviceSessions;
let journal: string[];
const events = { subscribe: () => () => undefined };

function device(id: string, stage: SessionStage = 'ready'): { socket: { readyState: number; send: ReturnType<typeof vi.fn> }; session: FakeSession } {
  const socket = { readyState: 1, send: vi.fn() };
  const session: FakeSession = { id, stage };
  registry.register(socket as unknown as WebSocket, session, USER, null);
  return { socket, session };
}
const announces = (socket: { send: ReturnType<typeof vi.fn> }): Array<{ announce_id: string }> =>
  socket.send.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((d) => d.type === 'announce').map((d) => d.payload);
const card = (id: string, extra: Partial<Announcement> = {}): Announcement =>
  ({ announce_id: id, kind: 'timer', title: 'Pasta', body: '', ring: true, expires_at: clock + 60_000, ...extra });

beforeEach(() => {
  clock = 1_000_000;
  registry = new DeviceSessions(events, { now: () => clock });
  journal = [];
  setJournalSink((line) => journal.push(line));
});

describe('announce delivery', () => {
  it('goes at once to a ready device, in contract key order', () => {
    const { socket } = device('session_ready_1');
    expect(registry.announce(USER, card('tm_000000001'))).toBe('queued');
    expect(socket.send.mock.calls[0]![0]).toMatch(/"payload":\{"announce_id":"tm_000000001","kind":"timer","title":"Pasta","body":"","ring":true,"expires_at":1060000\}/);
  });

  it('is held during a turn and delivered on the flush after playback_end', () => {
    const { socket, session } = device('session_busy_01', 'responding');
    registry.announce(USER, card('tm_000000002'));
    expect(announces(socket)).toEqual([]);
    expect(journal.join('\n')).toContain('"reason":"busy"');
    session.stage = 'ready';
    registry.flushPending(session);
    expect(announces(socket).map((a) => a.announce_id)).toEqual(['tm_000000002']);
    registry.flushPending(session);
    expect(announces(socket)).toHaveLength(1);
  });

  it('is held in DND and delivered when DND ends', () => {
    const { socket, session } = device('session_dnd_001');
    session.deviceState = { volume: 5, muted: false, mode: 'ptt', dnd: true };
    registry.announce(USER, card('tm_000000003'));
    expect(announces(socket)).toEqual([]);
    session.deviceState.dnd = false;
    registry.flushPending(session);
    expect(announces(socket)).toHaveLength(1);
  });

  it('drops a duplicate announce_id', () => {
    const { socket } = device('session_dup_001');
    registry.announce(USER, card('tm_000000004'));
    expect(registry.announce(USER, card('tm_000000004'))).toBe('duplicate');
    expect(announces(socket)).toHaveLength(1);
  });

  it('replays an unacked one once to a reconnecting device, and not after announce_ack', () => {
    const first = device('session_first_1');
    registry.announce(USER, card('tm_000000005'));
    registry.unregister(first.session);
    const again = device('session_again_1');
    registry.flushPending(again.session);
    registry.flushPending(again.session);
    expect(announces(again.socket)).toHaveLength(1);
    expect(registry.ackAnnouncement(USER, 'tm_000000005')).toBe(true);
    const third = device('session_third_1');
    registry.flushPending(third.session);
    expect(announces(third.socket)).toEqual([]);
  });

  it('expires: never replayed after expires_at, and refused when already past', () => {
    registry.announce(USER, card('tm_000000006'));
    clock += 61_000;
    const late = device('session_late_01');
    registry.flushPending(late.session);
    expect(announces(late.socket)).toEqual([]);
    expect(registry.announce(USER, card('tm_000000007', { expires_at: clock - 1 }))).toBe('expired');
    expect(journal.join('\n')).toContain('v2.announce_expired');
  });

  it('keeps at most ANNOUNCE_OUTBOX_CAP, dropping the oldest', () => {
    for (let i = 0; i < ANNOUNCE_OUTBOX_CAP + 2; i += 1) registry.announce(USER, card(`tm_cap_${String(i).padStart(4, '0')}`));
    const pending = registry.pendingAnnouncements(USER).map((a) => a.announce_id);
    expect(pending).toHaveLength(ANNOUNCE_OUTBOX_CAP);
    expect(pending[0]).toBe('tm_cap_0002');
    expect(journal.join('\n')).toContain('"reason":"outbox_full"');
  });

  it('hands a ring:false announcement with speech to the player, and never journals its text', () => {
    const { socket, session } = device('session_speak_1');
    const player = vi.fn(async () => { session.stage = 'responding'; });
    registry.setAnnouncementPlayer(player);
    registry.announce(USER, card('rm_000000008', { kind: 'reminder', ring: false, title: 'Call Zanzibar', body: 'Call Zanzibar', speech: 'Reminder: Call Zanzibar' }));
    registry.announce(USER, card('rm_000000009', { kind: 'notice', ring: false, title: 'Second' }));
    expect(player).toHaveBeenCalledTimes(1);
    expect(announces(socket).map((a) => a.announce_id)).toEqual(['rm_000000008']);
    expect(journal.join('\n')).not.toContain('Zanzibar');
  });
});
