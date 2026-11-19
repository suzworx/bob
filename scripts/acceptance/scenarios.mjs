// #459 acceptance replay: the sentences the owner said to the running app, and
// what the DATABASE (or the turn's journal line) must show afterwards. Data
// only -- replay.mjs owns every check kind. `{later}` in a sentence is filled
// with a wall-clock time later today in the account's zone (e.g. "4:15 PM").
//
// Check kinds (see replay.mjs evaluateChecks):
//   reminder_at   one new reminder due at the `{later}` local time
//   reminder_rrule a new reminder whose rrule has this freq and interval (and
//                 `window`, when given; a rule without one has the default)
//   reminder_listed GET /api/spaces/:id/reminders (private space) lists a new
//                 reminder due at `tomorrow` ("HH:MM" local) tomorrow
//   timer_listed  GET /api/timers lists a new timer called `label` with
//                 remaining_ms in [minMs, maxMs]; DELETE /api/timers/:id removes it
//   timer_pending a new pending timer lasting about `seconds`
//   no_new        no new row of `table` (optionally only of `kinds`)
//   no_new_memory the scenario's own conversation created no memory of any
//                 kind; a failure names the kinds and counts, never the content.
//                 Every sentence that is a request, not a statement about the
//                 person, carries it (ACCEPT-MEM; docs/investigations/replay-memories.md)
//   no_false_claim the reply does not claim a reminder was set (judged with
//                 `criteria`) unless a new reminder or task row exists
//   called_tool   `tool` is in that turn's journal called_tools
//   judge         the judge model scores the reply against `criteria` (>= 0.7);
//                 `context: 'diet_facts'` hands it the account's saved facts

const DIET_CRITERIA = 'The reply respects every dietary restriction in the user\'s saved facts. If the facts say the user is'
  + ' vegetarian or vegan (or otherwise avoids chicken), a reply that says chicken is fine fails; a reply that'
  + ' reminds them of the restriction or offers alternatives passes.';

const NO_MEMORY = Object.freeze({ kind: 'no_new_memory' });

/** @type {ReadonlyArray<{ id: string, text: string, checks: ReadonlyArray<Record<string, unknown>>, expectedFail?: string }>} */
export const SCENARIOS = Object.freeze([
  {
    id: 'reminder-today',
    text: 'remember to water the plants today at {later}',
    checks: [{ kind: 'reminder_at' }, NO_MEMORY],
  },
  {
    id: 'reminder-hourly',
    text: 'remind me to have water every hour',
    checks: [{ kind: 'reminder_rrule', freq: 'hourly', interval: 1, window: { start: '08:00', end: '22:00' } }, NO_MEMORY],
  },
  {
    id: 'calendar-reminders',
    text: 'remind me to call mom tomorrow at 10 am',
    checks: [{ kind: 'reminder_listed', tomorrow: '10:00' }, NO_MEMORY],
  },
  {
    id: 'timers-api',
    text: 'set a timer for 3 minutes called tea',
    checks: [{ kind: 'timer_listed', label: 'tea', minMs: 150_000, maxMs: 180_000 }, NO_MEMORY],
  },
  {
    id: 'no-false-claim',
    text: 'remind me to stretch',
    checks: [{
      kind: 'no_false_claim',
      criteria: 'Score 1 if the reply states or implies that a reminder (or task) has been set, scheduled or saved;'
        + ' score 0 if it only asks when, offers to set one, or otherwise does not claim one exists.',
    }, NO_MEMORY],
  },
  {
    id: 'diet-standing',
    text: 'can I have chicken tonight',
    checks: [{ kind: 'judge', context: 'diet_facts', criteria: DIET_CRITERIA }, NO_MEMORY],
  },
  {
    id: 'timer-2min',
    text: 'set a timer for 2 minutes',
    checks: [{ kind: 'timer_pending', seconds: 120 }, NO_MEMORY],
  },
  {
    id: 'time-new-york',
    text: 'what time is it in New York',
    checks: [NO_MEMORY],
  },
  {
    id: 'diet-chicken',
    text: 'can I have chicken tonight',
    checks: [{ kind: 'judge', context: 'diet_facts', criteria: DIET_CRITERIA }, NO_MEMORY],
  },
  {
    id: 'list-reminders',
    text: 'what reminders do I have',
    checks: [{ kind: 'called_tool', tool: 'list_reminders' }, NO_MEMORY],
  },
]);
