// #459 acceptance replay: real sentences through the RUNNING local app
// (POST /api/chat on :7444), checked against the rows the run created in the
// local Supabase database. Usage: npm run accept:replay [-- --only <id,...>] [--repeat N] [--why] [--keep]
// Prints one row per scenario (its own sentence and the verdict); never the
// owner's other data, the reply, the token or any key. See README.md.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

export const JUDGE_PASS = 0.7;
const TIMER_SLACK_MS = 60_000;

/**
 * CLI flags; an unknown flag throws so a typo never runs a silent default.
 * `--only a,b` picks scenarios; `--repeat N` runs each N times (fresh
 * conversation each); `--why` has the judge model categorise every reply.
 */
export function parseArgs(argv) {
  const out = { only: null, keep: false, repeat: 1, why: false, host: 'localhost', port: 7444, settleMs: 15_000, turnTimeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${flag} needs a value`); i += 1; return v; };
    if (flag === '--only') out.only = value().split(',').map((id) => id.trim()).filter((id) => id !== '');
    else if (flag === '--keep') out.keep = true;
    else if (flag === '--why') out.why = true;
    else if (flag === '--repeat') out.repeat = Number(value());
    else if (flag === '--port') out.port = Number(value());
    else if (flag === '--settle-ms') out.settleMs = Number(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  for (const id of out.only ?? []) if (!SCENARIOS.some((s) => s.id === id)) throw new Error(`no scenario ${id}`);
  if (!Number.isInteger(out.repeat) || out.repeat < 1 || out.repeat > 50) throw new Error('--repeat needs a whole number from 1 to 50');
  return out;
}

/**
 * What a reply did, as the --why judge sees it. Only the category and the
 * turn's called tools are kept; the reply itself is never stored or printed.
 */
export const WHY_CATEGORIES = Object.freeze([
  'called-tool', 'asked-clarifying-question', 'refused', 'claimed-without-tool', 'ignored-constraint', 'respected-constraint',
  'answered', 'no-reply',
]);

/** A category the judge returned, or 'other' for anything outside WHY_CATEGORIES. */
export function normaliseCategory(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return WHY_CATEGORIES.includes(text) ? text : 'other';
}

/** The judge prompt for --why: the sentence, the tools the turn called, the saved facts when the scenario uses them. */
export function whyPrompt({ text, calledTools, facts, reply }) {
  return [
    'Categorise what a voice assistant did with one request. Pick exactly one category:',
    '- called-tool: a tool call this turn did what was asked (see the tools list).',
    '- asked-clarifying-question: it asked the person a question instead of acting.',
    '- refused: it said it cannot or will not do it.',
    '- claimed-without-tool: it says or implies it did something that needs a tool, but no such tool was called.',
    '- ignored-constraint: the saved facts hold a restriction the reply contradicts or ignores.',
    '- respected-constraint: the reply applies a restriction from the saved facts.',
    '- answered: any other plain answer.',
    `Tools called this turn: ${calledTools || 'none'}`,
    ...(facts ? [`Saved facts about the person:\n${facts}`] : []),
    `Request: ${text}`,
    `Reply: ${reply}`,
  ].join('\n');
}

/**
 * Per-scenario pass counts over repeated runs, in first-seen order, with the
 * --why categories and called tools counted (never reply text).
 */
export function aggregateRuns(results) {
  const byScenario = new Map();
  for (const r of results) {
    const row = byScenario.get(r.id) ?? { id: r.id, runs: 0, pass: 0, fail: 0, other: 0, categories: {}, tools: {} };
    row.runs += 1;
    if (r.status === 'pass') row.pass += 1;
    else if (r.status === 'fail') row.fail += 1;
    else row.other += 1;
    if (r.category) row.categories[r.category] = (row.categories[r.category] ?? 0) + 1;
    const tools = r.calledTools === undefined || r.calledTools === null ? [] : (r.calledTools === '' ? ['none'] : r.calledTools.split(','));
    for (const tool of tools) row.tools[tool] = (row.tools[tool] ?? 0) + 1;
    byScenario.set(r.id, row);
  }
  return [...byScenario.values()];
}

const counts = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ') || '-';

/** The --repeat summary as a markdown table: counts only. */
export function formatRepeatTable(summary) {
  const head = ['scenario', 'pass', 'categories', 'called_tools'];
  const body = summary.map((s) => [s.id, `${s.pass}/${s.runs}`, counts(s.categories), counts(s.tools)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...body.map(line)].join('\n');
}

/** Wall-clock hour/minute/second of `ms` in `zone`. */
function localClock(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { h: get('hour') % 24, m: get('minute'), s: get('second') };
}

/** A time at least an hour from now, on a quarter hour, still today in `zone`; null late at night. */
export function laterToday(nowMs, zone) {
  const { h, m, s } = localClock(nowMs, zone);
  const nowMin = h * 60 + m;
  const target = Math.ceil((nowMin + 60) / 15) * 15;
  if (target >= 24 * 60) return null;
  const dueAtMs = nowMs - (nowMin * 60 + s) * 1000 - (nowMs % 1000) + target * 60_000;
  const hh = Math.floor(target / 60); const mm = target % 60;
  const label = `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  return { label, dueAtMs };
}

/** Epoch ms of the wall-clock `hhmm` ("10:00") tomorrow in `zone`. */
export function tomorrowAt(nowMs, zone, hhmm) {
  const fields = (at) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
    .filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const offset = (at) => { const f = fields(at); return Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second) - (at - (at % 1000)); };
  const today = fields(nowMs);
  const [h, m] = hhmm.split(':').map(Number);
  const wall = Date.UTC(today.year, today.month - 1, today.day + 1, h, m);
  const guess = wall - offset(wall);
  return { label: `${hhmm} tomorrow`, dueAtMs: wall - offset(guess) };
}

/** The daily window an hourly rule without one uses (#456). */
export const DEFAULT_WINDOW = Object.freeze({ start: '08:00', end: '22:00' });

/** A reminder's rrule as an object: jsonb may hold the object or a JSON string of it; anything else is null. */
export function parseRrule(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function fillText(text, vars) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => (vars[key] === undefined ? whole : vars[key]));
}

/** The AI SDK UI stream (SSE `data:` lines): conversation id, reply text, first error. */
export function parseChatStream(raw) {
  const out = { conversationId: null, reply: '', error: null };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    let part;
    try { part = JSON.parse(data); } catch { continue; }
    if (part.type === 'text-delta' && typeof part.delta === 'string') out.reply += part.delta;
    if (part.type === 'error') out.error ??= typeof part.errorText === 'string' ? part.errorText : 'stream_error';
    const id = part.messageMetadata?.conversationId;
    if (typeof id === 'string') out.conversationId ??= id;
  }
  return out;
}

/** The comma-separated called_tools of the turn's agent_completed journal line; null when absent. */
export function turnCalledTools(journalText, turnId) {
  let found = null;
  for (const line of journalText.split(/\r?\n/)) {
    if (!line.includes(turnId) || !line.includes('"v2.turn_stage_agent_completed"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.turn_id === turnId) found = typeof entry.called_tools === 'string' ? entry.called_tools : '';
    } catch { /* a torn line */ }
  }
  return found;
}

/**
 * The first failing check's reason, or null when all pass. `observed` holds the
 * rows created during the scenario ({ reminders, timers, memories, tasks }), the
 * turn's called tools, the judge and claim-judge results, the `{later}` and
 * `tomorrow` targets, and `api`: what the reminders/timers endpoints newly list.
 */
export function evaluateChecks(scenario, observed) {
  const { rows } = observed;
  for (const check of scenario.checks) {
    const why = evaluateCheck(check, observed, rows);
    if (why !== null) return why;
  }
  return null;
}

function evaluateCheck(check, observed, rows) {
  switch (check.kind) {
    case 'reminder_at': {
      if (!observed.later) return 'no later-today time (too late in the day)';
      const due = rows.reminders.filter((r) => r.dueAt === observed.later.dueAtMs);
      if (due.length === 1) return null;
      return `expected 1 reminder at ${observed.later.label}, got ${due.length} (new reminders: ${rows.reminders.length})`;
    }
    case 'reminder_rrule': {
      const rules = rows.reminders.map((r) => parseRrule(r.rrule)).filter((rule) => rule?.freq === check.freq && (rule.interval ?? 1) === check.interval);
      if (rules.length === 0) return `no new reminder repeating ${check.freq}/${check.interval} (new reminders: ${rows.reminders.length})`;
      if (!check.window) return null;
      const want = `${check.window.start}-${check.window.end}`;
      const got = rules.map((rule) => { const w = rule.window ?? DEFAULT_WINDOW; return `${w.start}-${w.end}`; });
      return got.includes(want) ? null : `window ${got.join(',')}, expected ${want}`;
    }
    case 'reminder_listed': {
      const listed = observed.api?.reminders;
      if (!listed) return 'reminders API not read';
      const hit = listed.filter((r) => r.due_at === observed.tomorrow?.dueAtMs);
      if (hit.length === 1) return null;
      return `expected 1 listed reminder at ${check.tomorrow} tomorrow, got ${hit.length} (new listed: ${listed.length})`;
    }
    case 'timer_listed': {
      const listed = observed.api?.timers;
      if (!listed) return 'timers API not read';
      const hit = timerCalled(listed, check.label);
      if (!hit) return `no listed timer called ${check.label} (new listed: ${listed.length})`;
      if (hit.remaining_ms < check.minMs || hit.remaining_ms > check.maxMs) {
        return `remaining_ms ${hit.remaining_ms} outside ${check.minMs}-${check.maxMs}`;
      }
      return observed.api.timerGone === true ? null : `still listed after DELETE (status ${observed.api.deleteStatus ?? 'none'})`;
    }
    case 'no_false_claim': {
      if (!observed.claim) return 'claim judge did not run';
      const claimed = observed.claim.score >= JUDGE_PASS;
      const created = rows.reminders.length + (rows.tasks?.length ?? 0);
      return claimed && created === 0 ? 'reply claims a reminder was set but no reminder or task row was created' : null;
    }
    case 'timer_pending':
      return rows.timers.some((t) => t.status === 'pending' && Math.abs(t.firesAt - (t.createdAt + check.seconds * 1000)) <= TIMER_SLACK_MS)
        ? null : `no pending ${check.seconds}s timer (new timers: ${rows.timers.length})`;
    case 'no_new': {
      const hit = rows[check.table].filter((r) => !check.kinds || check.kinds.includes(r.kind));
      return hit.length === 0 ? null : `${hit.length} new ${check.table}${check.kinds ? ` (${check.kinds.join(',')})` : ''}`;
    }
    case 'no_new_memory': { // kind and count only: the content is never read here
      const mine = scenarioMemories(observed);
      return mine.length === 0 ? null : `${mine.length} new memories (${memoryKinds(mine)})`;
    }
    case 'called_tool':
      if (observed.calledTools === null) return 'turn not found in the journal';
      return observed.calledTools.split(',').includes(check.tool) ? null : `${check.tool} not called (called: ${observed.calledTools || 'none'})`;
    case 'judge':
      if (!observed.judge) return 'judge did not run';
      // The rationale may quote the owner's facts, so only the score is reported.
      return observed.judge.score >= JUDGE_PASS ? null : `judge scored ${observed.judge.score.toFixed(2)} < ${JUDGE_PASS}`;
    default:
      return `unknown check ${check.kind}`;
  }
}

/**
 * The new memories this scenario's own conversation created: another
 * scenario's late extraction landing in this time window is not counted.
 */
export function scenarioMemories(observed) {
  const all = observed.rows?.memories ?? [];
  return observed.conversationId ? all.filter((m) => m.conversationId === observed.conversationId) : all;
}

/** Memory kinds with counts ("fact 1, intent 2"), '-' for none; never the content. */
export function memoryKinds(memories) {
  const byKind = {};
  for (const m of memories) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  return Object.keys(byKind).sort().map((kind) => `${kind} ${byKind[kind]}`).join(', ') || '-';
}

/** The listed timer whose label is `label` (case and spacing ignored). */
function timerCalled(timers, label) {
  return timers.find((t) => (t.label ?? '').trim().toLowerCase() === label.toLowerCase());
}

/** pass / fail / expected-fail; an expected-fail scenario that passes is a pass the owner should hear about. */
export function verdict(scenario, why) {
  if (why === null) return { status: 'pass', why: scenario.expectedFail ? `now passes; drop expectedFail ${scenario.expectedFail}` : '' };
  if (scenario.expectedFail) return { status: 'expected-fail', why: `${scenario.expectedFail}: ${why}` };
  return { status: 'fail', why };
}

export function exitCode(results) {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

/**
 * What cleanup may touch: only rows created at or after the run started and
 * still live (reminders not cancelled, timers pending); memories also only
 * from the run's own conversations. Older rows are the owner's and are never
 * selected, whatever the caller passes in.
 */
export function selectCleanup(rows, runStartMs, conversationIds) {
  const mine = (r) => r.createdAt >= runStartMs;
  return {
    reminders: rows.reminders.filter((r) => mine(r) && r.status !== 'cancelled').map((r) => r.id),
    timers: rows.timers.filter((t) => mine(t) && t.status === 'pending').map((t) => t.id),
    memories: rows.memories.filter((m) => mine(m) && conversationIds.includes(m.conversationId)).map((m) => m.id),
  };
}

/**
 * A turn that ended with a stream error is run once more: the retry's verdict
 * stands (a failed retry still fails), and the row says it was flaky.
 */
export function withRetry(retry) {
  const { streamError: _drop, ...rest } = retry;
  return { ...rest, tries: 2, why: `flaky: stream error${retry.why ? `; ${retry.why}` : ''}` };
}

export function formatTable(results) {
  const head = ['scenario', 'verdict', 'tries', 'sentence', 'new_memories', 'why'];
  const body = results.map((r) => [r.id, r.status, r.tries ?? 1, r.text, r.memories ?? '?', r.why]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i]).length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...body.map(line)].join('\n');
}

// --- Runtime: everything below talks to the local stack --------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ms = (column) => `round(extract(epoch from ${column}) * 1000)::float8`;

function run(command, args, shell = false) {
  return spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', shell });
}

/** The LOCAL stack's env (API_URL, keys, DB_URL); refuses a non-loopback API. Never printed. */
async function localSupabase() {
  const { parseSupabaseEnv, isLoopbackUrl } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'dev-offline.mjs')).href);
  const status = run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'status', '-o', 'env'], process.platform === 'win32');
  if (status.status !== 0) throw new Error('`npx supabase status -o env` failed; is the local stack up?');
  const env = parseSupabaseEnv(status.stdout);
  if (!isLoopbackUrl(env.API_URL)) throw new Error('refusing: Supabase API is not on loopback');
  return env;
}

/** An access token for the dev user (perf-baseline.mjs devAccessToken); held in memory only. */
async function devAccessToken(env) {
  const { readSignInCode } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'dev-offline.mjs')).href);
  const email = process.env.BOB_DEV_EMAIL ?? 'dev@bob.local';
  const admin = { Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, apikey: env.SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  const link = await fetch(`${env.API_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) });
  if (!link.ok) throw new Error(`generate_link failed (${link.status})`);
  const code = readSignInCode(await link.json());
  if (!code) throw new Error('generate_link returned no code');
  const verify = await fetch(`${env.API_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: env.PUBLISHABLE_KEY ?? env.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: code }) });
  if (!verify.ok) throw new Error(`verify failed (${verify.status})`);
  const body = await verify.json();
  if (typeof body.access_token !== 'string') throw new Error('verify returned no access token');
  return body.access_token;
}

/**
 * Candidate server journals: BOB_JOURNAL_PATH, else every checkout's (the dev
 * server may run from any worktree). The turn id is a fresh uuid, so whichever
 * journal holds it is the right one.
 */
function journalPaths() {
  if (process.env.BOB_JOURNAL_PATH) return [process.env.BOB_JOURNAL_PATH];
  const listed = run('git', ['worktree', 'list', '--porcelain']).stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  return [...new Set([REPO_ROOT, ...listed])].map((root) => join(root, 'apps', 'api', 'data', 'v2-journal.log')).filter((p) => existsSync(p));
}

/** The last 8 MB of each journal (a turn just ran, so its line is near the end). */
function readJournals(paths) {
  return paths.map((path) => {
    const size = statSync(path).size; const length = Math.min(size, 8 * 1024 * 1024);
    const fd = openSync(path, 'r');
    try { const buf = Buffer.alloc(length); readSync(fd, buf, 0, length, size - length); return buf.toString('utf8'); } finally { closeSync(fd); }
  }).join('\n');
}

/** Rows the account created since `sinceMs` (database clock), read under RLS as the account. */
async function readRows(store, db, userId, sinceMs) {
  return store.withUser(db, userId, async (tx) => ({
    reminders: await tx.query(`SELECT id, status, rrule, ${ms('due_at')} AS "dueAt", ${ms('created_at')} AS "createdAt"
      FROM bob.reminders WHERE created_by = $1 AND kind = 'reminder' AND created_at >= to_timestamp($2 / 1000.0)`, [userId, sinceMs]),
    timers: await tx.query(`SELECT id, status, ${ms('due_at')} AS "firesAt", ${ms('created_at')} AS "createdAt"
      FROM bob.reminders WHERE created_by = $1 AND kind <> 'reminder' AND created_at >= to_timestamp($2 / 1000.0)`, [userId, sinceMs]),
    memories: await tx.query(`SELECT id, kind, conversation_id AS "conversationId", ${ms('created_at')} AS "createdAt"
      FROM bob.memories WHERE user_id = $1 AND created_at >= to_timestamp($2 / 1000.0)`, [userId, sinceMs]),
    tasks: await tx.query(`SELECT id FROM bob.tasks WHERE created_by = $1 AND created_at >= to_timestamp($2 / 1000.0)`, [userId, sinceMs]),
  }));
}

/** The account's private space id (GET /api/spaces/:id/reminders needs it). */
async function privateSpaceId(store, db, userId) {
  const rows = await store.withUser(db, userId, (tx) => tx.query(`SELECT id FROM bob.spaces WHERE kind = 'private' AND owner_user_id = $1`, [userId]));
  return rows[0]?.id ?? null;
}

async function api(ctx, method, path) {
  const response = await fetch(`http://${ctx.opts.host}:${ctx.opts.port}/api${path}`,
    { method, headers: { authorization: `Bearer ${ctx.token}` }, signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: response.ok ? await response.json().catch(() => null) : null };
}

async function listedReminders(ctx) {
  if (!ctx.spaceId) throw new Error('no private space');
  const { status, body } = await api(ctx, 'GET', `/spaces/${ctx.spaceId}/reminders`);
  if (!body) throw new Error(`reminders API ${status}`);
  return body.reminders;
}

async function listedTimers(ctx) {
  const { status, body } = await api(ctx, 'GET', '/timers');
  if (!body) throw new Error(`timers API ${status}`);
  return body.timers;
}

async function dbNow(db) {
  return Number((await db.query(`SELECT ${ms('now()')} AS now`))[0].now);
}

/** One turn in a fresh conversation; the message id is the journal turn_id. */
async function sendTurn(opts, token, text) {
  const turnId = randomUUID();
  const response = await fetch(`http://${opts.host}:${opts.port}/api/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ origin: 'web_text', message: { id: turnId, role: 'user', parts: [{ type: 'text', text }] } }),
    signal: AbortSignal.timeout(opts.turnTimeoutMs),
  });
  const stream = parseChatStream(await response.text());
  if (!response.ok) stream.error ??= `http_${response.status}`;
  return { turnId, ...stream };
}

/** The account's current saved facts and preferences: judge input only, never printed. */
async function savedFacts(store, db, userId) {
  const rows = await store.withUser(db, userId, (tx) => tx.query(`SELECT content FROM bob.memories WHERE user_id = $1
    AND kind IN ('fact', 'preference') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 100`, [userId]));
  return rows.map((r) => `- ${r.content}`).join('\n') || '(none)';
}

async function runScenario(ctx, scenario) {
  const later = laterToday(Date.now(), ctx.zone);
  const text = fillText(scenario.text, { later: later?.label });
  if (text.includes('{later}')) return { id: scenario.id, text, status: 'skipped', why: 'too late in the day for a later-today time' };
  const wants = (kind) => scenario.checks.find((c) => c.kind === kind);
  const listedCheck = wants('reminder_listed'); const timerCheck = wants('timer_listed');
  // API checks only look at items the turn added, never the owner's existing ones.
  const oldReminders = listedCheck ? new Set((await listedReminders(ctx)).map((r) => r.id)) : null;
  const oldTimers = timerCheck ? new Set((await listedTimers(ctx)).map((t) => t.id)) : null;
  const tomorrow = listedCheck ? tomorrowAt(Date.now(), ctx.zone, listedCheck.tomorrow) : null;
  const since = await dbNow(ctx.db);
  const turn = await sendTurn(ctx.opts, ctx.token, text);
  if (turn.conversationId) ctx.conversations.push(turn.conversationId);
  if (turn.error) {
    const http = turn.error.startsWith('http_');
    return { id: scenario.id, text, ...verdict(scenario, `turn failed (${http ? turn.error : 'stream error'})`), streamError: !http };
  }
  const observed = { later, tomorrow, conversationId: turn.conversationId, rows: null, calledTools: null, judge: null, claim: null, api: {} };
  if (timerCheck) { // remaining_ms counts down, so read it before the settle wait
    observed.api.timers = (await listedTimers(ctx)).filter((t) => !oldTimers.has(t.id));
    const target = timerCalled(observed.api.timers, timerCheck.label);
    if (target) {
      observed.api.deleteStatus = (await api(ctx, 'DELETE', `/timers/${encodeURIComponent(target.id)}`)).status;
      observed.api.timerGone = !(await listedTimers(ctx)).some((t) => t.id === target.id);
    }
  }
  await sleep(ctx.opts.settleMs); // the journal line and memory extraction land after the stream
  observed.calledTools = turnCalledTools(readJournals(ctx.journals), turn.turnId);
  observed.rows = await readRows(ctx.store, ctx.db, ctx.userId, since);
  if (listedCheck) observed.api.reminders = (await listedReminders(ctx)).filter((r) => !oldReminders.has(r.id));
  const claimCheck = wants('no_false_claim');
  if (claimCheck) { // an empty reply claims nothing
    observed.claim = turn.reply.trim() === '' ? { score: 0 }
      : { score: (await ctx.judge({ criteria: claimCheck.criteria, input: `User: ${text}`, output: turn.reply })).score };
  }
  const judgeCheck = wants('judge');
  const facts = judgeCheck?.context === 'diet_facts' ? await savedFacts(ctx.store, ctx.db, ctx.userId) : '';
  const seen = { calledTools: observed.calledTools, memories: memoryKinds(scenarioMemories(observed)) };
  if (ctx.opts.why) { // the reply goes to the judge only; the row keeps the category
    seen.category = turn.reply.trim() === '' ? 'no-reply'
      : await ctx.categorise({ text, calledTools: observed.calledTools, facts, reply: turn.reply });
  }
  if (judgeCheck && turn.reply.trim() === '') return { id: scenario.id, text, ...seen, ...verdict(scenario, 'empty reply (nothing to judge)') };
  if (judgeCheck) {
    const result = await ctx.judge({ criteria: judgeCheck.criteria, input: `Saved facts about the user:\n${facts}\n\nUser: ${text}`, output: turn.reply });
    observed.judge = { score: result.score };
  }
  return { id: scenario.id, text, ...seen, ...verdict(scenario, evaluateChecks(scenario, observed)) };
}

/** The --why categoriser: the judge model picks one of WHY_CATEGORIES. */
async function whyCategoriser() {
  const { generateText, Output } = await import('ai');
  const { z } = await import('zod');
  const { gateway } = await import('../../apps/ai/src/agents.ts');
  const schema = z.object({ category: z.enum(WHY_CATEGORIES.filter((c) => c !== 'no-reply')) });
  return async (input) => {
    const result = await generateText({ model: gateway(process.env.BOB_EVAL_JUDGE_MODEL), output: Output.object({ schema }), prompt: whyPrompt(input) });
    return normaliseCategory(result.output.category);
  };
}

/** Cancels the run's reminders and timers, forgets its memories, deletes its conversations. */
async function cleanup(ctx, runStartMs) {
  const picked = selectCleanup(await readRows(ctx.store, ctx.db, ctx.userId, runStartMs), runStartMs, ctx.conversations);
  const { cancelReminder } = await import('../../apps/api/src/reminders/store.ts');
  const { cancelTimers } = await import('../../apps/api/src/timers/store.ts');
  const { deleteMemory } = await import('../../apps/api/src/memory/store.ts');
  for (const id of picked.reminders) await cancelReminder(ctx.db, ctx.userId, id);
  for (const id of picked.timers) await cancelTimers(ctx.db, ctx.userId, { id });
  for (const id of picked.memories) await deleteMemory(ctx.db, ctx.userId, id);
  for (const id of ctx.conversations) {
    await fetch(`http://${ctx.opts.host}:${ctx.opts.port}/api/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${ctx.token}` } });
  }
  return `cleanup: ${picked.reminders.length} reminders cancelled, ${picked.timers.length} timers cancelled, `
    + `${picked.memories.length} memories forgotten, ${ctx.conversations.length} conversations deleted`;
}

/** The token's claims (sub, user_metadata.time_zone); the token itself is never printed. */
function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = await localSupabase();
  if (!env.DB_URL) throw new Error('supabase status has no DB_URL');
  const token = await devAccessToken(env);
  const { sub: userId, user_metadata: meta } = claims(token);
  const store = await import('../../apps/api/src/platform/db/db.ts');
  process.env.BOB_EVAL_JUDGE_MODEL ??= 'openai/gpt-4o';
  const { judge } = await import('../../apps/ai/src/eval-judge.ts');
  const db = store.createPostgresDb(env.DB_URL);
  store.setSharedDb(Promise.resolve(db)); // so closeDb() ends this pool
  const ctx = { opts, token, userId, zone: meta?.time_zone || 'UTC', store, db, judge, journals: journalPaths(), conversations: [] };
  if (opts.why) ctx.categorise = await whyCategoriser();
  if (ctx.journals.length === 0) console.log('warning: no v2-journal.log found; called_tool checks will fail (set BOB_JOURNAL_PATH)');
  ctx.spaceId = await privateSpaceId(store, db, userId);
  const runStartMs = await dbNow(db);
  const results = [];
  try {
    for (const scenario of SCENARIOS.filter((s) => opts.only === null || opts.only.includes(s.id))) {
      for (let n = 1; n <= opts.repeat; n += 1) {
        try {
          const first = await runScenario(ctx, scenario);
          if (first.streamError) console.log(`${scenario.id}: stream error, retrying once`);
          results.push(first.streamError ? withRetry(await runScenario(ctx, scenario)) : first);
        } catch (error) {
          results.push({ id: scenario.id, text: scenario.text, ...verdict(scenario, `harness error: ${error.name}`) });
        }
        const last = results.at(-1);
        console.log(`${scenario.id}${opts.repeat > 1 ? ` #${n}` : ''}: ${last.status}${last.category ? ` (${last.category})` : ''}`);
      }
    }
  } finally {
    console.log(opts.keep ? 'cleanup: skipped (--keep)' : await cleanup(ctx, runStartMs));
    await store.closeDb().catch(() => undefined);
  }
  console.log(`\n${formatTable(results)}`);
  if (opts.repeat > 1 || opts.why) console.log(`\n${formatRepeatTable(aggregateRuns(results))}`);
  process.exitCode = exitCode(results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`accept:replay failed: ${error.message}`); process.exitCode = 1; });
}
