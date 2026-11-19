import { RoutineUpdateSchema } from '../../src/routines/schemas.ts';
import { nextRoutineRun } from '../../src/routines/schedule.ts';
import { expect, it } from 'vitest';
it('keeps a Monday-only routine on Monday across DST', () => {
  const schedule = { localTime: '09:00', timeZone: 'America/Los_Angeles', weekdays: [1] };
  expect(new Date(nextRoutineRun(schedule, Date.parse('2026-10-26T16:00:00Z'))).toISOString()).toBe('2026-11-02T17:00:00.000Z');
});

it('does not reset omitted preferences when pausing or editing one field', () => {
 expect(RoutineUpdateSchema.parse({ expectedRevision: 1, status: 'paused' })).toEqual({ expectedRevision: 1, status: 'paused' });
 expect(() => RoutineUpdateSchema.parse({ expectedRevision: 1 })).toThrow();
});
