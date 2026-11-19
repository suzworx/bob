/**
 * Workflow: rings fired timers and alarms on the account's devices, and runs the timer scheduler as a server module.
 * Trigger: the timer scheduler's onFire (a timer or alarm comes due), its afterFire, and the server's module start and stop (api-modules.ts).
 * Steps: 1. Start the timer scheduler on the store (startDeviceScheduler). 2. On each fire, ring the timer on every
 *   connected device of its account (announceTimer). 3. After a fire, push the timers state to the account's devices
 *   (pushTimersState). 4. Point the timer tools' reschedule at the scheduler. 5. On stop, stop the scheduler and clear reschedule.
 * Outcome: a fired timer rings its account's devices and is replayed to a busy or offline device until acked or expired.
 *   A store that cannot be reached is journaled and the server keeps running, with timers stored but unannounced until the next start.
 * Journal: v2.timer_scheduler_failed (this workflow, start failure); v2.timer_fired is emitted by timers/scheduler.ts.
 *   No trace names of its own. Label text is user content: sent to the devices, never journaled.
 */
/**
 * The timer scheduler as a server module: fires due timers
 * and alarms, and rings them on the account's devices. Started once the server
 * listens; it stops beside the other background work, inside the same 1 s
 * force-exit bound (shutdown.ts).
 */
import type { ApiModule } from '../api-module.ts';
import type { AppDeps } from '../app-deps.ts';
import { pushTimersState } from '../voice/device-tools.ts';
import { startTimerScheduler, type TimerScheduler } from '../timers/scheduler.ts';
import { type Timer } from '../timers/store.ts';
import { moduleJournal } from '../platform/logger.ts';
import { ANNOUNCE_TITLE_MAX } from '../devices/settings.ts';

const journal = moduleJournal('timers');

/** How long a timer or alarm ring is replayed to a device that was offline or busy. */
const TIMER_ANNOUNCE_TTL_MS = 15 * 60 * 1000;

/**
 * The timer scheduler's onFire: a fired timer or alarm rings on
 * every connected device of its account (ring:true, no audio follows), held
 * while a device is busy or in DND and replayed on reconnect until acked or
 * TIMER_ANNOUNCE_TTL_MS passes. The announce_id derives from the timer id, so
 * a double fire is deduped. The label is user text: sent, never journaled.
 */
export function announceTimer(deps: Pick<AppDeps, 'deviceSessions'>, timer: Timer, now: number = Date.now()): void {
  deps.deviceSessions.announce(timer.userId, {
    announce_id: `tm_${timer.id}`,
    kind: timer.kind,
    title: (timer.label ?? 'Timer').slice(0, ANNOUNCE_TITLE_MAX),
    body: '',
    ring: true,
    expires_at: now + TIMER_ANNOUNCE_TTL_MS,
  });
}

/**
 * Starts the timer scheduler on the store, ringing fired timers on the
 * account's devices (announceTimer), and points the timer tools' onChange at
 * it. A store that cannot be reached is journaled and leaves timers stored
 * but unannounced until the next start: it never stops the server.
 */
export async function startDeviceScheduler(deps: AppDeps): Promise<TimerScheduler | null> {
  try {
    const scheduler = startTimerScheduler({
      db: await deps.getDb(),
      onFire: (timer) => announceTimer(deps, timer),
      afterFire: (userIds) => pushTimersState({ registry: deps.deviceSessions, getDb: deps.getDb }, userIds),
    });
    deps.timerScheduler.reschedule = scheduler.reschedule;
    return scheduler;
  } catch (error) {
    journal('v2.timer_scheduler_failed', { error: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

export const timerSchedulerModule: ApiModule = {
  name: 'timer-scheduler',
  async start(deps) {
    const scheduler = await startDeviceScheduler(deps);
    return async (): Promise<void> => {
      scheduler?.stop();
      deps.timerScheduler.reschedule = null;
    };
  },
};
