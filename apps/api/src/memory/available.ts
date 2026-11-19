/**
 * Whether the memory store is usable on this database: the `vector` extension
 * AND `bob.memories` exist. Every read or write of the memory objects sits
 * behind it, and when it is false the turn runs without memory.
 */
import type { Db } from '../platform/db/db.ts';

const AVAILABILITY_SQL = `
  select
    exists (select 1 from pg_extension where extname = 'vector') as has_vector,
    to_regclass('bob.memories') is not null as has_memories
`;

interface AvailabilityRow {
  has_vector: boolean;
  has_memories: boolean;
}

const probes = new WeakMap<Db, Promise<boolean>>();

/** Cached per Db. Any query error means false; it never throws. */
export function memoryAvailable(db: Db): Promise<boolean> {
  const cached = probes.get(db);
  if (cached) return cached;

  const probe = (async () => {
    try {
      const rows = await db.query<AvailabilityRow>(AVAILABILITY_SQL);
      const row = rows[0];
      return Boolean(row?.has_vector && row?.has_memories);
    } catch {
      return false;
    }
  })();

  probes.set(db, probe);
  return probe;
}

export function resetMemoryAvailability(db: Db): void {
  probes.delete(db);
}
