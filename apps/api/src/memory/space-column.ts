/** Whether new memory rows can carry their space (a hosted store can lag the
 *  migration). Kept out of available.ts so tests that mock the availability
 *  guard wholesale do not also have to fake this probe. */
import type { Db } from '../platform/db/db.ts';

/** to_regclass never errors, so the probe is safe inside the caller's
 *  transaction (an error there would abort it). */
const SPACE_COLUMN_SQL = `
  select exists (
    select 1 from pg_attribute
    where attrelid = to_regclass('bob.memories') and attname = 'space_id' and not attisdropped
  ) as has_space_id
`;

/** Process-wide: inserts run on per-transaction Db handles, so a per-Db cache
 *  would probe every insert. One database per process. */
let spaceColumnCache: Promise<boolean> | null = null;

/** Probed once; never throws (an error is false, not cached). */
export function memorySpaceColumn(db: Db): Promise<boolean> {
  spaceColumnCache ??= Promise.resolve().then(() => db.query<{ has_space_id: unknown }>(SPACE_COLUMN_SQL)).then(
    (rows) => rows[0]?.has_space_id === true,
    () => {
      spaceColumnCache = null;
      return false;
    },
  );
  return spaceColumnCache;
}

export function resetMemorySpaceColumn(): void {
  spaceColumnCache = null;
}
