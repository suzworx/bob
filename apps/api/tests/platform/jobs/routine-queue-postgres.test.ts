import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoutineJobQueue } from '../../../src/platform/jobs/routine-queue.ts';
import { acquireDatabase, releaseDatabase } from '../../support/pg-template.ts';

describe('pg-boss restricted runtime against Postgres', () => {
  let database: string;
  let url: string;
  beforeAll(async () => { ({ database, url } = await acquireDatabase()); });
  afterAll(async () => { if (database) await releaseDatabase(database); });

  it('delivers a duplicate handoff once and keeps payloads reference-only', async () => {
    const runId = randomUUID();
    let resolveDelivery: (id: string) => void = () => undefined;
    const delivered = new Promise<string>((resolve) => { resolveDelivery = resolve; });
    const queue = createRoutineJobQueue({ connectionString: url, handle: async (id) => { resolveDelivery(id); } });
    await queue.start();
    try {
      await queue.send(runId);
      await queue.send(runId);
      expect(await delivered).toBe(runId);
      const sql = postgres(url, { max: 1, connection: { role: 'bob_jobs' } });
      try {
        const rows = await sql`select data from bob_jobs.job where id = ${runId}`;
        expect(rows.map((row) => row.data)).toEqual([{ runId }]);
      } finally { await sql.end(); }
    } finally { await queue.stop(); }
  });

  it('cannot create schema objects, read account content or administer queues', async () => {
    const sql = postgres(url, { max: 1, connection: { role: 'bob_jobs' } });
    try {
      expect((await sql`select current_user`)[0]?.current_user).toBe('bob_jobs');
      await expect(sql`select * from bob.routines`).rejects.toMatchObject({ code: '42501' });
      await expect(sql`create table bob_jobs.forbidden (id int)`).rejects.toMatchObject({ code: '42501' });
      await expect(sql`select bob_jobs.create_queue('forbidden', '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' });
      expect((await sql`select has_schema_privilege('authenticated','bob_jobs','usage') as allowed`)[0]?.allowed).toBe(false);
      expect((await sql`select has_schema_privilege('anon','bob_jobs','usage') as allowed`)[0]?.allowed).toBe(false);
    } finally { await sql.end(); }
  });

  it('persists a safe error without provider content on handler failure', async () => {
    let invoked: () => void = () => undefined;
    const called = new Promise<void>((resolve) => { invoked = resolve; });
    const runId = randomUUID();
    const queue = createRoutineJobQueue({ connectionString: url, handle: async () => {
      invoked();
      throw new Error('private mailbox content and bearer secret');
    } });
    await queue.start();
    await queue.send(runId);
    await called;
    await queue.stop();
    const sql = postgres(url, { max: 1, connection: { role: 'bob_jobs' } });
    try {
      const rows = await sql`select output from bob_jobs.job where id = ${runId}`;
      const output = JSON.stringify(rows[0]?.output);
      expect(output).toContain('routine_execution_failed');
      expect(output).not.toContain('private mailbox');
      expect(output).not.toContain('bearer secret');
    } finally { await sql.end(); }
  });

  it('rolls back enqueue and recovers an abandoned heartbeat with a finite retry', async () => {
    const boss = new PgBoss({ connectionString: url, schema: 'bob_jobs', options: '-c role=bob_jobs', max: 2,
      migrate: false, createSchema: false, schedule: false, supervise: false, reindex: false,
      openTelemetry: { enabled: false } });
    boss.on('error', () => undefined);
    await boss.start();
    const sql = postgres(url, { max: 1, connection: { role: 'bob_jobs' } });
    try {
      const rolledBack = randomUUID();
      const transaction = await boss.getDb().beginTransaction?.();
      if (!transaction) throw new Error('native_transaction_missing');
      await boss.send('routine-run', { runId: rolledBack }, { id: rolledBack, db: transaction.db });
      await transaction.rollback();
      expect(await sql`select id from bob_jobs.job where id = ${rolledBack}`).toHaveLength(0);
      const runId = randomUUID();
      await boss.send('routine-run', { runId }, { id: runId });
      expect((await boss.fetch('routine-run'))[0]?.id).toBe(runId);
      await sql`update bob_jobs.job set heartbeat_on = now() - interval '2 minutes' where id = ${runId}`;
      await boss.supervise('routine-run');
      const rows = await sql`select state, retry_limit from bob_jobs.job where id = ${runId}`;
      expect(rows[0]).toMatchObject({ state: 'retry', retry_limit: 2 });
    } finally { await boss.stop(); await sql.end(); }
  });
});
