import { describe, expect, it } from 'vitest';
import {
  aggregateRuns, evaluateChecks, exitCode, fillText, formatRepeatTable, formatTable, laterToday, memoryKinds, normaliseCategory, parseArgs,
  parseChatStream, parseRrule, scenarioMemories, selectCleanup, tomorrowAt, turnCalledTools, verdict, whyPrompt, WHY_CATEGORIES, withRetry,
} from './replay.mjs';
import { SCENARIOS } from './scenarios.mjs';

const byId = (id) => SCENARIOS.find((s) => s.id === id);
const empty = () => ({ reminders: [], timers: [], memories: [] });
const RUN = Date.parse('2026-09-25T20:00:00Z');

describe('scenarios', () => {
  it('are data with unique ids and only known check kinds', () => {
    const kinds = new Set(['reminder_at', 'reminder_rrule', 'reminder_listed', 'timer_listed', 'timer_pending', 'no_new', 'no_new_memory',
      'no_false_claim', 'called_tool', 'judge']);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) for (const c of s.checks) expect(kinds.has(c.kind)).toBe(true);
    expect(byId('reminder-hourly').expectedFail).toBeUndefined(); // #456 landed
  });
  it('every sentence is a request, so every scenario expects no new memory (ACCEPT-MEM)', () => {
    for (const s of SCENARIOS) expect(s.checks.map((c) => c.kind), s.id).toContain('no_new_memory');
  });
});

describe('no_new_memory', () => {
  const check = { id: 'x', text: 'x', checks: [{ kind: 'no_new_memory' }] };
  const mem = (id, kind, conversationId) => ({ id, kind, conversationId, content: `SECRET ${id}` });
  it('counts only the scenario\'s own conversation and names kinds, never content', () => {
    const rows = { ...empty(), memories: [mem('a', 'fact', 'cnv_1'), mem('b', 'intent', 'cnv_1'), mem('c', 'fact', 'cnv_1'), mem('d', 'fact', 'cnv_2')] };
    const why = evaluateChecks(check, { rows, conversationId: 'cnv_1' });
    expect(why).toBe('3 new memories (fact 2, intent 1)');
    expect(why).not.toMatch(/SECRET/);
    expect(evaluateChecks(check, { rows, conversationId: 'cnv_3' })).toBeNull();
    expect(scenarioMemories({ rows })).toHaveLength(4); // no conversation id: every new row counts
  });
  it('memoryKinds is "-" for none and the table shows the column', () => {
    expect(memoryKinds([])).toBe('-');
    expect(formatTable([{ id: 'a', status: 'fail', text: 'hi', memories: 'intent 1', why: '1 new memories (intent 1)' }]))
      .toMatch(/\| new_memories \| why/);
    expect(formatTable([{ id: 'a', status: 'pass', text: 'hi', memories: '-', why: '' }])).toMatch(/\| hi +\| - +\|/);
  });
});

describe('parseRrule', () => {
  it('reads the jsonb object and the JSON-string shape; anything else is null', () => {
    const rule = { freq: 'hourly', interval: 1, window: { start: '08:00', end: '22:00' } };
    expect(parseRrule(rule)).toEqual(rule);
    expect(parseRrule(JSON.stringify(rule))).toEqual(rule);
    for (const bad of [null, undefined, '', '{nope', '"daily"', '[1]', 5]) expect(parseRrule(bad)).toBeNull();
  });
});

describe('tomorrowAt', () => {
  it('is the wall-clock time tomorrow in the zone, across a DST change', () => {
    expect(tomorrowAt(Date.parse('2026-09-25T20:00:00Z'), 'America/Los_Angeles', '10:00').dueAtMs).toBe(Date.parse('2026-09-26T17:00:00Z'));
    expect(tomorrowAt(Date.parse('2026-09-25T20:00:00Z'), 'Asia/Kolkata', '10:00').dueAtMs).toBe(Date.parse('2026-09-27T04:30:00Z')); // already the 26th there
    // PDT -> PST on 2026-11-01
    expect(tomorrowAt(Date.parse('2026-10-31T20:00:00Z'), 'America/Los_Angeles', '10:00').dueAtMs).toBe(Date.parse('2026-11-01T18:00:00Z'));
  });
});

describe('withRetry', () => {
  it('keeps the retry verdict and marks the row flaky', () => {
    expect(withRetry({ id: 'a', status: 'pass', text: 'hi', why: '' })).toEqual({ id: 'a', status: 'pass', text: 'hi', why: 'flaky: stream error', tries: 2 });
    expect(withRetry({ id: 'a', status: 'fail', text: 'hi', why: 'turn failed (stream error)', streamError: true }))
      .toEqual({ id: 'a', status: 'fail', text: 'hi', why: 'flaky: stream error; turn failed (stream error)', tries: 2 });
    expect(formatTable([withRetry({ id: 'a', status: 'pass', text: 'hi', why: '' })])).toMatch(/\| a +\| pass +\| 2 +\|/);
  });
});

describe('parseArgs', () => {
  it('reads --only and --keep and refuses unknown flags or scenarios', () => {
    expect(parseArgs(['--only', 'timer-2min', '--keep'])).toMatchObject({ only: ['timer-2min'], keep: true, port: 7444, repeat: 1, why: false });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--only', 'nope'])).toThrow(/no scenario/);
  });
  it('reads a comma list for --only, --repeat N and --why', () => {
    expect(parseArgs(['--only', 'reminder-hourly, diet-chicken', '--repeat', '10', '--why']))
      .toMatchObject({ only: ['reminder-hourly', 'diet-chicken'], repeat: 10, why: true });
    expect(() => parseArgs(['--only', 'diet-chicken,nope'])).toThrow(/no scenario nope/);
    for (const bad of ['0', '2.5', 'x', '51']) expect(() => parseArgs(['--repeat', bad])).toThrow(/--repeat/);
    expect(() => parseArgs(['--repeat'])).toThrow(/needs a value/);
  });
});

describe('--why categories', () => {
  it('keeps a known category and maps anything else to other', () => {
    expect(normaliseCategory(' Called-Tool ')).toBe('called-tool');
    for (const bad of ['maybe', '', null, 3]) expect(normaliseCategory(bad)).toBe('other');
    expect(WHY_CATEGORIES).toContain('ignored-constraint');
  });
  it('the prompt names the tools and includes facts only when given', () => {
    const base = { text: 'remind me', calledTools: '', reply: 'ok' };
    expect(whyPrompt(base)).toContain('Tools called this turn: none');
    expect(whyPrompt(base)).not.toContain('Saved facts');
    expect(whyPrompt({ ...base, calledTools: 'create_reminder', facts: '- x' })).toMatch(/create_reminder[\s\S]*Saved facts about the person:\n- x/);
  });
});

describe('aggregateRuns', () => {
  it('counts passes, categories and called tools per scenario, in order, without reply text', () => {
    const summary = aggregateRuns([
      { id: 'b', status: 'pass', category: 'called-tool', calledTools: 'create_reminder,currentDateTime', text: 's', why: '' },
      { id: 'a', status: 'fail', category: 'asked-clarifying-question', calledTools: '', text: 's', why: 'x' },
      { id: 'b', status: 'fail', category: 'asked-clarifying-question', calledTools: '', text: 's', why: 'x' },
      { id: 'b', status: 'pass', category: 'called-tool', calledTools: 'create_reminder', text: 's', why: '' },
      { id: 'a', status: 'expected-fail', text: 's', why: 'harness error' },
    ]);
    expect(summary).toEqual([
      { id: 'b', runs: 3, pass: 2, fail: 1, other: 0, categories: { 'called-tool': 2, 'asked-clarifying-question': 1 },
        tools: { create_reminder: 2, currentDateTime: 1, none: 1 } },
      { id: 'a', runs: 2, pass: 0, fail: 1, other: 1, categories: { 'asked-clarifying-question': 1 }, tools: { none: 1 } },
    ]);
    const table = formatRepeatTable(summary);
    expect(table).toMatch(/\| b +\| 2\/3 +\| called-tool 2, asked-clarifying-question 1 +\| create_reminder 2, currentDateTime 1, none 1 \|/);
    expect(table).toMatch(/\| a +\| 0\/2 /);
    expect(formatRepeatTable(aggregateRuns([{ id: 'c', status: 'pass' }]))).toMatch(/\| c +\| 1\/1 +\| - +\| - +\|/);
  });
});

describe('laterToday', () => {
  it('picks a quarter hour at least an hour ahead in the zone', () => {
    // 13:07 PDT -> 14:15 PDT = 21:15Z
    const later = laterToday(Date.parse('2026-09-25T20:07:30Z'), 'America/Los_Angeles');
    expect(later).toEqual({ label: '2:15 PM', dueAtMs: Date.parse('2026-09-25T21:15:00Z') });
    expect(fillText('remember to x today at {later}', { later: later.label })).toBe('remember to x today at 2:15 PM');
  });
  it('is null when that would be tomorrow', () => {
    expect(laterToday(Date.parse('2026-09-25T23:10:00Z'), 'UTC')).toBeNull();
  });
});

describe('parseChatStream', () => {
  it('collects the reply and the conversation id from SSE parts', () => {
    const raw = [
      'data: {"type":"start","messageMetadata":{"createdAt":1,"conversationId":"cnv_abc"}}',
      'data: {"type":"text-delta","id":"t","delta":"Hello "}', '', 'data: {"type":"text-delta","id":"t","delta":"there"}',
      'data: not json', 'data: [DONE]',
    ].join('\n');
    expect(parseChatStream(raw)).toEqual({ conversationId: 'cnv_abc', reply: 'Hello there', error: null });
    expect(parseChatStream('data: {"type":"error","errorText":"boom"}').error).toBe('boom');
  });
});

describe('turnCalledTools', () => {
  it('reads the turn\'s agent_completed line only', () => {
    const journal = [
      JSON.stringify({ event: 'v2.turn_stage_agent_completed', turn_id: 'other', called_tools: 'set_timer' }),
      '{"event":"v2.turn_stage_agent_completed","turn_id":"torn',
      JSON.stringify({ event: 'v2.turn_stage_agent_started', turn_id: 't1' }),
      JSON.stringify({ event: 'v2.turn_stage_agent_completed', turn_id: 't1', called_tools: 'list_reminders,currentDateTime' }),
    ].join('\n');
    expect(turnCalledTools(journal, 't1')).toBe('list_reminders,currentDateTime');
    expect(turnCalledTools(journal, 'missing')).toBeNull();
  });
});

describe('evaluateChecks', () => {
  const later = { label: '2:15 PM', dueAtMs: RUN + 3_600_000 };
  it('reminder-today: one reminder at the time and no memory', () => {
    const rows = { ...empty(), reminders: [{ id: 'r1', dueAt: later.dueAtMs, rrule: null }] };
    expect(evaluateChecks(byId('reminder-today'), { rows, later })).toBeNull();
    expect(evaluateChecks(byId('reminder-today'), { rows: { ...rows, memories: [{ id: 'm', kind: 'intent' }] }, later })).toBe('1 new memories (intent 1)');
    expect(evaluateChecks(byId('reminder-today'), { rows: empty(), later })).toMatch(/expected 1 reminder at 2:15 PM, got 0/);
  });
  it('reminder-hourly needs an hourly rrule in the 08:00-22:00 window, stored as an object or a JSON string', () => {
    const s = byId('reminder-hourly');
    const one = (rrule) => ({ rows: { ...empty(), reminders: [{ id: 'r', rrule }] } });
    const hourly = { freq: 'hourly', interval: 1, window: { start: '08:00', end: '22:00' } };
    expect(evaluateChecks(s, one({ freq: 'daily' }))).toMatch(/hourly/);
    expect(evaluateChecks(s, one(hourly))).toBeNull();
    expect(evaluateChecks(s, one(JSON.stringify(hourly)))).toBeNull();
    expect(evaluateChecks(s, one({ freq: 'hourly' }))).toBeNull(); // no window = the default
    expect(evaluateChecks(s, one({ ...hourly, window: { start: '09:00', end: '17:00' } }))).toBe('window 09:00-17:00, expected 08:00-22:00');
    expect(evaluateChecks(s, one('{not json'))).toMatch(/no new reminder/);
  });
  it('calendar-reminders: one newly listed reminder at 10:00 tomorrow', () => {
    const s = byId('calendar-reminders');
    const tomorrow = { dueAtMs: RUN + 86_400_000 };
    expect(evaluateChecks(s, { rows: empty(), tomorrow, api: { reminders: [{ id: 'r', due_at: tomorrow.dueAtMs }] } })).toBeNull();
    expect(evaluateChecks(s, { rows: empty(), tomorrow, api: { reminders: [{ id: 'r', due_at: RUN }] } }))
      .toBe('expected 1 listed reminder at 10:00 tomorrow, got 0 (new listed: 1)');
    expect(evaluateChecks(s, { rows: empty(), tomorrow, api: {} })).toBe('reminders API not read');
  });
  it('timers-api: "tea" listed with 150-180 s left, gone after DELETE', () => {
    const s = byId('timers-api');
    const api = (remaining, gone) => ({ rows: empty(), api: { timers: [{ id: 't', label: ' Tea ', remaining_ms: remaining }], timerGone: gone, deleteStatus: 200 } });
    expect(evaluateChecks(s, api(170_000, true))).toBeNull();
    expect(evaluateChecks(s, api(100_000, true))).toBe('remaining_ms 100000 outside 150000-180000');
    expect(evaluateChecks(s, api(170_000, false))).toBe('still listed after DELETE (status 200)');
    expect(evaluateChecks(s, { rows: empty(), api: { timers: [] } })).toBe('no listed timer called tea (new listed: 0)');
  });
  it('no-false-claim: a claimed reminder needs a reminder or task row', () => {
    const s = byId('no-false-claim');
    expect(evaluateChecks(s, { rows: empty(), claim: { score: 0.1 } })).toBeNull();
    expect(evaluateChecks(s, { rows: empty(), claim: { score: 0.9 } })).toMatch(/claims a reminder/);
    expect(evaluateChecks(s, { rows: { ...empty(), tasks: [{ id: 'k' }] }, claim: { score: 0.9 } })).toBeNull();
    expect(evaluateChecks(s, { rows: empty() })).toBe('claim judge did not run');
  });
  it('diet-standing: judge passes and no memory of any kind (the question is not a fact)', () => {
    const s = byId('diet-standing');
    expect(evaluateChecks(s, { rows: empty(), judge: { score: 0.9 } })).toBeNull();
    expect(evaluateChecks(s, { rows: { ...empty(), memories: [{ id: 'm', kind: 'fact' }] }, judge: { score: 0.9 } })).toBe('1 new memories (fact 1)');
    expect(evaluateChecks(s, { rows: { ...empty(), memories: [{ id: 'm', kind: 'action_item' }] }, judge: { score: 0.9 } }))
      .toBe('1 new memories (action_item 1)');
  });
  it('timer-2min needs a pending two-minute timer', () => {
    const timer = (status, seconds) => ({ ...empty(), timers: [{ id: 't', status, createdAt: RUN, firesAt: RUN + seconds * 1000 }] });
    expect(evaluateChecks(byId('timer-2min'), { rows: timer('pending', 120) })).toBeNull();
    expect(evaluateChecks(byId('timer-2min'), { rows: timer('cancelled', 120) })).toMatch(/no pending/);
    expect(evaluateChecks(byId('timer-2min'), { rows: timer('pending', 600) })).toMatch(/no pending/);
  });
  it('diet-chicken: judge score and no new memory of any kind', () => {
    const s = byId('diet-chicken');
    expect(evaluateChecks(s, { rows: empty(), judge: { score: 0.9 } })).toBeNull();
    expect(evaluateChecks(s, { rows: empty(), judge: { score: 0.2 } })).toBe('judge scored 0.20 < 0.7');
    expect(evaluateChecks(s, { rows: { ...empty(), memories: [{ id: 'm', kind: 'intent' }] }, judge: { score: 1 } })).toBe('1 new memories (intent 1)');
  });
  it('list-reminders: list_reminders in called_tools', () => {
    const s = byId('list-reminders');
    expect(evaluateChecks(s, { rows: empty(), calledTools: 'list_reminders' })).toBeNull();
    expect(evaluateChecks(s, { rows: empty(), calledTools: '' })).toBe('list_reminders not called (called: none)');
    expect(evaluateChecks(s, { rows: empty(), calledTools: null })).toBe('turn not found in the journal');
  });
});

describe('verdict and exit code', () => {
  it('only an unexpected fail fails the run', () => {
    const known = { id: 'k', text: 'x', checks: [], expectedFail: '#999' };
    expect(verdict(known, 'nope').status).toBe('expected-fail');
    expect(verdict(known, null)).toEqual({ status: 'pass', why: 'now passes; drop expectedFail #999' });
    expect(verdict(byId('timer-2min'), 'nope')).toEqual({ status: 'fail', why: 'nope' });
    expect(exitCode([{ status: 'pass' }, { status: 'expected-fail' }, { status: 'skipped' }])).toBe(0);
    expect(exitCode([{ status: 'pass' }, { status: 'fail' }])).toBe(1);
    expect(formatTable([{ id: 'a', status: 'pass', text: 'hi', why: '' }]).split('\n')).toHaveLength(3);
  });
});

describe('selectCleanup', () => {
  it('never selects rows older than the run, cancelled reminders, non-pending timers or other conversations\' memories', () => {
    const rows = {
      reminders: [{ id: 'old', createdAt: RUN - 1, status: 'active' }, { id: 'new', createdAt: RUN, status: 'active' }, { id: 'gone', createdAt: RUN + 5, status: 'cancelled' }],
      timers: [{ id: 'old-t', createdAt: RUN - 1000, status: 'pending' }, { id: 'new-t', createdAt: RUN + 1, status: 'pending' }, { id: 'fired', createdAt: RUN + 1, status: 'fired' }],
      memories: [
        { id: 'owner-m', createdAt: RUN - 60_000, conversationId: 'cnv_run' },
        { id: 'owner-now', createdAt: RUN + 2, conversationId: 'cnv_owner' },
        { id: 'run-m', createdAt: RUN + 2, conversationId: 'cnv_run' },
      ],
    };
    expect(selectCleanup(rows, RUN, ['cnv_run'])).toEqual({ reminders: ['new'], timers: ['new-t'], memories: ['run-m'] });
  });
});
