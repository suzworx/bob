import { describe, expect, it } from 'vitest';
import { RoutineCreateSchema, RoutineUpdateSchema } from '../../src/routines/schemas.ts';

const input = {
  kind: 'daily_gmail_digest', googleAccountId: '00000000-0000-4000-8000-000000000001',
  localTime: '08:00', timeZone: 'America/Los_Angeles', scheduledReadConsent: true,
};

describe('routine command schemas', () => {
  it('accepts explicit scheduled reads for one account', () => {
    expect(RoutineCreateSchema.parse(input)).toEqual({
      ...input, name: 'Email recap', gmailQuery: '', instructions: '', summaryStyle: 'concise', emailResult: false,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
    });
  });
  it.each([
    { scheduledReadConsent: false }, { scheduledReadConsent: undefined }, { userId: input.googleAccountId },
    { prompt: 'send mail' }, { query: 'anything' }, { timeZone: 'not/a-zone' }, { localTime: '8:00' },
    { localTime: '24:01' }, { googleAccountId: 'auto' }, { kind: 'send_email' }, { timeZone: '+01:00' },
  ])('rejects unsafe or ambiguous creation %j', (patch) => {
    expect(RoutineCreateSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('requires revision and a change; cannot retarget another account', () => {
    expect(RoutineUpdateSchema.safeParse({ status: 'paused' }).success).toBe(false);
    expect(RoutineUpdateSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(RoutineUpdateSchema.safeParse({ expectedRevision: 1, googleAccountId: input.googleAccountId }).success).toBe(false);
    expect(RoutineUpdateSchema.parse({ expectedRevision: 1, status: 'paused' })).toEqual({ expectedRevision: 1, status: 'paused' });
  });
});
