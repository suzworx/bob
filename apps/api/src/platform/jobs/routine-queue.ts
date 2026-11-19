import { PgBoss, type Job } from 'pg-boss';
import { z } from 'zod';
import { moduleJournal } from '../logger.ts';
import { classifyDbError } from '../db/db-error.ts';

const payload = z.object({ runId: z.uuid() }).strict();
const queueName = 'routine-run';
const journal = moduleJournal('platform');

export interface RoutineJobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(runId: string): Promise<void>;
}

/** Infrastructure sees opaque run references only; account authorization stays in Core. */
export function createRoutineJobQueue(input: {
  connectionString: string;
  handle: (runId: string, signal: AbortSignal) => Promise<void>;
}): RoutineJobQueue {
  const shutdown = new AbortController();
  const boss = new PgBoss({
    connectionString: input.connectionString,
    schema: 'bob_jobs',
    options: '-c role=bob_jobs -c statement_timeout=10000',
    application_name: 'bob-routines',
    max: 2,
    connectionTimeoutMillis: 5_000,
    migrate: false,
    createSchema: false,
    schedule: false,
    useListenNotify: false,
    persistWarnings: false,
    persistQueueStats: false,
    reindex: false,
    monitorVacuum: false,
    monitorIntervalSeconds: 30,
    superviseIntervalSeconds: 30,
    openTelemetry: { enabled: false },
  });
  // Driver errors may contain SQL and connection details. Never forward their payload, only its classified code.
  boss.on('error', (error: unknown) => journal('v2.routine_queue_error', { code: 'queue_unavailable', reason: classifyDbError(error) }));
  async function execute(jobs: Job<unknown>[]): Promise<void> {
    try {
      const job = jobs[0];
      if (!job) throw new Error('missing_job');
      const data = payload.parse(job.data);
      const signal = AbortSignal.any([job.signal, shutdown.signal, AbortSignal.timeout(300_000)]);
      signal.throwIfAborted();
      await input.handle(data.runId, signal);
      signal.throwIfAborted();
    } catch {
      // pg-boss persists thrown errors and may record them in tracing.
      throw new Error('routine_execution_failed');
    }
  }
  return {
    async start(): Promise<void> {
      await boss.start();
      await boss.work(queueName, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 }, execute);
    },
    async stop(): Promise<void> {
      shutdown.abort();
      await boss.stop({ graceful: true, timeout: 10_000, close: true });
    },
    async send(runId: string): Promise<void> {
      const data = payload.safeParse({ runId });
      if (!data.success) throw new Error('invalid_routine_run');
      await boss.send(queueName, data.data, { id: runId });
    },
  };
}
