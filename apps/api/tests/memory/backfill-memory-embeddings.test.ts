// Default-suite tests for scripts/backfill-memory-embeddings.ts (S10-FIX8,
// TASKS.md). No network, no real bob.memories rows: like
// memory-extract.test.ts, which fakes the memories store instead of touching
// a real one (see that file's header comment), this suite follows
// the same shape: findMissingEmbeddings/writeEmbedding are injected fakes
// backed by an in-memory fixture that mimics `WHERE embedding IS NULL`
// filtering and id-keyset pagination, while a real Postgres test db (from
// tests/support/test-db.ts, the same helpers store-memories.db.test.ts and
// scripts/db-import-local.test.mjs use) supplies a genuine Db and a genuine
// account uuid, so the plumbing runBackfill receives is real even though the
// row source is a fixture. The real asServer + bob_private SQL wiring
// (findMissingEmbeddings/writeEmbedding as shipped in the script) needs the
// still-missing bob_private.memories_missing_embedding /
// bob_private.set_memory_embedding migration and belongs in a future
// *.db.test.ts under `npm run test:db` -- see the script's module doc GAP note.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import { asDb, addAccount, closeTestDb, createTestDb, type TestDb } from '../support/test-db.ts';
import {
  DEFAULT_BATCH_SIZE,
  parseArgs,
  runBackfill,
  type BackfillDeps,
  type MissingEmbeddingRow,
} from '../../scripts/backfill-memory-embeddings.ts';
import { type Embedder } from '@bob/ai';
import type { MemoryEmbedding } from '../../src/memory/store.ts';

const DIM = 4;

type FixtureRow = { id: string; userId: string; content: string; embedding: MemoryEmbedding | null };

/** An in-memory stand-in for bob.memories, keyed and ordered by id -- the
 *  same shape the real bob_private.memories_missing_embedding function
 *  would page over (id-ascending keyset, WHERE embedding IS NULL). */
function makeFixtureStore(rows: FixtureRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const order = [...byId.keys()].sort();

  const findMissingEmbeddings = vi.fn(
    async (_db: Db, limit: number, afterId: string | null): Promise<MissingEmbeddingRow[]> => {
      const startIndex = afterId ? order.indexOf(afterId) + 1 : 0;
      const missing = order
        .slice(startIndex)
        .map((id) => byId.get(id)!)
        .filter((row) => row.embedding === null);
      return missing.slice(0, limit).map(({ id, userId, content }) => ({ id, userId, content }));
    },
  );

  const writeEmbedding = vi.fn(async (_db: Db, id: string, embedding: MemoryEmbedding): Promise<void> => {
    const row = byId.get(id);
    if (!row) throw new Error(`fixture: unknown id ${id}`);
    row.embedding = embedding;
  });

  return { byId, findMissingEmbeddings, writeEmbedding };
}

/** A deterministic fake embedder; embedMany can be told to reject on a given
 *  0-based call index so a mid-scan batch failure is reproducible. */
function fakeEmbedder(rejectOnCall?: number): Embedder {
  let call = 0;
  return {
    modelId: 'text-embedding-3-small',
    dim: DIM,
    embed: vi.fn(async () => new Array(DIM).fill(0.1)),
    embedMany: vi.fn(async (texts: string[]) => {
      const thisCall = call++;
      if (thisCall === rejectOnCall) throw new Error('embedding provider unavailable');
      return texts.map((_, i) => new Array(DIM).fill(0.1 * (thisCall + 1) + i * 0.01));
    }),
  };
}

describe('backfill-memory-embeddings', () => {
  let pg: TestDb;
  let db: Db;
  let userId: string;

  beforeAll(async () => {
    pg = await createTestDb();
    db = asDb(pg);
    const account = await addAccount(pg);
    userId = account.userId;
  });

  afterAll(async () => {
    await closeTestDb(pg);
  });

  it('embeds every NULL-embedding row and leaves rows that already have one alone', async () => {
    const store = makeFixtureStore([
      { id: 'mem_1', userId, content: 'already embedded', embedding: { values: [9, 9], model: 'old-model', dim: 2 } },
      { id: 'mem_2', userId, content: 'the user has a daughter', embedding: null },
      { id: 'mem_3', userId, content: 'the daughter likes drawing', embedding: null },
      { id: 'mem_4', userId, content: 'family dinner is on Sundays', embedding: null },
    ]);
    const embedder = fakeEmbedder();
    const log = vi.fn();

    const summary = await runBackfill({
      db,
      embedder,
      batchSize: 2,
      dryRun: false,
      findMissingEmbeddings: store.findMissingEmbeddings,
      writeEmbedding: store.writeEmbedding,
      log,
    } satisfies BackfillDeps);

    expect(summary).toEqual({ scanned: 3, embedded: 3, failed: 0 });

    // Batched in groups of 2 (batchSize): [mem_2, mem_3] then [mem_4].
    expect(embedder.embedMany).toHaveBeenCalledTimes(2);
    expect(embedder.embedMany).toHaveBeenNthCalledWith(1, [
      'the user has a daughter',
      'the daughter likes drawing',
    ]);
    expect(embedder.embedMany).toHaveBeenNthCalledWith(2, ['family dinner is on Sundays']);

    // The already-embedded row was never touched.
    expect(store.writeEmbedding).not.toHaveBeenCalledWith(expect.anything(), 'mem_1', expect.anything());
    expect(store.byId.get('mem_1')!.embedding).toEqual({ values: [9, 9], model: 'old-model', dim: 2 });

    // Every previously-null row now carries a vector with the embedder's model/dim.
    for (const id of ['mem_2', 'mem_3', 'mem_4']) {
      const embedding = store.byId.get(id)!.embedding;
      expect(embedding).not.toBeNull();
      expect(embedding!.model).toBe('text-embedding-3-small');
      expect(embedding!.dim).toBe(DIM);
      expect(embedding!.values).toHaveLength(DIM);
    }
  });

  it('--dry-run reports ids without embedding or writing anything', async () => {
    const store = makeFixtureStore([
      { id: 'mem_5', userId, content: 'secret memory content', embedding: null },
      { id: 'mem_6', userId, content: 'another secret', embedding: null },
    ]);
    const embedder = fakeEmbedder();
    const log = vi.fn();

    const summary = await runBackfill({
      db,
      embedder,
      batchSize: DEFAULT_BATCH_SIZE,
      dryRun: true,
      findMissingEmbeddings: store.findMissingEmbeddings,
      writeEmbedding: store.writeEmbedding,
      log,
    } satisfies BackfillDeps);

    expect(summary).toEqual({ scanned: 2, embedded: 0, failed: 0 });
    expect(embedder.embedMany).not.toHaveBeenCalled();
    expect(store.writeEmbedding).not.toHaveBeenCalled();
    expect(store.byId.get('mem_5')!.embedding).toBeNull();
    expect(store.byId.get('mem_6')!.embedding).toBeNull();

    // Logs carry ids only -- never the memory content (privacy rule).
    const logged = log.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('mem_5') && line.includes('mem_6'))).toBe(true);
    expect(logged.some((line) => line.includes('secret memory content'))).toBe(false);
  });

  it('counts a failed batch, keeps scanning, and the summary signals a non-zero exit', async () => {
    const store = makeFixtureStore([
      { id: 'mem_7', userId, content: 'first row', embedding: null },
      { id: 'mem_8', userId, content: 'second row', embedding: null },
    ]);
    // batchSize 1 -> two embedMany calls; the first rejects, the second succeeds.
    const embedder = fakeEmbedder(0);
    const log = vi.fn();

    const summary = await runBackfill({
      db,
      embedder,
      batchSize: 1,
      dryRun: false,
      findMissingEmbeddings: store.findMissingEmbeddings,
      writeEmbedding: store.writeEmbedding,
      log,
    } satisfies BackfillDeps);

    expect(summary).toEqual({ scanned: 2, embedded: 1, failed: 1 });
    // main() sets process.exitCode = 1 exactly when failed > 0 (see the script).
    expect(summary.failed > 0).toBe(true);
    expect(store.byId.get('mem_7')!.embedding).toBeNull();
    expect(store.byId.get('mem_8')!.embedding).not.toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to a live run with DEFAULT_BATCH_SIZE', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, batchSize: DEFAULT_BATCH_SIZE });
  });

  it('accepts --dry-run and --batch-size in both space and = forms', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, batchSize: DEFAULT_BATCH_SIZE });
    expect(parseArgs(['--batch-size', '10'])).toEqual({ dryRun: false, batchSize: 10 });
    expect(parseArgs(['--batch-size=25', '--dry-run'])).toEqual({ dryRun: true, batchSize: 25 });
  });

  it('rejects a non-positive-integer batch size and an unknown flag', () => {
    expect(() => parseArgs(['--batch-size', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--batch-size', 'nope'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--batch-size=-5'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
  });
});
