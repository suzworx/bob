/**
 * Reminder delivery and the outbox drain, run by the web server (server.ts,
 * through outboxModule). Starts the outbox drain through one catch-all default
 * lane (createOutboxLanes, #1322 S1 — behavior unchanged for this story) with
 * the email handlers and ticks the reminder fanout at once and then every
 * REMINDER_TICK_MS. The announce rings the recipient's devices, which only the
 * web process holds sessions for. Running it in more than one process at a
 * time is safe: the outbox hands each row to one lease holder, and the fanout
 * claims an occurrence before it notifies.
 */
import { hostname } from 'node:os';
import { ADMIN_INVITATION_EVENT, createAdminInvitationHandler } from './account/admin-invitation.ts';
import type { ApiModule } from './api-module.ts';
import type { Db } from './platform/db/db.ts';
import { createOutboxLanes, type OutboxLanes } from './platform/outbox/lanes.ts';
import { createEmailNotificationHandler } from './notifications/email.ts';
import { EMAIL_NOTIFICATION_EVENT } from './notifications/store.ts';
import { createPushHandler, PUSH_NOTIFICATION_EVENT, PUSH_TIMER_EVENT } from './notifications/push-delivery.ts';
import { createReminderFanout } from './workflows/workflow-reminder-fire.ts';
import type { Announcement } from './voice/device-sessions.ts';
import { moduleJournal } from './platform/logger.ts';
import type { RoutineJobQueue } from './platform/jobs/routine-queue.ts';

const journal = moduleJournal('server');

const REMINDER_TICK_MS = 60_000;

/** This process, as the owner of the outbox leases it takes. */
const OUTBOX_OWNER = `${hostname()}:${process.pid}`;

type OutboxDeliveryOptions = {
  db: Db;
  /** Rings the recipient's devices (the device registry's announce). */
  announce: (userId: string, announcement: Announcement) => unknown;
  owner?: string;
  routineJobs?: RoutineJobQueue;
};

type OutboxDelivery = {
  lanes: OutboxLanes;
  /** Stops the reminder ticks, waits for one in flight, then stops the lanes (releasing their leases). */
  stop: () => Promise<void>;
};

function startOutboxDelivery({ db, announce, owner = OUTBOX_OWNER, routineJobs }: OutboxDeliveryOptions): OutboxDelivery {
  const push = createPushHandler({ db });
  const lanes = createOutboxLanes({
    db,
    owner,
    lanes: [{
      handlers: {
        [EMAIL_NOTIFICATION_EVENT]: createEmailNotificationHandler({ db }),
        [PUSH_NOTIFICATION_EVENT]: push,
        [PUSH_TIMER_EVENT]: push,
        [ADMIN_INVITATION_EVENT]: createAdminInvitationHandler({ db }),
        'routine.dispatch': async (row) => {
          if (!routineJobs) throw new Error('routine_queue_unavailable');
          await routineJobs.send(row.resourceId);
        },
      },
    }],
  });
  lanes.start();
  const fanout = createReminderFanout({ db, announce });
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = fanout.tick()
      .then((count) => {
        if (count > 0) journal('v2.reminder_fanout_tick', { count });
      })
      .catch((error: unknown) => {
        journal('v2.reminder_fanout_failed', { error: error instanceof Error ? error.name : 'unknown' });
      })
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, REMINDER_TICK_MS);
  timer.unref();
  return {
    lanes,
    async stop(): Promise<void> {
      clearInterval(timer);
      await running;
      await lanes.stop();
    },
  };
}

/** The web server's background delivery: started once it listens, stopped with the other workers. */
export const outboxModule: ApiModule = {
  name: 'outbox',
  async start(deps) {
    try {
      const delivery = startOutboxDelivery({
        db: await deps.getDb(),
        announce: (userId, announcement) => deps.deviceSessions.announce(userId, announcement),
        routineJobs: deps.routineJobs,
      });
      journal('v2.outbox_worker_started', { owner: OUTBOX_OWNER });
      return delivery.stop;
    } catch (error) {
      // As the timer scheduler: an unreachable store is journaled and never stops the server.
      journal('v2.outbox_worker_failed', { error: error instanceof Error ? error.name : 'unknown' });
      return async (): Promise<void> => undefined;
    }
  },
};
