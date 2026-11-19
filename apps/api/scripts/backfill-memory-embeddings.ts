/**
 * One-off backfill for bob.memories rows written before the embedder was
 * wired into the turn paths (S10-FIX8, TASKS.md). Every row with
 * `embedding IS NULL` is permanently invisible to bob.match_memories'
 * semantic branch (`where m.embedding is not null`), and the full-text branch
 * ANDs every word of the question, so a short memory can easily never match a
 * natural question either. These rows never heal on their own. This script
 * finds them, embeds their content with the gateway embedder in batches, and
 * writes the vector back with the model id and dim, leaving every other
 * column untouched (the same embedding-only UPDATE shape correctMemory uses
 * in apps/api/src/memory/store.ts).
 *
 * Usage (tsx, the repo's TS runner -- also `npm run memory:backfill`):
 *   npx tsx apps/api/scripts/backfill-memory-embeddings.ts [--dry-run] [--batch-size N]
 *
 * --dry-run reports how many rows would change (ids only) without embedding
 * or writing anything. --batch-size (default DEFAULT_BATCH_SIZE) bounds how
 * many rows are embedded per embedMany call.
 *
 * SECURITY MODEL: this is necessarily a cross-account maintenance scan -- we
 * do not know in advance which accounts have stale rows -- so it cannot run
 * under withUser(db, userId, ...) (one account at a time) and it must not
 * disable or bypass RLS. It follows the SAME server-role path
 * apps/api/src/memory/extract-queue.ts uses for its own cross-account
 * startup scan (listAccountsWithUnextracted): asServer(db, ...) calling a
 * SECURITY DEFINER function in the bob_private schema, granted only to
 * bob_server (the role BOB_DATABASE_URL connects as). db.ts's asServer
 * wrapper refuses any SQL that is not an bob_private.* call, so this file
 * cannot accidentally read or write account rows directly.
 *
 * GAP: findMissingEmbeddings/writeEmbedding below call
 * bob_private.memories_missing_embedding(limit, after_id) and
 * bob_private.set_memory_embedding(id, embedding, model, dim). Neither
 * function exists in the schema yet -- adding them is a supabase/migrations
 * change (mirroring supabase/migrations/20260916020000_memory_scan_helper.sql),
 * which is OUTSIDE this unit's owns: list (apps/api/scripts/
 * backfill-memory-embeddings.ts, apps/api/tests/
 * backfill-memory-embeddings.test.ts, package.json). Until that migration
 * ships, running this script against real Postgres fails loudly with
 * "function bob_private.... does not exist" -- a safe, visible failure,
 * never a silent no-op and never a cross-account leak (FORCE RLS with no
 * claims set denies everything to a direct query). See TASKS.md / the
 * S10-FIX8 report for the follow-up.
 *
 * Never logs memory content -- every log line below carries counts and ids
 * only (the journal privacy rule; AGENTS.md, log-reference.md).
 */
import { pathToFileURL } from 'node:url';
import { asServer, closeDb, getDb, type Db } from '../src/platform/db/db.ts';
import { vectorLiteral, type MemoryEmbedding } from '../src/memory/store.ts';
import { type Embedder } from '@bob/ai';

/** A sane default: big enough to make progress, small enough that one failed
 *  embedMany call never throws away much work. */
export const DEFAULT_BATCH_SIZE = 50;

export type MissingEmbeddingRow = {
  id: string;
  userId: string;
  content: string;
};

export type BackfillSummary = {
  scanned: number;
  embedded: number;
  failed: number;
};

export type BackfillDeps = {
  db: Db;
  embedder: Embedder;
  batchSize: number;
  dryRun: boolean;
  /** Finds up to `limit` rows with embedding IS NULL, ordered by id ascending
   *  after the keyset cursor `afterId` (null for the first page). Reaches
   *  across every account via the server-role path described above. */
  findMissingEmbeddings: (
    db: Db,
    limit: number,
    afterId: string | null,
  ) => Promise<MissingEmbeddingRow[]>;
  /** Writes embedding + embedding_model + embedding_dim for one row; every
   *  other column (including updated_at) is left untouched. */
  writeEmbedding: (db: Db, id: string, embedding: MemoryEmbedding) => Promise<void>;
  /** Counts/ids only -- never memory content. */
  log: (line: string) => void;
};

/**
 * Pages through every bob.memories row with a NULL embedding, embeds each
 * batch's content, and writes the vectors back. Pagination advances past a
 * batch even when that batch's embed or write calls fail, so one bad batch
 * never blocks the rest of the scan; failures are counted, not thrown.
 * --dry-run scans and logs ids but calls neither embedMany nor writeEmbedding.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const { db, embedder, batchSize, dryRun, log, findMissingEmbeddings, writeEmbedding } = deps;
  let scanned = 0;
  let embedded = 0;
  let failed = 0;
  let afterId: string | null = null;

  for (;;) {
    const rows = await findMissingEmbeddings(db, batchSize, afterId);
    if (rows.length === 0) break;
    scanned += rows.length;
    afterId = rows[rows.length - 1]!.id;

    if (dryRun) {
      log(`dry-run: would embed ${rows.length} row(s): ${rows.map((row) => row.id).join(', ')}`);
      if (rows.length < batchSize) break;
      continue;
    }

    let vectors: number[][];
    try {
      vectors = await embedder.embedMany(rows.map((row) => row.content));
    } catch (error) {
      failed += rows.length;
      log(`batch embed failed for ${rows.length} row(s): ${errorName(error)}`);
      if (rows.length < batchSize) break;
      continue;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      try {
        await writeEmbedding(db, row.id, {
          values: vectors[index]!,
          model: embedder.modelId,
          dim: embedder.dim,
        });
        embedded += 1;
      } catch (error) {
        failed += 1;
        log(`write failed for id=${row.id}: ${errorName(error)}`);
      }
    }

    if (rows.length < batchSize) break;
  }

  return { scanned, embedded, failed };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : 'UnknownError';
}

// --- Production wiring: the server-role path (see the module doc GAP note) -

async function findMissingEmbeddings(
  db: Db,
  limit: number,
  afterId: string | null,
): Promise<MissingEmbeddingRow[]> {
  const rows = await asServer(db, (server) =>
    server.query<{ id: unknown; userId: unknown; content: unknown }>(
      `select o.id as "id", o.user_id as "userId", o.content as "content"
         from bob_private.memories_missing_embedding($1, $2) o`,
      [limit, afterId],
    ),
  );
  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.userId),
    content: String(row.content),
  }));
}

async function writeEmbedding(db: Db, id: string, embedding: MemoryEmbedding): Promise<void> {
  await asServer(db, (server) =>
    server.query(
      `select bob_private.set_memory_embedding($1, $2::extensions.vector, $3, $4)`,
      [id, vectorLiteral(embedding.values), embedding.model, embedding.dim],
    ),
  );
}

// --- CLI -------------------------------------------------------------------

export type ParsedArgs = { dryRun: boolean; batchSize: number };

/** Parses --dry-run and --batch-size (space or = form); rejects anything else. */
export function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  const readBatchSize = (raw: string | undefined): number => {
    const value = Number(raw);
    if (raw === undefined || raw.length === 0 || !Number.isInteger(value) || value <= 0) {
      throw new Error('--batch-size requires a positive integer');
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--batch-size') {
      batchSize = readBatchSize(argv[++i]);
      continue;
    }
    if (arg.startsWith('--batch-size=')) {
      batchSize = readBatchSize(arg.slice('--batch-size='.length));
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return { dryRun, batchSize };
}

async function main(): Promise<void> {
  const { dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const db = await getDb();
  try {
    // Dynamic import: keeps the AI Gateway/provider wiring (@bob/ai agents.ts)
    // out of this module's static import graph, so importing this script for
    // its exports (tests, --dry-run tooling) never constructs a gateway client.
    const { createEmbedder } = await import('@bob/ai');
    const embedder = createEmbedder();

    const summary = await runBackfill({
      db,
      embedder,
      batchSize,
      dryRun,
      findMissingEmbeddings,
      writeEmbedding,
      log: (line) => console.log(`[memory:backfill] ${line}`),
    });

    console.log(
      `[memory:backfill] scanned=${summary.scanned} embedded=${summary.embedded} failed=${summary.failed}` +
        (dryRun ? ' (dry-run, nothing written)' : ''),
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
