import { asServer, type Db } from '../platform/db/db.ts';
import { nextRoutineRun } from './schedule.ts';

type Due = { weekdays: number[]; id: string; revision: number; local_time: string; time_zone: string; next_run_at: Date | string };

/** Only discovers/enqueues durable intent. pg-boss alone executes the work. */
export async function dispatchRoutines(db: Db, now: number): Promise<number> {
  await asServer(db, (tx) => tx.query('select bob_private.routine_prune($1)', [new Date(now)]));
  const due = await asServer(db, (tx) => tx.query<Due>('select * from bob_private.routines_due($1)', [new Date(now)]));
  let count = 0;
  for (const routine of due) {
    const schedule = { localTime: routine.local_time, timeZone: routine.time_zone, weekdays: routine.weekdays };
    const next = nextRoutineRun(schedule, now);
    // At most three daily occurrences in this 48-hour window, including DST.
    let scheduled = nextRoutineRun(schedule, now - 8 * 86400000);
    for (let index = 0; index < 9; index += 1) {
      const candidate = nextRoutineRun(schedule, scheduled);
      if (candidate > now) break;
      scheduled = candidate;
    }
    if (scheduled < new Date(routine.next_run_at).getTime()) scheduled = new Date(routine.next_run_at).getTime();
    const rows = await asServer(db, (tx) => tx.query<{ id: string | null }>(
      'select bob_private.routine_dispatch($1,$2,$3,$4,$5) as id',
      [routine.id, routine.revision, new Date(scheduled), new Date(next), new Date(now)],
    ));
    if (rows[0]?.id) count += 1;
  }
  return count;
}
