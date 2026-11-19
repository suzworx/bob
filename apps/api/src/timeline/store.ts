import { withUser, type Db } from '../platform/db/db.ts';
import { TimelineQuerySchema, TimelineResponseSchema, type TimelineQuery, type TimelineResponse } from './schemas.ts';

// Existing records provide real timestamps, not a reconstructed edit log. RLS
// applies independently to every source and excludes revoked memberships.
const ACTIVITY = `
select 'routine:'||x.id as id, 'routine' as kind, 'scheduled' as action,
  r.name as title, x.scheduled_at as happened, x.id::text as record_id,
  null::text as space_id, r.id::text as routine_id, x.state as status, 1::bigint as count
from bob.routine_runs x join bob.routines r on r.id=x.routine_id
where x.user_id=$1
union all
select 'conversation:'||c.id, 'conversation', 'conversation', c.title,
  max(m.created_at), c.id, case when s.kind = 'private' then null else c.space_id::text end, null, null, count(*)
from bob.messages m join bob.conversations c on c.id=m.conversation_id
join bob.spaces s on s.id=c.space_id
where m.tombstoned_at is null and c.archived_at is null
  and m.created_at >= ($2::date::timestamp at time zone $3)
  and m.created_at < (($2::date + 1)::timestamp at time zone $3)
group by c.id, s.kind
union all
select 'task-created:'||id, 'task', 'created', title, created_at, id::text,
  space_id::text, null, status, 1 from bob.tasks where trashed_at is null
union all
select 'task-completed:'||id, 'task', 'completed', title, completed_at, id::text,
  space_id::text, null, status, 1 from bob.tasks where trashed_at is null and completed_at is not null
union all
select 'note-created:'||id, 'note', 'created', title, created_at, id::text,
  space_id::text, null, null, 1 from bob.notes where trashed_at is null
union all
select 'note-updated:'||id, 'note', 'updated', title, updated_at, id::text,
  space_id::text, null, null, 1 from bob.notes where trashed_at is null and revision > 1
union all
select 'event-created:'||id, 'event', 'created', title, created_at, id::text,
  space_id::text, null, status, 1 from bob.calendar_events
`;

export async function listTimeline(db: Db, userId: string, input: TimelineQuery): Promise<TimelineResponse> {
  const query = TimelineQuerySchema.parse(input);
  const rows = await withUser(db, userId, tx => tx.query<Record<string, unknown>>(`
    with activity as (${ACTIVITY})
    select id, kind, action, title, floor(extract(epoch from happened)*1000)::bigint as at,
      record_id as "recordId", space_id as "spaceId", routine_id as "routineId", status, count
    from activity
    where happened >= ($2::date::timestamp at time zone $3)
      and happened < (($2::date + 1)::timestamp at time zone $3)
      and ($4='all' or kind=$4)
      and ($5::bigint is null or (floor(extract(epoch from happened)*1000)::bigint,id) < ($5::bigint,$6::text))
    order by at desc,id desc limit $7`,
  [userId, query.day, query.timeZone, query.kind, query.before ?? null, query.beforeId ?? null, query.limit + 1]));
  const entries = rows.slice(0, query.limit).map(row => ({ ...row, id: String(row.id), at: Number(row.at), count: Number(row.count) }));
  const last = entries.at(-1);
  return TimelineResponseSchema.parse({ day: query.day, timeZone: query.timeZone, entries,
    nextCursor: rows.length > query.limit && last ? { before: last.at, beforeId: last.id } : null });
}
