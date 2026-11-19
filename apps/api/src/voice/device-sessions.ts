/**
 * Connected, paired device sessions by account and device id. Owns the
 * `active.changed` -> `active_conversation` push: sent at once to a `ready`
 * session; a busy one keeps only the latest and gets it from resetSession right
 * after `playback_end`. Nothing is ever sent mid-playback.
 */
import type { WebSocket } from 'ws';
import {
  announceDto,
  deviceControlDto,
  expressDto,
  messageId,
  sceneDto,
  titleForDevice,
  V2_VERSION,
  type ActiveConversationDto,
  type ActiveSpaceDto,
  type AnnouncePayload,
  type DeviceControlPatch,
  type DeviceSettingsState,
  type ScenePayload,
  type ServerControlDto,
  type SessionStage,
} from './protocol.ts';
import type { ExpressEmotion } from '@bob/ai';
import { socketHasCap } from './device-caps.ts';
import { getAccountEvents } from '../devices/pairing-service.ts';
import { type AccountEvent } from '../account/events-bus.ts';
import { moduleJournal } from '../platform/logger.ts';
import { traceSynchronousWorkflow } from '../platform/observability/workflow-diagnostics.ts';
import { withUser, type Db } from '../platform/db/db.ts';

const journal = moduleJournal('voice');

/**
 * Announcements. One in-memory outbox per account, bounded to
 * ANNOUNCE_OUTBOX_CAP (oldest dropped, journaled). An announcement is sent to
 * every registered session of the account that is `ready` and not in DND;
 * a busy (capturing/responding) or DND session is skipped and gets it on its
 * next flush (after playback_end, or when DND turns off). Each session gets an
 * announcement at most once; a new session (a reconnect) is replayed every
 * unacked, unexpired one. An announce_ack from any device removes it. The same
 * announce_id twice is dropped. Nothing is ever journaled but kind and counts:
 * title, body and speech are user text.
 */
export const ANNOUNCE_OUTBOX_CAP = 20;

/** How long a closed device socket waits before it reads as offline, so a
 *  quick reconnect (Wi-Fi blip, reboot) never flickers the Devices page. */
const PRESENCE_CLOSE_DEBOUNCE_MS = 500;

/** `v2.devices_connected` is written at most this often, and only when the count changed. */
const CONNECTED_JOURNAL_MIN_MS = 60_000;

/** An announcement plus, for ring:false, the text to speak after it (never journaled). */
export type Announcement = AnnouncePayload & { speech?: string };

/** Streams the spoken part of an announcement (turn.ts owns the audio path). */
type AnnouncementPlayer = (socket: WebSocket, session: SessionLike, announcement: Announcement) => Promise<void>;

type AnnounceOutcome = 'queued' | 'duplicate' | 'expired';

interface OutboxItem {
  announcement: Announcement;
  sentTo: Set<string>;
  /** Only this device gets it; unset rings the whole account. */
  deviceId?: string;
}

/** The `active_conversation` payload form; id and title are both null together. */
interface ActiveConversationPush {
  id: string | null;
  title: string | null;
}

interface SessionLike {
  id: string;
  stage: SessionStage;
  /** The device's last reported settings; DND holds announcements. */
  deviceState?: DeviceSettingsState;
  /** When device_control was last sent to this session. */
  settingsPushedAt?: number;
}

interface RegisteredDeviceSession {
  session: SessionLike;
  socket: WebSocket;
  /** The account the session acts as (device or legacy kind). */
  userId: string;
  /** Present only for device-kind sessions; legacy sessions have none. */
  deviceId: string | null;
}

/** The `active_space` payload form; id and name are both null together. */
interface ActiveSpacePush {
  id: string | null;
  name: string | null;
}

interface Entry extends RegisteredDeviceSession {
  pendingPush: ActiveConversationPush | null;
  /** Held `active_space` push, separate from the conversation slot so neither
   *  push can overwrite the other; latest wins within the slot. */
  pendingSpacePush: ActiveSpacePush | null;
}

export class DeviceSessions {
  private readonly byId = new Map<string, Entry>();
  private readonly byAccount = new Map<string, Set<string>>();
  private readonly byDevice = new Map<string, string>();
  private readonly accountUnsubscribers = new Map<string, () => void>();
  private readonly outboxes = new Map<string, Map<string, OutboxItem>>();
  /** Debounced offline announcements, by device id (see unregister). */
  private readonly offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Ids of every open device socket, paired or not (device-socket.ts tracks them). */
  private readonly openSockets = new Set<string>();
  private lastConnectedLine: { at: number; paired: number; unpaired: number } | null = null;
  private connectedTimer: ReturnType<typeof setTimeout> | null = null;
  private player: AnnouncementPlayer | null = null;
  private readonly now: () => number;
  /** How to reach the database, given by a caller that already has it: never
   *  imported here, since getDb is a process singleton the import boundary
   *  reserves for the composition roots. */
  private db: (() => Promise<Db>) | null = null;
  /** One push-delivery chain per account (serializes `chain` below). */
  private readonly deliveryChains = new Map<string, Promise<void>>();

  /** One account subscription per account; publish order is preserved.
   *  `publish` carries presence (device.changed); a bus without it has none. */
  constructor(
    private readonly events: {
      subscribe: (userId: string, fn: (event: AccountEvent) => void) => () => void;
      publish?: (userId: string, event: AccountEvent) => void;
    },
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** A socket was accepted: it counts as connected (unpaired until `register`). */
  trackSocket(session: SessionLike): void {
    this.openSockets.add(session.id);
    this.journalConnected();
  }

  /** The socket closed. Idempotent. */
  untrackSocket(session: SessionLike): void {
    if (this.openSockets.delete(session.id)) this.journalConnected();
  }

  /** Live count of open device sockets: paired (registered under an account) and the rest. Never negative. */
  connectedCounts(): { paired: number; unpaired: number } {
    let paired = 0;
    for (const id of this.byId.keys()) if (this.openSockets.has(id)) paired += 1;
    return { paired, unpaired: Math.max(0, this.openSockets.size - paired) };
  }

  /** One `v2.devices_connected` line when the count changed, at most one a minute (a change inside the window is written when it ends). */
  private journalConnected(): void {
    const { paired, unpaired } = this.connectedCounts();
    const last = this.lastConnectedLine;
    if (last !== null && last.paired === paired && last.unpaired === unpaired) return;
    const wait = last === null ? 0 : last.at + CONNECTED_JOURNAL_MIN_MS - this.now();
    if (wait <= 0) {
      if (this.connectedTimer !== null) clearTimeout(this.connectedTimer);
      this.connectedTimer = null;
      this.lastConnectedLine = { at: this.now(), paired, unpaired };
      journal('v2.devices_connected', { paired, unpaired });
      return;
    }
    if (this.connectedTimer !== null) return;
    this.connectedTimer = setTimeout(() => { this.connectedTimer = null; this.journalConnected(); }, wait);
    this.connectedTimer.unref?.();
  }

  /** Wires the audio path for ring:false announcements (server.ts, from turn.ts). */
  setAnnouncementPlayer(player: AnnouncementPlayer | null): void {
    this.player = player;
  }

  rememberDb(getDb: () => Promise<Db>): void {
    this.db = getDb;
  }

  /** Test seam: waits for every in-flight follower read to finish delivering. */
  async flushDeliveries(): Promise<void> {
    await Promise.all([...this.deliveryChains.values()]);
  }

  /** The live settings of a connected device (web reads them), or undefined. */
  deviceStateFor(deviceId: string): DeviceSettingsState | undefined {
    return this.forDevice(deviceId)?.session.deviceState;
  }

  /**
   * Pushes `device_control` now -- even mid-turn, so a reply already plays at
   * the new level. deviceId null targets every session of the account.
   * Returns how many sessions it was sent to (0 = no connected device).
   */
  sendDeviceControl(userId: string, deviceId: string | null, patch: DeviceControlPatch): number {
    const targets = this.targetsOf(userId, deviceId);
    let sent = 0;
    for (const target of targets) {
      if (this.pushDeviceControl(target.socket, target.session, patch)) sent += 1;
    }
    if (sent === 0) journal('v2.device_control_undelivered', { fields: Object.keys(patch).sort().join(',') });
    if (targets.length === 0) traceSynchronousWorkflow('device-control', { metadata: { reason: 'no_device' } }, (outcome) => outcome('skipped'));
    return sent;
  }

  /**
   * Pushes `express` (Bob's feeling) to the devices whose hello advertised the
   * `express` cap. Returns how many got it; the journal never carries text.
   */
  sendExpress(userId: string, deviceId: string | null, emotion: ExpressEmotion, seconds: number): number {
    const sessions = this.pushToCapable(userId, deviceId, 'express', () => expressDto(emotion, seconds));
    for (const id of sessions) journal('v2.express', { session: id, emotion, seconds });
    return sessions.length;
  }

  /** Pushes `scene` to the devices with the `scene` cap; the label is never journaled. */
  sendScene(userId: string, deviceId: string | null, scene: ScenePayload): number {
    const sessions = this.pushToCapable(userId, deviceId, 'scene', () => sceneDto(scene));
    for (const id of sessions) journal('v2.scene', { session: id, scene: scene.scene, seconds: scene.seconds });
    return sessions.length;
  }

  /** The sessions a push for `deviceId` reaches (null = every session of the account). */
  private targetsOf(userId: string, deviceId: string | null): RegisteredDeviceSession[] {
    return deviceId === null
      ? this.forAccount(userId)
      : [this.forDevice(deviceId)].filter((entry): entry is RegisteredDeviceSession => entry !== undefined && entry.userId === userId);
  }

  /** Whether a push to `deviceId` (null = any of the account's devices) would reach a session with `cap`. */
  hasCap(userId: string, deviceId: string | null, cap: string): boolean {
    return this.targetsOf(userId, deviceId).some((target) => target.socket.readyState === 1 && socketHasCap(target.socket, cap));
  }

  /** Sends to each target session whose hello has `cap`; returns the session ids sent to. */
  private pushToCapable(userId: string, deviceId: string | null, cap: string, build: () => ServerControlDto): string[] {
    const targets = this.targetsOf(userId, deviceId);
    const sent: string[] = [];
    for (const target of targets) {
      if (target.socket.readyState !== 1 || !socketHasCap(target.socket, cap)) continue;
      target.socket.send(JSON.stringify(build()));
      sent.push(target.session.id);
    }
    return sent;
  }

  /** Sends `device_control` to one socket and stamps the push time; false when
   *  the socket is not open or nothing in the patch is for it (wake_word goes
   *  only to a hello with cap 'wake_word'). Sent is not applied: only
   *  device_state confirms it. */
  pushDeviceControl(socket: WebSocket, session: SessionLike, fullPatch: DeviceControlPatch): boolean {
    return traceSynchronousWorkflow('device-control', {}, (outcome) => {
      const { wake_word: wakeWord, ...rest } = fullPatch;
      const patch: DeviceControlPatch = wakeWord !== undefined && socketHasCap(socket, 'wake_word') ? fullPatch : rest;
      if (socket.readyState !== 1 || Object.keys(patch).length === 0) { outcome('skipped'); return false; }
      socket.send(JSON.stringify(deviceControlDto(patch)));
      session.settingsPushedAt = this.now();
      journal('v2.device_control', { session: session.id, fields: Object.keys(patch).sort().join(',') });
      return true;
    });
  }

  /** Queues an announcement for the account and delivers it to every ready,
   *  non-DND session; the rest get it on their next flush or reconnect. */
  announce(userId: string, announcement: Announcement, deviceId?: string): AnnounceOutcome {
    return traceSynchronousWorkflow('device-announcement-queue', { metadata: { action: announcement.kind } }, (outcome) => {
      const result = this.queueAnnouncement(userId, announcement, deviceId);
      if (result !== 'queued') outcome('skipped');
      return result;
    });
  }

  private queueAnnouncement(userId: string, announcement: Announcement, deviceId?: string): AnnounceOutcome {
    this.pruneExpired(userId);
    if (announcement.expires_at <= this.now()) {
      journal('v2.announce_expired', { count: 1 });
      return 'expired';
    }
    let outbox = this.outboxes.get(userId);
    if (outbox === undefined) {
      outbox = new Map();
      this.outboxes.set(userId, outbox);
    }
    if (outbox.has(announcement.announce_id)) {
      journal('v2.announce_duplicate', { kind: announcement.kind });
      return 'duplicate';
    }
    while (outbox.size >= ANNOUNCE_OUTBOX_CAP) {
      const oldest = outbox.keys().next().value as string;
      outbox.delete(oldest);
      journal('v2.announce_dropped', { reason: 'outbox_full' });
    }
    outbox.set(announcement.announce_id, { announcement, sentTo: new Set(), ...(deviceId === undefined ? {} : { deviceId }) });
    journal('v2.announce_queued', { kind: announcement.kind, ring: announcement.ring, sessions: this.forAccount(userId).length });
    for (const entry of this.entriesFor(userId)) this.deliverAnnouncements(entry);
    return 'queued';
  }

  /** One announcement to one connected device of the account, on the
   *  same outbox path (busy and DND hold it, a reconnect replays it). */
  announceToDevice(userId: string, deviceId: string, announcement: Announcement): 'sent' | 'held' | 'no_device' {
    const target = this.forDevice(deviceId);
    if (target === undefined || target.userId !== userId) return traceSynchronousWorkflow('device-announcement-queue',
      { metadata: { action: announcement.kind, reason: 'no_device' } }, (outcome) => { outcome('skipped'); return 'no_device'; });
    this.announce(userId, announcement, deviceId);
    const item = this.outboxes.get(userId)?.get(announcement.announce_id);
    return item?.sentTo.has(target.session.id) === true ? 'sent' : 'held';
  }

  /** announce_ack from any device of the account ends the announcement. */
  ackAnnouncement(userId: string, announceId: string): boolean {
    const removed = this.outboxes.get(userId)?.delete(announceId) ?? false;
    if (this.outboxes.get(userId)?.size === 0) this.outboxes.delete(userId);
    return removed;
  }

  /** Unacked, unexpired announcements for the account, oldest first (tests, web). */
  pendingAnnouncements(userId: string): Announcement[] {
    this.pruneExpired(userId);
    return [...(this.outboxes.get(userId)?.values() ?? [])].map((item) => item.announcement);
  }

  private entriesFor(userId: string): Entry[] {
    return [...(this.byAccount.get(userId) ?? [])]
      .map((id) => this.byId.get(id))
      .filter((entry): entry is Entry => entry !== undefined);
  }

  private pruneExpired(userId: string): void {
    const outbox = this.outboxes.get(userId);
    if (outbox === undefined) return;
    let expired = 0;
    for (const [id, item] of outbox) {
      if (item.announcement.expires_at <= this.now()) {
        outbox.delete(id);
        expired += 1;
      }
    }
    if (expired > 0) journal('v2.announce_expired', { count: expired });
    if (outbox.size === 0) this.outboxes.delete(userId);
  }

  /** Registers a paired (device or legacy) session after its welcome. A device
   *  session announces itself online (device.changed) so an open Devices page
   *  re-reads its presence; a pending offline for the device is cancelled. */
  register(socket: WebSocket, session: SessionLike, userId: string, deviceId: string | null): void {
    this.remove(session);
    const entry: Entry = { session, socket, userId, deviceId, pendingPush: null, pendingSpacePush: null };
    this.byId.set(session.id, entry);
    let ids = this.byAccount.get(userId);
    if (ids === undefined) {
      ids = new Set();
      this.byAccount.set(userId, ids);
    }
    ids.add(session.id);
    if (deviceId !== null) this.byDevice.set(deviceId, session.id);
    this.ensureAccountSubscribed(userId);
    if (deviceId !== null) {
      this.cancelOffline(deviceId);
      this.publishPresence(userId, deviceId, session.id, 'online');
    }
  }

  /** Unregisters a session on socket close. Idempotent. A device left with no
   *  live session goes offline after PRESENCE_CLOSE_DEBOUNCE_MS, unless it
   *  reconnects first (a quick reconnect never reads as a disconnect). */
  unregister(session: SessionLike): void {
    const entry = this.remove(session);
    if (entry === undefined || entry.deviceId === null || this.byDevice.has(entry.deviceId)) return;
    const { userId, deviceId } = entry;
    this.cancelOffline(deviceId);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(deviceId);
      if (!this.byDevice.has(deviceId)) this.publishPresence(userId, deviceId, session.id, 'offline');
    }, PRESENCE_CLOSE_DEBOUNCE_MS);
    timer.unref?.();
    this.offlineTimers.set(deviceId, timer);
  }

  private cancelOffline(deviceId: string): void {
    const pending = this.offlineTimers.get(deviceId);
    if (pending !== undefined) clearTimeout(pending);
    this.offlineTimers.delete(deviceId);
  }

  /** device.changed for a presence change; the journal gets the state only.
   *  Never throws: the bus validates and can throw, and a throw here would
   *  crash the process from the offline timer or cut a welcome short. */
  private publishPresence(userId: string, deviceId: string, sessionId: string, state: 'online' | 'offline'): void {
    traceSynchronousWorkflow('device-presence', { detached: state === 'offline', userId, metadata: { state } }, (outcome) => {
      journal('v2.device_presence', { session: sessionId, state });
      try {
        this.events.publish?.(userId, { type: 'device.changed', device_id: deviceId });
      } catch {
        outcome('failed');
        journal('v2.device_presence_failed', { session: sessionId });
      }
    });
  }

  private remove(session: SessionLike): Entry | undefined {
    const entry = this.byId.get(session.id);
    if (entry === undefined) return undefined;
    this.byId.delete(session.id);
    const accountIds = this.byAccount.get(entry.userId);
    if (accountIds !== undefined) {
      accountIds.delete(session.id);
      if (accountIds.size === 0) {
        this.byAccount.delete(entry.userId);
        const unsubscribe = this.accountUnsubscribers.get(entry.userId);
        if (unsubscribe !== undefined) {
          unsubscribe();
          this.accountUnsubscribers.delete(entry.userId);
        }
      }
    }
    if (entry.deviceId !== null && this.byDevice.get(entry.deviceId) === session.id) {
      this.byDevice.delete(entry.deviceId);
    }
    return entry;
  }

  forAccount(userId: string): RegisteredDeviceSession[] {
    const ids = this.byAccount.get(userId);
    if (ids === undefined) return [];
    const result: RegisteredDeviceSession[] = [];
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (entry !== undefined) result.push(entry);
    }
    return result;
  }

  forDevice(deviceId: string): RegisteredDeviceSession | undefined {
    const sessionId = this.byDevice.get(deviceId);
    if (sessionId === undefined) return undefined;
    return this.byId.get(sessionId);
  }

  /** Closes the live socket of a device with the given WS close code and reason
   *  (the revoke path closes with 4003; the device does not erase on the close). */
  closeDevice(deviceId: string, code: number, reason?: string): void {
    traceSynchronousWorkflow('device-revoke', {}, (outcome) => {
      const entry = this.byId.get(this.byDevice.get(deviceId) ?? '');
      if (entry === undefined) { outcome('skipped'); return; }
      try {
        entry.socket.close(code, reason);
      } catch {
        outcome('failed');
        // Socket already gone; the unregister on close has run.
      }
    });
  }

  /** Flushes a held push once the session is ready (called from resetSession,
   *  which runs right after playback_end). No-op for unregistered or non-ready
   *  sessions. */
  flushPending(session: SessionLike): void {
    const entry = this.byId.get(session.id);
    if (entry === undefined) return;
    if (entry.session.stage !== 'ready') return;
    const push = entry.pendingPush;
    const spacePush = entry.pendingSpacePush;
    entry.pendingPush = null;
    entry.pendingSpacePush = null;
    if (push !== null) this.sendActiveConversation(entry, push);
    if (spacePush !== null) this.sendActiveSpace(entry, spacePush);
    this.deliverAnnouncements(entry);
  }

  /** Sends the session every announcement it has not had yet, oldest first --
   *  unless it is busy or in DND, which hold them. A ring:false announcement
   *  with speech hands the session to the player (which makes it busy); the
   *  rest follow on the flush after that playback_end. */
  private deliverAnnouncements(entry: Entry): void {
    if (entry.socket.readyState !== 1) return;
    this.pruneExpired(entry.userId);
    const outbox = this.outboxes.get(entry.userId);
    if (outbox === undefined) return;
    const pending = [...outbox.values()].filter((item) =>
      !item.sentTo.has(entry.session.id) && (item.deviceId === undefined || item.deviceId === entry.deviceId));
    if (pending.length === 0) return;
    if (entry.session.stage !== 'ready' || entry.session.deviceState?.dnd === true) {
      const reason = entry.session.stage !== 'ready' ? 'busy' : 'dnd';
      traceSynchronousWorkflow('device-announcement-deliver', { metadata: { reason, state: 'held' } }, (outcome) => outcome('skipped'));
      journal('v2.announce_held', { session: entry.session.id, reason, count: pending.length });
      return;
    }
    for (const item of pending) {
      item.sentTo.add(entry.session.id);
      traceSynchronousWorkflow('device-announcement-deliver', { metadata: { action: item.announcement.kind, state: 'sent' } },
        () => entry.socket.send(JSON.stringify(announceDto(item.announcement))));
      journal('v2.announce_sent', { session: entry.session.id, kind: item.announcement.kind });
      const speech = item.announcement.speech;
      if (!item.announcement.ring && speech !== undefined && speech !== '' && this.player !== null) {
        void this.player(entry.socket, entry.session, item.announcement).catch(() => undefined);
        // The player marks the session busy synchronously when it speaks; a
        // PCM device (card and chime only) stays ready and gets the rest now.
        if (entry.session.stage !== 'ready') return;
      }
    }
  }

  /** Test seam: unregisters every session and drops every account subscription. */
  clear(): void {
    for (const unsubscribe of this.accountUnsubscribers.values()) unsubscribe();
    this.accountUnsubscribers.clear();
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
    if (this.connectedTimer !== null) clearTimeout(this.connectedTimer);
    this.connectedTimer = null;
    this.openSockets.clear();
    this.lastConnectedLine = null;
    this.outboxes.clear();
    this.byId.clear();
    this.byAccount.clear();
    this.byDevice.clear();
    this.deliveryChains.clear();
  }

  /** Serializes deferred follower reads so two broad pushes can't resolve
   *  and deliver to followers out of order. */
  private chain(userId: string, task: () => Promise<void>): void {
    const previous = this.deliveryChains.get(userId) ?? Promise.resolve();
    // A failed read is contained so the next queued delivery still runs; the
    // journal gets a constant event only (never the error, ids, titles or SQL).
    this.deliveryChains.set(userId, previous.then(task).catch(() => { journal('v2.device_follower_read_failed', {}); }));
  }

  private ensureAccountSubscribed(userId: string): void {
    if (this.accountUnsubscribers.has(userId)) return;
    const unsubscribe = this.events.subscribe(userId, (event: AccountEvent) => {
      if (event.type === 'active.changed') {
        this.pushActiveChanged(userId, event.conversation_id, event.title, event.device_id, event.changed_at);
      } else if (event.type === 'active_space.changed') {
        this.pushActiveSpaceChanged(userId, { id: event.space_id, name: event.name }, event.device_id, event.changed_at);
      }
    });
    this.accountUnsubscribers.set(userId, unsubscribe);
  }

  /** The tagged device's own session, deliverable with no DB
   *  read (no deviceId is every session instead). `getDb` is non-null only
   *  when a second session is connected -- only then can a broad move also
   *  reach followers, and that check needs rows read fresh, so it is left
   *  for the caller to run asynchronously. */
  private syncTargets(userId: string, deviceId: string | undefined): { now: Set<string>; getDb: (() => Promise<Db>) | null } {
    const all = this.byAccount.get(userId);
    if (deviceId === undefined) return { now: all ?? new Set(), getDb: null };
    const taggedSessionId = this.byDevice.get(deviceId);
    const now = taggedSessionId !== undefined && this.byId.get(taggedSessionId)?.userId === userId
      ? new Set([taggedSessionId]) : new Set<string>();
    return { now, getDb: all !== undefined && all.size > 1 ? this.db : null };
  }

  /** The extra session ids a broad move also reaches, beyond the tagged
   *  device: every OTHER connected device with no pointer of its own, but
   *  only when `changedAt` also lands on the ACCOUNT's own pointer stamp
   *  (read fresh -- the same write moved both when that happens); a
   *  device-only change reaches nobody further, and a device WITH its own
   *  pointer never joins. */
  private async followerSessionIds(
    getDb: () => Promise<Db>, userId: string, kind: 'conversation' | 'space', changedAt: number, already: Set<string>,
  ): Promise<Set<string>> {
    const db = await getDb();
    if ((await accountChangedAt(db, userId, kind)) !== changedAt) return new Set();
    const withoutOwn = await deviceIdsWithoutOwnPointer(db, userId, kind);
    const result = new Set<string>();
    for (const sessionId of this.byAccount.get(userId) ?? []) {
      if (already.has(sessionId)) continue;
      const entryDeviceId = this.byId.get(sessionId)?.deviceId;
      if (entryDeviceId !== null && entryDeviceId !== undefined && withoutOwn.has(entryDeviceId)) result.add(sessionId);
    }
    return result;
  }

  /** active_space.changed → `active_space`: sent now to a ready session, held
   *  (latest wins) for a capturing/responding one and flushed after playback_end. */
  private pushActiveSpaceChanged(userId: string, push: ActiveSpacePush, deviceId: string | undefined, changedAt: number): void {
    const { now, getDb } = this.syncTargets(userId, deviceId);
    for (const sessionId of now) this.deliverActiveSpace(sessionId, push);
    if (getDb === null) return;
    this.chain(userId, async () => {
      for (const sessionId of await this.followerSessionIds(getDb, userId, 'space', changedAt, now)) this.deliverActiveSpace(sessionId, push);
    });
  }

  private deliverActiveSpace(sessionId: string, push: ActiveSpacePush): void {
    const entry = this.byId.get(sessionId);
    if (entry === undefined) return;
    if (entry.session.stage === 'ready') this.sendActiveSpace(entry, push);
    else entry.pendingSpacePush = push;
  }

  private sendActiveSpace(entry: Entry, push: ActiveSpacePush): void {
    if (entry.socket.readyState !== 1) return;
    const dto: ActiveSpaceDto = {
      v: V2_VERSION,
      type: 'active_space',
      id: messageId('aspc'),
      payload: { id: push.id, name: push.name },
    };
    traceSynchronousWorkflow('device-active-space', {}, () => entry.socket.send(JSON.stringify(dto)));
  }

  private pushActiveChanged(
    userId: string, conversationId: string | null, title: string | null, deviceId: string | undefined, changedAt: number,
  ): void {
    const push: ActiveConversationPush = { id: conversationId, title };
    const { now, getDb } = this.syncTargets(userId, deviceId);
    for (const sessionId of now) this.deliverActiveConversation(sessionId, push);
    if (getDb === null) return;
    this.chain(userId, async () => {
      for (const sessionId of await this.followerSessionIds(getDb, userId, 'conversation', changedAt, now)) this.deliverActiveConversation(sessionId, push);
    });
  }

  private deliverActiveConversation(sessionId: string, push: ActiveConversationPush): void {
    const entry = this.byId.get(sessionId);
    if (entry === undefined) return;
    // Mid-turn: keep only the latest pending push; flush after playback_end.
    if (entry.session.stage === 'ready') this.sendActiveConversation(entry, push);
    else entry.pendingPush = push;
  }

  private sendActiveConversation(entry: Entry, push: ActiveConversationPush): void {
    if (entry.socket.readyState !== 1) return;
    const dto: ActiveConversationDto = {
      v: V2_VERSION,
      type: 'active_conversation',
      id: messageId('actv'),
      payload: { id: push.id, title: titleForDevice(push.title) },
    };
    traceSynchronousWorkflow('device-active-conversation', {}, () => entry.socket.send(JSON.stringify(dto)));
  }
}

/** The account's current pointer stamp (ms), or null with no
 *  row -- a write that also moved the account pointer shares this ONE stamp
 *  with the device row it tagged; a device-only write leaves it alone. */
async function accountChangedAt(db: Db, userId: string, kind: 'conversation' | 'space'): Promise<number | null> {
  const rows = await withUser(db, userId, (tx) => tx.query<{ changedAt: unknown }>(
    kind === 'conversation'
      ? 'SELECT floor(extract(epoch from conversation_changed_at) * 1000)::bigint AS "changedAt" FROM bob.user_state WHERE user_id = $1'
      : 'SELECT floor(extract(epoch from space_changed_at) * 1000)::bigint AS "changedAt" FROM bob.user_state WHERE user_id = $1',
    [userId],
  ));
  const value = rows[0]?.changedAt;
  return value === null || value === undefined ? null : Number(value);
}

/** Device ids with no own pointer of `kind` (a null surface column) --
 *  they follow the account pointer, so a broad move must reach them too. */
async function deviceIdsWithoutOwnPointer(db: Db, userId: string, kind: 'conversation' | 'space'): Promise<Set<string>> {
  const rows = await withUser(db, userId, (tx) => tx.query<{ id: string }>(
    kind === 'conversation'
      ? 'SELECT id FROM bob.devices WHERE user_id = $1 AND conversation_surface IS NULL'
      : 'SELECT id FROM bob.devices WHERE user_id = $1 AND space_surface IS NULL',
    [userId],
  ));
  return new Set(rows.map((row) => row.id));
}

const shared = new DeviceSessions(getAccountEvents());

/** The process-wide device-session registry; session.ts registers into it. */
export function getDeviceSessions(): DeviceSessions {
  return shared;
}
