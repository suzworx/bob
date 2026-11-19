/** Timer scheduler (issue #320): fires due timers and alarms. Keeps ONE timeout
 *  armed for the earliest pending timer across accounts, re-armed on start and
 *  whenever reschedule() is called (after a create or cancel). On start it
 *  loads the pending rows, so it survives a restart and fires overdue ones at
 *  once. Each timer is marked fired in its own transaction (a conditional
 *  pending -> fired update) BEFORE onFire runs, so two schedulers racing on one
 *  database fire it exactly once. Runs are serialized; a failed run is retried
 *  after RETRY_MS. Pass the RAW Db from getDb(). The journal line carries the
 *  kind only -- never a label, id or account. onFire is the wiring unit's hook
 *  (the device announcement); its errors are swallowed. After a pass that fired
 *  anything, afterFire runs once with the fired timers' account ids (the composition root
 *  pushes timers_state to those accounts' devices, #457, so a rung timer leaves
 *  the Ready countdown); its errors are swallowed. */
import { moduleJournal } from '../platform/logger.ts';
import type { Db } from '../platform/db/db.ts';
import { jobCorrelations } from '../reminders/origin-conversation.ts';
import { duePending, markTimerFired, nextPendingFireAt, type Timer } from './store.ts';
import { traceWorkflow, type SetWorkflowOutcome } from '../platform/observability/workflow-diagnostics.ts';

const journal = moduleJournal('timers');

/** Arms `fn` after `ms`; returns the cancel. */
export type SetTimerFn = (fn: () => void, ms: number) => () => void;

type TimerSchedulerDeps = {
  db: Db;
  onFire: (timer: Timer) => void | Promise<void>;
  /** Runs once after a pass that fired anything, with the fired timers' account ids. */
  afterFire: (userIds: readonly string[]) => void | Promise<void>;
  now?: () => number;
  setTimer?: SetTimerFn;
};

export type TimerScheduler = {
  /** Clears the armed timeout; later runs do nothing. */
  stop: () => void;
  /** Fires anything due, then re-arms for the next pending timer. */
  reschedule: () => Promise<void>;
};

/** setTimeout's ceiling; a later timer re-arms when this one elapses. */
const MAX_DELAY_MS = 2_147_483_647;
const RETRY_MS = 5_000;
const BATCH = 100;

const defaultSetTimer: SetTimerFn = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

export function startTimerScheduler({
  db,
  onFire,
  afterFire,
  now = Date.now,
  setTimer = defaultSetTimer,
}: TimerSchedulerDeps): TimerScheduler {
  let stopped = false;
  let cancelArmed: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  function arm(delayMs: number): void {
    cancelArmed?.();
    cancelArmed = null;
    if (stopped) return;
    cancelArmed = setTimer(() => {
      cancelArmed = null;
      void reschedule();
    }, Math.min(Math.max(0, delayMs), MAX_DELAY_MS));
  }

  /** The account ids of the timers this pass fired (distinct). */
  async function fireDue(): Promise<string[]> {
    const users = new Set<string>();
    for (;;) {
      const due = await duePending(db, now(), BATCH);
      const correlationOf = await jobCorrelations(db, due);
      for (const timer of due) {
        if (stopped) return [...users];
        // The owner and the conversation the timer was set in (else their active one) ride the span and every line below.
        await traceWorkflow('timer-fire', { ...correlationOf(timer), metadata: { action: timer.kind } }, async (outcome) => {
          const fired = await markTimerFired(db, timer.userId, timer.id, now());
          if (fired === null) { outcome('skipped'); return; }
          users.add(fired.userId);
          journal('v2.timer_fired', { kind: fired.kind });
          try { await onFire(fired); }
          catch { outcome('failed'); }
        });
      }
      if (due.length < BATCH) return [...users];
    }
  }

  async function run(outcome: SetWorkflowOutcome): Promise<void> {
    if (stopped) return;
    try {
      const firedUsers = await fireDue();
      if (firedUsers.length > 0) {
        try {
          await traceWorkflow('timer-refresh', {}, () => afterFire(firedUsers));
        } catch {
          // Best effort, like onFire: the device list refreshes on the next change.
        }
      }
      if (stopped) return;
      const next = await nextPendingFireAt(db);
      if (next === null) {
        cancelArmed?.();
        cancelArmed = null;
      } else {
        arm(next - now());
      }
    } catch {
      outcome('failed');
      arm(RETRY_MS);
    }
  }

  function reschedule(): Promise<void> {
    chain = chain.then(() => traceWorkflow('timer-sweep', { detached: true }, run));
    return chain;
  }

  function stop(): void {
    stopped = true;
    cancelArmed?.();
    cancelArmed = null;
  }

  void reschedule();
  return { stop, reschedule };
}
