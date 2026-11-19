/**
 * Scoped search across tasks, notes, calendar events and threads.
 *
 * The whole design is one sentence: inaccessible items are ABSENT, not
 * redacted. So the query runs under withUser() and RLS decides visibility -- a
 * row in a space the caller is not an active member of never leaves the
 * database, and there is no post-filter and no "N hidden results" count
 * anywhere. A `space_id` the caller cannot access therefore answers exactly
 * like a space that does not exist: an empty list, never a 403.
 *
 * Matching is a case-insensitive substring (ILIKE, with %, _ and backslash
 * escaped) -- no pg_trgm, no vector, no new extension.
 *
 * `snippet` is drawn from the row the caller is already authorized to read --
 * it is the searchable body content, not a second authorization decision. For
 * tasks and notes it is the body ('' when a task has none); events carry their
 * body; threads have no body column, so their snippet is empty.
 *
 * Ordering: exact title match first, then a title substring, then a body
 * substring, then updated_at desc. Deterministic ties break on resource_id so
 * paging by `limit` is stable across repeated calls.
 */
import { StoreError, withUser, type Db } from '../platform/db/db.ts';
import { sharedScope } from './space-scope.ts';

export type SearchResourceType = 'task' | 'note' | 'event' | 'thread';

type SearchResult = {
  resource_type: SearchResourceType;
  resource_id: string;
  space_id: string;
  title: string;
  snippet: string;
  updated_at: number;
  rank: number;
};

type SearchOptions = {
  query: string;
  spaceId?: string;
  types?: SearchResourceType[];
  limit?: number;
};

const RESOURCE_TYPES: readonly SearchResourceType[] = ['task', 'note', 'event', 'thread'];

function isResourceType(value: unknown): value is SearchResourceType {
  return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

/** Escapes the LIKE/ILIKE wildcards so the query matches as a literal substring. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type SearchRow = {
  resource_type: unknown;
  resource_id: unknown;
  space_id: unknown;
  title: unknown;
  snippet: unknown;
  updated_at: unknown;
  rank: unknown;
};

function toResult(row: SearchRow): SearchResult {
  const type = String(row.resource_type);
  if (!isResourceType(type)) throw new StoreError('search: unknown resource type');
  return {
    resource_type: type,
    resource_id: String(row.resource_id),
    space_id: String(row.space_id),
    title: String(row.title),
    snippet: String(row.snippet),
    updated_at: Number(row.updated_at),
    rank: Number(row.rank),
  };
}

/** `spaceId` narrows to one space, `types` to a subset of the four; `limit` is 1..50 (default 20). */
export async function searchResources(
  db: Db,
  userId: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const query = options.query.trim();
  if (query.length === 0) return [];
  const wanted = options.types ?? [...RESOURCE_TYPES];
  if (wanted.length === 0) return [];
  const limit = options.limit === undefined ? 20 : Math.max(1, Math.min(options.limit, 50));

  const pattern = `%${escapeLike(query)}%`;
  const params: unknown[] = [query, pattern];
  const spaceIdx = options.spaceId ? params.push(options.spaceId) : null;
  const limitIdx = params.push(limit);
  const spaceClause = (alias: string): string =>
    spaceIdx === null ? '' : ` AND ${alias}.space_id = $${spaceIdx}`;

  const fragments: string[] = [];
  if (wanted.includes('task')) {
    fragments.push(`SELECT 'task' AS resource_type, t.id::text AS resource_id, t.space_id,
      t.title AS title, coalesce(t.body, '') AS snippet,
      floor(extract(epoch from t.updated_at) * 1000)::bigint AS updated_at,
      CASE
        WHEN lower(t.title) = lower($1) THEN 1
        WHEN t.title ILIKE $2 THEN 2
        WHEN t.body ILIKE $2 THEN 3
        ELSE 4
      END AS rank
      FROM bob.tasks t
      WHERE (t.title ILIKE $2 OR t.body ILIKE $2) AND t.trashed_at IS NULL${spaceClause('t')}
        AND NOT EXISTS (SELECT 1 FROM bob.spaces sa WHERE sa.id = t.space_id AND sa.archived_at IS NOT NULL)`);
  }
  if (wanted.includes('note')) {
    fragments.push(`SELECT 'note' AS resource_type, n.id::text AS resource_id, n.space_id,
      n.title AS title, n.body AS snippet,
      floor(extract(epoch from n.updated_at) * 1000)::bigint AS updated_at,
      CASE
        WHEN lower(n.title) = lower($1) THEN 1
        WHEN n.title ILIKE $2 THEN 2
        WHEN n.body ILIKE $2 THEN 3
        ELSE 4
      END AS rank
      FROM bob.notes n
      WHERE (n.title ILIKE $2 OR n.body ILIKE $2) AND n.trashed_at IS NULL${spaceClause('n')}
        AND NOT EXISTS (SELECT 1 FROM bob.spaces sa WHERE sa.id = n.space_id AND sa.archived_at IS NOT NULL)`);
  }
  if (wanted.includes('event')) {
    fragments.push(`SELECT 'event' AS resource_type, e.id::text AS resource_id, e.space_id,
      e.title AS title, coalesce(e.body, '') AS snippet,
      floor(extract(epoch from e.updated_at) * 1000)::bigint AS updated_at,
      CASE
        WHEN lower(e.title) = lower($1) THEN 1
        WHEN e.title ILIKE $2 THEN 2
        ELSE 3
      END AS rank
      FROM bob.calendar_events e
      WHERE e.title ILIKE $2 AND e.status <> 'cancelled'${spaceClause('e')}
        AND NOT EXISTS (SELECT 1 FROM bob.spaces sa WHERE sa.id = e.space_id AND sa.archived_at IS NOT NULL)`);
  }
  if (wanted.includes('thread')) {
    fragments.push(`SELECT 'thread' AS resource_type, th.id AS resource_id, th.space_id,
      th.title AS title, '' AS snippet,
      floor(extract(epoch from th.updated_at) * 1000)::bigint AS updated_at,
      CASE
        WHEN lower(th.title) = lower($1) THEN 1
        WHEN th.title ILIKE $2 THEN 2
        ELSE 3
      END AS rank
      FROM bob.conversations th
      WHERE ${sharedScope('th')} AND th.title ILIKE $2 AND th.archived_at IS NULL${spaceClause('th')}
        AND NOT EXISTS (SELECT 1 FROM bob.spaces sa WHERE sa.id = th.space_id AND sa.archived_at IS NOT NULL)`);
  }

  const sql = `${fragments.join(' UNION ALL ')}
    ORDER BY rank ASC, updated_at DESC, resource_id ASC
    LIMIT $${limitIdx}`;
  const rows = await withUser(db, userId, (tx) => tx.query<SearchRow>(sql, params));
  return rows.map(toResult);
}