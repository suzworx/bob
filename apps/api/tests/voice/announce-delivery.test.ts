// #319/#320/#321 wiring: a fired timer rings a connected device, a due reminder
// is announced AND still reaches the inbox, announce_ack clears it, and a
// ring:false announcement is spoken as playback "ann_<id>" on MP3 devices only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOB_TTS_VOICE } from '@bob/ai';
import type { WebSocket } from 'ws';

vi.mock('../../src/voice/audio/stt-tts.ts', () => ({
  assemblePcm16: (chunks: Buffer[]): Buffer => Buffer.concat(chunks),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: () => false,
  transcribePcm: vi.fn(),
  synthesizePcm: vi.fn(),
  synthesizeMp3: vi.fn(async () => ({ mp3: Buffer.alloc(2048) })),
  downlinkFrames: vi.fn(() => []),
  downlinkMp3Frames: vi.fn(() => [Buffer.alloc(64), Buffer.alloc(64)]),
}));

import { synthesizeMp3 } from '../../src/voice/audio/stt-tts.ts';
import { announceTimer } from '../../src/workflows/workflow-timer-ring.ts';
import { runAnnouncement } from '../../src/voice/turn/announce.ts';
import { createSession, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import { getDeviceSessions } from '../../src/voice/device-sessions.ts';
import { startTimerScheduler } from '../../src/timers/scheduler.ts';
import { createReminderFanout } from '../../src/workflows/workflow-reminder-fire.ts';
import { MP3_16K_MONO_FORMAT, V2_VERSION, type ClientControlDto } from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { closeDb, setSharedDb, type Db } from '../../src/platform/db/db.ts';
import { createTimer } from '../../src/timers/store.ts';
import { listNotifications } from '../../src/notifications/store.ts';
import { createReminder, setRecipients } from '../../src/reminders/store.ts';
import { createSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
type Fake = { readyState: number; send: ReturnType<typeof vi.fn> };
let pg: TestDb;
let db: Db;
let journal: string[];

function connect(userId: string, formatId: 1 | 2 = MP3_16K_MONO_FORMAT): { socket: Fake; session: DeviceSession } {
  const socket: Fake = { readyState: 1, send: vi.fn() };
  const session = createSession({ kind: 'legacy', userId } as never);
  session.stage = 'ready';
  session.formatId = formatId;
  getDeviceSessions().register(socket as unknown as WebSocket, session, userId, null);
  return { socket, session };
}
const controls = (socket: Fake): Array<{ type: string; turn_ref?: string; payload: Record<string, unknown> }> =>
  socket.send.mock.calls.filter((c) => typeof c[0] === 'string').map((c) => JSON.parse(c[0] as string));

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  setSharedDb(Promise.resolve(db));
});
beforeEach(() => {
  journal = [];
  setJournalSink((line) => journal.push(line));
  getDeviceSessions().clear();
  getDeviceSessions().setAnnouncementPlayer((socket, session, a) => runAnnouncement(appDeps.turn, socket, session as DeviceSession, a));
});
afterEach(() => {
  setJournalSink(null);
  getDeviceSessions().setAnnouncementPlayer(null);
});
afterAll(async () => {
  getDeviceSessions().clear();
  await closeDb().catch(() => undefined);
  await closeTestDb(pg).catch(() => undefined);
});

describe('timer fire -> announce', () => {
  it('the scheduler rings the account\'s connected device with the label, once', async () => {
    const { userId } = await addAccount(pg);
    const { socket } = connect(userId);
    const timer = await createTimer(db, userId, { durationMs: 1_000, label: 'Pasta', now: Date.now() - 5_000 });
    const scheduler = startTimerScheduler({ db, onFire: (fired) => announceTimer(appDeps, fired), afterFire: () => undefined });
    await scheduler.reschedule();
    scheduler.stop();
    const rings = controls(socket).filter((dto) => dto.type === 'announce');
    expect(rings).toHaveLength(1);
    expect(rings[0]!.payload).toMatchObject({ announce_id: `tm_${timer.id}`, kind: 'timer', title: 'Pasta', body: '', ring: true });
    expect(synthesizeMp3).not.toHaveBeenCalled();
    expect(journal.join('\n')).not.toContain('Pasta');
  });
});

describe('reminder due -> announce + inbox', () => {
  it('announces with speech on the recipient\'s device and still writes the inbox item', async () => {
    const owner = await addAccount(pg);
    const spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Home' })).id;
    const reminder = await createReminder(db, owner.userId, spaceId, {
      title: 'water the quokkas', due: { kind: 'instant', at: Date.now() - 60_000, zone: 'UTC' },
    });
    await setRecipients(db, owner.userId, reminder.id, [owner.userId]);
    const { socket, session } = connect(owner.userId);
    const enqueued = await createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db }).tick();
    expect(enqueued).toBeGreaterThanOrEqual(1);
    const inbox = await listNotifications(db, owner.userId, { limit: 50 });
    expect(inbox.some((n) => n.resourceId === reminder.id)).toBe(true);
    await session.turnDone;
    const sent = controls(socket);
    expect(sent[0]).toMatchObject({ type: 'announce', payload: { kind: 'reminder', title: 'water the quokkas', ring: false } });
    expect(sent.map((dto) => dto.type)).toEqual(['announce', 'playback_start', 'playback_end']);
    expect(sent[1]!.turn_ref).toBe(`ann_${sent[0]!.payload.announce_id as string}`);
    expect(synthesizeMp3).toHaveBeenCalledWith('Reminder: water the quokkas', undefined, BOB_TTS_VOICE);
    expect(session.stage).toBe('ready');
    expect(journal.join('\n')).not.toContain('quokkas');
  });

  it('an announce failure never costs the inbox item', async () => {
    const owner = await addAccount(pg);
    const spaceId = (await createSpace(db, owner.userId, { kind: 'group', name: 'Home' })).id;
    const reminder = await createReminder(db, owner.userId, spaceId, {
      title: 'feed the cat', due: { kind: 'instant', at: Date.now() - 60_000, zone: 'UTC' },
    });
    await setRecipients(db, owner.userId, reminder.id, [owner.userId]);
    await createReminderFanout({ db, announce: () => { throw new Error('registry down'); } }).tick();
    expect((await listNotifications(db, owner.userId, { limit: 50 })).some((n) => n.resourceId === reminder.id)).toBe(true);
    expect(journal.join('\n')).toContain('"announce_failed":1');
  });
});

describe('announce_ack and the player', () => {
  it('announce_ack clears the announcement for the account', async () => {
    const { userId } = await addAccount(pg);
    const { socket, session } = connect(userId);
    getDeviceSessions().announce(userId, { announce_id: 'tm_ack_000001', kind: 'alarm', title: 'Wake', body: '', ring: true, expires_at: Date.now() + 60_000 });
    const ack = { v: V2_VERSION, type: 'announce_ack', id: 'test_ctrl_000001', payload: { announce_id: 'tm_ack_000001', action: 'dismissed' } };
    await handleControl(appDeps, socket as unknown as WebSocket, session, ack as unknown as ClientControlDto, vi.fn());
    expect(getDeviceSessions().pendingAnnouncements(userId)).toEqual([]);
    expect(journal.join('\n')).toContain('"action":"dismissed","known":true');
  });

  it('a missed ring (#389) acks as missed: cleared, journaled with the action and never the label', async () => {
    const { userId } = await addAccount(pg);
    const { socket, session } = connect(userId);
    getDeviceSessions().announce(userId, { announce_id: 'tm_miss_000001', kind: 'timer', title: 'Pasta', body: '', ring: true, expires_at: Date.now() + 60_000 });
    const ack = { v: V2_VERSION, type: 'announce_ack', id: 'test_ctrl_000001', payload: { announce_id: 'tm_miss_000001', action: 'missed' } };
    await handleControl(appDeps, socket as unknown as WebSocket, session, ack as unknown as ClientControlDto, vi.fn());
    expect(getDeviceSessions().pendingAnnouncements(userId)).toEqual([]);
    const acked = journal.filter((line) => line.includes('"v2.announce_acked"'));
    expect(acked).toHaveLength(1);
    expect(acked[0]).toContain('"action":"missed","known":true');
    expect(acked[0]).not.toContain('Pasta');
  });

  it('a PCM device gets the card and chime only, no playback', async () => {
    const { userId } = await addAccount(pg);
    const { socket, session } = connect(userId, 1);
    getDeviceSessions().announce(userId, {
      announce_id: 'nt_pcm_000001', kind: 'notice', title: 'Hi', body: '', ring: false, expires_at: Date.now() + 60_000, speech: 'Hi there',
    });
    expect(controls(socket).map((dto) => dto.type)).toEqual(['announce']);
    expect(session.stage).toBe('ready');
  });
});
