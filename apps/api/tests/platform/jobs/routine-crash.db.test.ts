import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { acquireDatabase, releaseDatabase } from '../../support/pg-template.ts';

function event(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const receive = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && 'event' in message && message.event === name) {
        child.off('message', receive); child.off('exit', failed); resolve();
      }
    };
    const failed = (): void => { child.off('message', receive); reject(new Error('proof_child_exited')); };
    child.on('message', receive); child.once('exit', failed);
  });
}

it('recovers a real killed worker within five minutes with bounded pools', async () => {
  const { database, url } = await acquireDatabase();
  const children: ChildProcess[] = [];
  const probe = postgres(url, { max: 1 });
  const timings: number[] = [];
  let maxConnections = 0;
  let probing = false;
  const sample = async (): Promise<void> => {
    if (probing) return;
    probing = true;
    const start = performance.now();
    try {
      const rows = await probe`select count(*)::int as count from pg_stat_activity where datname = current_database() and application_name = 'bob-routines'`;
      maxConnections = Math.max(maxConnections, Number(rows[0]?.count ?? 0));
      timings.push(performance.now() - start);
    } finally { probing = false; }
  };
  const worker = (block: boolean, runId?: string): ChildProcess => {
    const child = fork(fileURLToPath(new URL('./crash-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ROUTINE_PROOF_DATABASE_URL: url, ROUTINE_PROOF_BLOCK: block ? '1' : '0', ROUTINE_PROOF_RUN_ID: runId ?? '' },
    });
    children.push(child);
    return child;
  };
  const timer = setInterval(() => { void sample(); }, 200);
  try {
    const first = worker(true, randomUUID());
    await event(first, 'active');
    const second = worker(false);
    const recovered = event(second, 'handled');
    await event(second, 'ready');
    await sample();
    const killedAt = performance.now();
    const exited = once(first, 'exit');
    first.kill('SIGKILL');
    await exited;
    await recovered;
    const recoveryMs = performance.now() - killedAt;
    expect(recoveryMs).toBeLessThan(300_000);
    expect(maxConnections).toBeLessThanOrEqual(4);
    timings.sort((a, b) => a - b);
    const evidence = { evidence: 'routine_sigkill', recoveryMs: Math.round(recoveryMs),
      maxConnections, foregroundSamples: timings.length, foregroundDbP95Ms: Math.round(timings[Math.floor(timings.length * 0.95)] ?? 0) };
    const directory = new URL('../../../../../data/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('routine-crash-proof.json', directory), `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    clearInterval(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await probe.end();
    await releaseDatabase(database);
  }
}, 300_000);
