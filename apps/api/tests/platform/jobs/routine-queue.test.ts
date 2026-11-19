import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), send: vi.fn(), work: vi.fn(), on: vi.fn(), options: vi.fn() }));
vi.mock('pg-boss', () => ({ PgBoss: class {
  constructor(options: unknown) { mock.options(options); }
  start = mock.start; stop = mock.stop; send = mock.send; work = mock.work; on = mock.on;
} }));
import { createRoutineJobQueue } from '../../../src/platform/jobs/routine-queue.ts';
import { setJournalSink } from '../../../src/platform/logger.ts';
describe('routine job queue boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses a restricted two-connection polling pool without runtime migrations', async () => {
    const queue = createRoutineJobQueue({ connectionString: 'postgres://localhost/test', handle: vi.fn() });
    await queue.start();
    expect(mock.options).toHaveBeenCalledWith(expect.objectContaining({ max: 2, migrate: false, createSchema: false, options: '-c role=bob_jobs -c statement_timeout=10000', schedule: false }));
    expect(mock.work).toHaveBeenCalledWith('routine-run', expect.objectContaining({ localConcurrency: 1, batchSize: 1 }), expect.any(Function));
  });
  it('sends only a validated run reference with a deterministic job id', async () => {
    const queue = createRoutineJobQueue({ connectionString: 'postgres://localhost/test', handle: vi.fn() });
    await queue.send('448101fc-430b-4c23-bb3d-a75e06f204a3');
    await queue.send('448101fc-430b-4c23-bb3d-a75e06f204a3');
    expect(mock.send.mock.calls[0]).toEqual(mock.send.mock.calls[1]);
    expect(mock.send.mock.calls[0]?.[1]).toEqual({ runId: '448101fc-430b-4c23-bb3d-a75e06f204a3' });
    await expect(queue.send('private mail')).rejects.toThrow('invalid_routine_run');
    expect(mock.send).toHaveBeenCalledTimes(2);
  });
  it('journals a pool error as its classified reason, never its message', () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    createRoutineJobQueue({ connectionString: 'postgres://localhost/test', handle: vi.fn() });
    const onError = mock.on.mock.calls.find((call) => call[0] === 'error')?.[1] as (error: unknown) => void;
    onError(Object.assign(new Error('getaddrinfo ENOTFOUND private.host'), { code: 'ENOTFOUND' }));
    setJournalSink(null);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'v2.routine_queue_error', code: 'queue_unavailable', reason: 'host_not_found' });
    expect(lines.join('\n')).not.toContain('private.host');
  });
  it('never gives pg-boss provider errors or handler output', async () => {
    const queue = createRoutineJobQueue({ connectionString: 'postgres://localhost/test', handle: vi.fn().mockRejectedValue(new Error('private mailbox secret')) });
    await queue.start();
    const handler = mock.work.mock.calls[0]?.[2] as (jobs: unknown[]) => Promise<void>;
    await expect(handler([{ data: { runId: '448101fc-430b-4c23-bb3d-a75e06f204a3' }, signal: new AbortController().signal }])).rejects.toThrow('routine_execution_failed');
  });
});
