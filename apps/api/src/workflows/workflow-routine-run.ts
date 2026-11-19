/**
 * Workflow: a scheduled routine run (Gmail digest, saved as a private note and optionally emailed) and the Bob app refresh, dispatched on a tick and executed from the queue.
 * Trigger: the 30 s tick in `routine-module.ts` (`dispatchDueRuns`) and the pg-boss `routine-run` job (`routine-module.ts`, `createRoutineJobHandler`); the outbox `routine.dispatch` kind forwards into that queue (`outbox-module.ts`).
 * Steps: 1. Dispatch due routines and due Bob app refreshes (`dispatchDueRuns`). 2. On the job, try a Bob app run first (`tryHandleBobAppRun`), else the routine runner, else fail `routine_provider_unavailable`. 3. Runner: deliver a pending email if one is saved; otherwise start the run, check tool policy and Google consent, build the digest, re-check the fences, publish the result, then deliver its email. 4. On failure, record the run failure code; consent-class failures stop, other failures throw `routine_retry` so the queue retries.
 * Outcome: the run is published, or failed with a code (`stale`, `consent_unavailable`, `cancelled`, `provider_unavailable`); its email is queued or muted, or left unset when no notification was queued so the UI never claims delivery. Bob app refresh runs in one bob-apps SQL transaction (`bob-apps/refresh.ts`, a capability, not a workflow).
 * Journal: by the trigger (`routine-module.ts`): `v2.routine_dispatch_tick`, `v2.routine_dispatch_failed`, `v2.routine_queue_error`. From the moved steps: `v2.notifications_enqueued` and `v2.notifications_enqueue_failed` (`notifyBobMessage` in `notifications/notify.ts`). No trace names.
 */
import { assertToolEnabled, ToolPolicyError } from '../tools/policy.ts';
import type { Db } from '../platform/db/db.ts';
import { GoogleCredentialError } from '../integrations/google-credentials.ts';
import type { createRoutineDigest } from '../routines/digest.ts';
import { notifyBobMessage, type DeliveryOutcome } from '../notifications/notify.ts';
import { checkRoutineRun, failRoutineRun, getRoutineEmailDeliveryContext, publishRoutineResult, recordRoutineEmailOutcome, startRoutineRun, type RoutineRunContext } from '../routines/run-store.ts';
import { dispatchRoutines } from '../routines/dispatch.ts';
import { dispatchBobAppRefreshes, tryHandleBobAppRun } from '../bob-apps/refresh.ts';

type RoutineHandle = (id: string, signal: AbortSignal) => Promise<void>;

/** The queue handler: Bob app runs are tried first, so one queue serves both kinds of run. */
export function createRoutineJobHandler(db: Db, routineHandle: RoutineHandle | null): RoutineHandle {
  return async (id, signal) => {
    if (await tryHandleBobAppRun(db, id, signal)) return;
    if (!routineHandle) throw new Error('routine_provider_unavailable');
    await routineHandle(id, signal);
  };
}

/** One tick's dispatch: due routines (only when a digest provider is configured) and due Bob app refreshes. */
export function dispatchDueRuns(db: Db, now: number, routinesEnabled: boolean): Promise<number> {
  return Promise.all([routinesEnabled ? dispatchRoutines(db, now) : Promise.resolve(0), dispatchBobAppRefreshes(db, now)])
    .then((counts) => counts.reduce((total, value) => total + value, 0));
}

async function failed(db: Db, run: RoutineRunContext, error: unknown, signal: AbortSignal, now: number): Promise<void> {
  if (error instanceof Error && error.message === 'routine_run_stale') {
    await failRoutineRun(db, run, 'stale', false, now);
    return;
  }
  const consent = error instanceof ToolPolicyError && error.code === 'tool_disabled' || error instanceof GoogleCredentialError && error.code !== 'unavailable';
  const code = consent ? 'consent_unavailable' : signal.aborted ? 'cancelled' : 'provider_unavailable';
  await failRoutineRun(db, run, code, consent, now);
  if (!consent) throw new Error('routine_retry');
}

/** No browser/session is needed. The saved run is the private authorization
 * context; fresh grants and revision/token fences surround every execution. */
export function createRoutineRunner(deps: {
  db: Db;
  digest: ReturnType<typeof createRoutineDigest>;
  verifyConsent(owner: string, accountId: string, signal: AbortSignal): Promise<void>;
  notifyBobMessage?: (db: Db, recipientUserId: string, noteId: string, effectKey: string) => Promise<DeliveryOutcome>;
  now?: () => number;
}): (id: string, signal: AbortSignal) => Promise<void> {
  const clock = deps.now ?? Date.now;
  const notify = deps.notifyBobMessage ?? notifyBobMessage;
  const deliverEmail = async (context: { owner: string; spaceId: string; noteId: string }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const outcome = await notify(deps.db, context.owner, context.noteId, `bob_message:note:${context.noteId}`);
    if (outcome.status === 'delivered') {
      await recordRoutineEmailOutcome(deps.db, context.noteId, 'queued');
    } else if (outcome.status === 'muted') {
      await recordRoutineEmailOutcome(deps.db, context.noteId, 'muted');
    } else if (outcome.status === 'failed') {
      throw new Error('routine_retry');
    } else {
      // No notification was queued (for example, the private note disappeared).
      // Leave NULL so the UI never claims delivery.
    }
  };
  return async (id, signal) => {
    signal.throwIfAborted();
    const pendingEmail = await getRoutineEmailDeliveryContext(deps.db, id);
    if (pendingEmail) {
      await deliverEmail(pendingEmail, signal);
      return;
    }
    const run = await startRoutineRun(deps.db, id, clock());
    if (!run) return;
    const checkActive = async (): Promise<void> => {
      signal.throwIfAborted(); await checkRoutineRun(deps.db, run);
      const context = { integrationId: run.googleAccountId };
      await assertToolEnabled(deps.db, run.owner, 'google_gmail_search', context);
      await assertToolEnabled(deps.db, run.owner, 'google_gmail_read_thread', context);
    };
    try {
      await checkActive();
      await deps.verifyConsent(run.owner, run.googleAccountId, signal);
      const result = await deps.digest({ ...run, signal, checkActive });
      await checkActive();
      await deps.verifyConsent(run.owner, run.googleAccountId, signal);
      await checkActive();
      const published = await publishRoutineResult(deps.db, run, result, clock());
      if (published && run.emailResult) {
        const emailContext = await getRoutineEmailDeliveryContext(deps.db, run.id);
        if (emailContext) await deliverEmail(emailContext, signal);
      }
    } catch (error) {
      await failed(deps.db, run, error, signal, clock());
    }
  };
}
