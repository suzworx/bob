import type { ApiModule } from './api-module.ts';
import { createRoutineJobHandler, createRoutineRunner, dispatchDueRuns } from './workflows/workflow-routine-run.ts';
import { GoogleCredentialError } from './integrations/google-credentials.ts';
import { classifyDbError } from './platform/db/db-error.ts';
import { createRoutineJobQueue } from './platform/jobs/routine-queue.ts';
import { moduleJournal } from './platform/logger.ts';

const journal = moduleJournal('server');

/** One dispatcher in this API process; the existing outbox owns durable handoff. */
export const routineModule: ApiModule = {
  name: 'routines',
  async start(deps) {
    const connectionString = process.env.BOB_DATABASE_URL;
    if (!connectionString) return async (): Promise<void> => undefined;
    const db = await deps.getDb();
    const routineHandle = deps.routineDigest ? createRoutineRunner({ db, digest: deps.routineDigest,
      verifyConsent: async (owner, accountId, signal) => {
        const capabilities = await deps.googleConnection?.capabilities(owner, accountId, signal);
        if (!capabilities?.includes('gmail.read')) throw new GoogleCredentialError('permission_required');
      },
    }) : null;
    const handle = createRoutineJobHandler(db, routineHandle);
    const queue = createRoutineJobQueue({ connectionString, handle });
    try {
      await queue.start();
    } catch (error) {
      await queue.stop().catch(() => undefined);
      journal('v2.routine_queue_error', { code: 'queue_unavailable', reason: classifyDbError(error) });
      // Fail boot so the host's restart policy can recover the dependency.
      // Silently continuing would disable scheduling until a manual restart.
      throw new Error('routine_queue_start_failed');
    }
    deps.routineJobs = queue;
    let running: Promise<void> | null = null;
    const tick = (): void => {
      if (running) return;
      const now = Date.now();
      if (!Number.isSafeInteger(now) || now < 0) return;
      running = dispatchDueRuns(db, now, routineHandle !== null).then((count) => {
        if (count > 0) journal('v2.routine_dispatch_tick', { count });
      }).catch((error: unknown) => {
        journal('v2.routine_dispatch_failed', { code: 'dispatch_unavailable', reason: classifyDbError(error) });
      }).finally(() => { running = null; });
    };
    tick();
    const timer = setInterval(tick, 30_000);
    timer.unref();
    return async (): Promise<void> => {
      clearInterval(timer);
      await running;
      await queue.stop();
      delete deps.routineJobs;
    };
  },
};
