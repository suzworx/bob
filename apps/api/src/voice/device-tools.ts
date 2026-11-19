/**
 * Device tools for one account: each call pushes `device_control` at once,
 * mid-turn and before playback_start, so the reply already plays at the new
 * level. No device connected is a spoken failure, never a silent success.
 * Also the timer tools' onChange hook, which re-arms the scheduler and pushes
 * timers_state.
 */
import type { WebSocket } from 'ws';
import { type DeviceCallbacks } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { timersStateDto, type DeviceControlPatch, type DeviceSettingsState, type TimersStateDto } from './protocol.ts';
import type { Db } from '../platform/db/db.ts';
import { DEFAULT_DEVICE_SETTINGS } from '../devices/settings-store.ts';
import { listPendingTimers } from '../timers/store.ts';
import type { DeviceSessions } from './device-sessions.ts';
import { traceWorkflow, type SetWorkflowOutcome } from '../platform/observability/workflow-diagnostics.ts';

const journal = moduleJournal('voice');

type DeviceToolTarget = {
  userId: string;
  /** The device to drive; null drives every connected session of the account. */
  deviceId: string | null;
  /** The paired name of the device being driven, for "<name> is not connected". */
  deviceName?: string;
  /** The device's last known settings, for relative changes. */
  state: () => DeviceSettingsState | undefined;
  /** Records the applied patch (the turn's session), so a second call compounds. */
  apply?: (patch: DeviceControlPatch) => void;
  registry: DeviceSessions;
};

function clampVolume(volume: number): number {
  return Math.min(10, Math.max(0, Math.round(volume)));
}

/** The account's own connected devices (never a legacy, deviceId-less
 *  session); used to tell a relative volume step apart per device and to
 *  pluralize "your Cardputer(s) is/are not connected". */
function connectedDevicesOf(registry: DeviceSessions, userId: string): ReturnType<DeviceSessions['forAccount']> {
  return registry.forAccount(userId).filter((entry) => entry.deviceId !== null);
}

/**
 * A relative step from web chat with more than one connected device moves
 * each device from its OWN last-known volume, rather than broadcasting one
 * level computed from the first device. Null when this does not apply.
 */
function perDeviceVolumeStep(
  target: DeviceToolTarget,
  push: (patch: DeviceControlPatch, deviceId?: string | null) => void,
  delta: number,
  mute: boolean | undefined,
): { volume: number; muted: boolean } | null {
  if (target.deviceId !== null) return null;
  const sessions = connectedDevicesOf(target.registry, target.userId);
  if (sessions.length <= 1) return null;
  const muted = mute ?? false;
  let first: { volume: number; muted: boolean } | null = null;
  for (const entry of sessions) {
    const base = entry.session.deviceState ?? DEFAULT_DEVICE_SETTINGS;
    const volume = clampVolume(base.volume + delta);
    push({ volume, muted }, entry.deviceId);
    first ??= { volume, muted };
  }
  return first;
}

export function bindDeviceTools(target: DeviceToolTarget): DeviceCallbacks {
  const registry = target.registry;
  const push = (patch: DeviceControlPatch, deviceId: string | null = target.deviceId): void => {
    if (registry.sendDeviceControl(target.userId, deviceId, patch) === 0) {
      const many = target.deviceId === null && connectedDevicesOf(registry, target.userId).length > 1;
      const named = target.deviceId !== null ? target.deviceName : undefined;
      throw new Error(named !== undefined ? `${named} is not connected` : many ? 'your devices are not connected' : 'your device is not connected');
    }
    target.apply?.(patch);
  };
  return {
    async setVolume(input) {
      if (input.delta !== undefined) {
        const perDevice = perDeviceVolumeStep(target, push, input.delta, input.mute);
        if (perDevice !== null) return perDevice;
      }
      const current = target.state() ?? DEFAULT_DEVICE_SETTINGS;
      let volume = current.volume;
      if (input.level !== undefined) volume = input.level;
      if (input.delta !== undefined) volume += input.delta;
      volume = clampVolume(volume);
      // Choosing a level unmutes, as a hardware volume key does.
      const levelChanged = input.level !== undefined || input.delta !== undefined;
      const muted = input.mute ?? (levelChanged ? false : current.muted);
      push({ volume, muted });
      return { volume, muted };
    },
    async setMode(input) {
      push({ mode: input.mode });
      return { mode: input.mode };
    },
    async express(input) {
      if (registry.sendExpress(target.userId, target.deviceId, input.emotion, input.seconds) === 0) {
        throw new Error('your device cannot show feelings yet');
      }
    },
  };
}

/** The running timer scheduler's reschedule hook: null until the composition
 *  root starts the scheduler, and again once it stops. */
export type TimerSchedulerRef = { reschedule: (() => Promise<void>) | null };

export type TimersChangedDeps = TimersStateDeps & { scheduler: TimerSchedulerRef };

/** The timer tools' onChange: re-arms the scheduler when one is running, then
 *  pushes timers_state to the changed account (every remembered account when
 *  the caller does not say which). */
export function timersChanged(deps: TimersChangedDeps, userId?: string): Promise<void> {
  return (deps.scheduler.reschedule?.() ?? Promise.resolve()).then(() => pushTimersState(deps, userId === undefined ? undefined : [userId]));
}

// Every account that had a welcome is remembered with the signature of its
// last sent list; a change is pushed only when that signature moved. An
// account with no connected session is forgotten.

export type TimersStateDeps = {
  registry: DeviceSessions;
  getDb: () => Promise<Db>;
  now?: () => number;
};

const timersSignatures = new Map<string, string>();
let timersPushChain: Promise<void> = Promise.resolve();

async function loadTimersState(userId: string, deps: TimersStateDeps): Promise<{ dto: TimersStateDto; signature: string }> {
  const db = await deps.getDb();
  const pending = await listPendingTimers(db, userId, (deps.now ?? Date.now)());
  const dto = timersStateDto(pending);
  const shown = new Set(dto.payload.timers.map((timer) => timer.id));
  // fires_at, not fires_in_ms: the remaining time moves every read, the list does not.
  const signature = JSON.stringify(pending.filter((timer) => shown.has(timer.id))
    .map((timer) => [timer.id, timer.kind, timer.label, timer.firesAt]));
  return { dto, signature };
}

/** After welcome: sends the account's timers and adds it to the push set. The
 *  firmware clears its list at every welcome, so an empty list is not sent.
 *  It runs in the push queue, so a change made while this read is out is
 *  pushed after it instead of being skipped or matched against a stale list. */
export function sendTimersStateOnWelcome(
  socket: WebSocket, sessionId: string, userId: string, deps: TimersStateDeps,
): Promise<void> {
  const run = async (outcome: SetWorkflowOutcome): Promise<void> => {
    try {
      const { dto, signature } = await loadTimersState(userId, deps);
      timersSignatures.set(userId, signature);
      if (dto.payload.timers.length === 0 || socket.readyState !== 1) { outcome('skipped'); return; }
      socket.send(JSON.stringify(dto));
      journal('v2.timers_state', { session: sessionId, reason: 'welcome', count: dto.payload.timers.length });
    } catch (error) {
      outcome('failed');
      journal('v2.timers_state_failed', { reason: 'welcome', error: error instanceof Error ? error.name : 'unknown' });
    }
  };
  timersPushChain = timersPushChain.then(() => traceWorkflow('device-timers-state', { metadata: { reason: 'welcome' } }, run));
  return timersPushChain;
}

/** Re-reads the named remembered accounts (every one when `userIds` is
 *  omitted) and pushes timers_state where it changed. Runs are serialized;
 *  never throws. */
export function pushTimersState(deps: TimersStateDeps, userIds?: readonly string[]): Promise<void> {
  const registry = deps.registry;
  const run = async (outcome: SetWorkflowOutcome): Promise<void> => {
    const targets = userIds === undefined
      ? [...timersSignatures.keys()]
      : [...new Set(userIds)].filter((userId) => timersSignatures.has(userId));
    for (const userId of targets) {
      const sessions = registry.forAccount(userId).filter((entry) => entry.socket.readyState === 1);
      if (sessions.length === 0) {
        timersSignatures.delete(userId);
        continue;
      }
      try {
        const { dto, signature } = await loadTimersState(userId, deps);
        if (signature === timersSignatures.get(userId)) continue;
        timersSignatures.set(userId, signature);
        const text = JSON.stringify(dto);
        for (const entry of sessions) entry.socket.send(text);
        journal('v2.timers_state', { reason: 'changed', count: dto.payload.timers.length, sessions: sessions.length });
      } catch (error) {
        outcome('failed');
        journal('v2.timers_state_failed', { reason: 'changed', error: error instanceof Error ? error.name : 'unknown' });
      }
    }
  };
  timersPushChain = timersPushChain.then(() => traceWorkflow('device-timers-state', { metadata: { reason: 'changed' } }, run));
  return timersPushChain;
}

/** Test seam: resolves once every queued welcome send and push has run. */
export function timersStateSettled(): Promise<void> {
  return timersPushChain;
}

/** Test seam: forgets every remembered account. */
export function resetTimersState(): void {
  timersSignatures.clear();
}
