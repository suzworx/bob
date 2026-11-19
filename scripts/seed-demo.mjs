import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSignInCode } from './dev-offline.mjs';

/*
 * seed-demo.mjs — seed a realistic demo family for feature 014 (spaces,
 * threads, tasks, calendars) in one command, instead of clicking a space, a
 * thread, four tasks and three events into existence by hand every time.
 *
 * SAFETY (non-negotiable, mirrors scripts/dev-offline.mjs): this script
 * writes data, so it refuses to run unless the Bob API base URL AND the
 * local Supabase stack it discovers both resolve to a loopback host
 * (127.0.0.1 / localhost / [::1]), and refuses if BOB_DATABASE_URL is set
 * to anything else. It must be structurally impossible to aim this at a
 * hosted project. assertLoopbackTargets() is the guard; it is exported so the
 * Vitest suite can prove it rejects a hosted/LAN host without touching
 * Docker, a database, or a running server.
 *
 * auth.users rows (step 1) cannot be created through the Bob web API, so
 * those go through the LOCAL Supabase Auth admin API instead (discovered via
 * `npx supabase status -o env`, the same command dev-offline.mjs uses — no
 * container name is ever hard-coded). Every other resource (spaces, members,
 * threads, messages, tasks, calendars, events) goes through the real Bob
 * HTTP API with a real per-user bearer token, which doubles as a smoke test
 * of that API.
 *
 * Idempotent: the demo space is found by (owner, kind, name) and reused;
 * members are found by active membership before any invitation is sent;
 * messages dedupe on their (author, client_message_id) the same way any
 * other client's retries do; tasks and events are found by title within the
 * space/calendar before creating a duplicate. Re-running converges instead of
 * accumulating.
 *
 * Pure helpers (parseArgs, isLoopbackUrl, assertLoopbackTargets, dateOnlyDue,
 * instantDue, toCalendarDate, addDays, defaultZone) are exported for
 * seed-demo.test.mjs; the main flow only runs when this file is the entry
 * point (dev-offline.mjs's pattern). The demo accounts have no password: each
 * signs in with a one-time code minted by the local auth admin API
 * (signInWithCode), and that code is never printed or written to a file.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const shell = process.platform === 'win32';

export const DEFAULT_API_URL = 'http://127.0.0.1:7444';
const DEMO_EMAIL_DOMAIN = 'demo.bob.local';
export const DEMO_SPACE_NAME = 'The Alvarez Family';
const DEMO_THREAD_TITLE = 'Weekend Planning';
const DEMO_CALENDAR_NAME = 'Family Calendar';

export const FAMILY = [
  { key: 'owner', name: 'Dana Alvarez', email: `dana@${DEMO_EMAIL_DOMAIN}` },
  { key: 'sam', name: 'Sam Alvarez', email: `sam@${DEMO_EMAIL_DOMAIN}` },
  { key: 'jordan', name: 'Jordan Alvarez', email: `jordan@${DEMO_EMAIL_DOMAIN}` },
  { key: 'casey', name: 'Casey Alvarez', email: `casey@${DEMO_EMAIL_DOMAIN}` },
];

/** Every error this script raises deliberately; main() prints .message and
 *  exits non-zero without a stack (never a raw driver/HTTP body leak). */
export class SeedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedError';
  }
}

// --- pure helpers (tested in seed-demo.test.mjs, no Docker/DB/server) -------

/** Parses --api <url>, --reset, --quiet (space or = form for --api). */
export function parseArgs(args) {
  const out = { api: DEFAULT_API_URL, reset: false, quiet: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--reset') {
      out.reset = true;
    } else if (arg === '--quiet') {
      out.quiet = true;
    } else if (arg === '--api') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new SeedError('--api requires a value');
      out.api = value;
      i += 1;
    } else if (arg.startsWith('--api=')) {
      out.api = arg.slice('--api='.length);
    } else {
      throw new SeedError(`unknown option ${arg}`);
    }
  }
  return out;
}

/** True only for loopback URLs; refuses anything else (hosted or LAN). Same
 *  contract as dev-offline.mjs's isLoopbackUrl, kept local so this script has
 *  no import-time dependency on another script owning the safety guard. */
export function isLoopbackUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const host = new URL(value).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * THE safety guard: refuses to proceed unless the Bob API base, the local
 * Supabase API_URL, the local Supabase DB_URL (when reported) and
 * BOB_DATABASE_URL (when set) are all loopback. Throws SeedError naming the
 * offending value; never returns a partial pass. Pure (string checks only,
 * no I/O) so the test suite can prove it rejects a hosted/LAN host without
 * Docker, a database, or a running server -- this is the test that must fail
 * if the guard is ever removed from main().
 */
export function assertLoopbackTargets(apiUrl, supabaseEnv, env = process.env) {
  if (!isLoopbackUrl(apiUrl)) {
    throw new SeedError(`REFUSING to run: --api must be loopback (127.0.0.1/localhost/[::1]), got "${apiUrl}".`);
  }
  const dbUrl = env.BOB_DATABASE_URL;
  if (dbUrl && !isLoopbackUrl(dbUrl)) {
    throw new SeedError('REFUSING to run: BOB_DATABASE_URL is set and is not loopback. This script never touches a hosted project.');
  }
  const supabaseApiUrl = supabaseEnv?.API_URL;
  if (!supabaseApiUrl || !isLoopbackUrl(supabaseApiUrl)) {
    throw new SeedError(`REFUSING to run: the local Supabase API_URL must be loopback (got "${supabaseApiUrl}").`);
  }
  const supabaseDbUrl = supabaseEnv?.DB_URL;
  if (supabaseDbUrl && !isLoopbackUrl(supabaseDbUrl)) {
    throw new SeedError(`REFUSING to run: the local Supabase DB_URL must be loopback (got "${supabaseDbUrl}").`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds `days` whole days to `base`, returning a new Date (may be negative). */
export function addDays(base, days) {
  return new Date(base.getTime() + days * DAY_MS);
}

/** Formats a Date as a calendar date (YYYY-MM-DD, UTC) -- a date, never an
 *  instant with a time component. */
export function toCalendarDate(date) {
  return date.toISOString().slice(0, 10);
}

/** A date-only due value (contracts/api.md DueValue): honest that a "Friday"
 *  task is a calendar date, never a midnight instant. */
export function dateOnlyDue(date) {
  return { kind: 'date', date: toCalendarDate(date) };
}

/** A time-specific due value: an absolute instant plus its IANA zone. */
export function instantDue(date, zone) {
  return { kind: 'instant', at: date.getTime(), zone };
}

/** The host machine's IANA zone, falling back to UTC when unavailable. */
export function defaultZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// --- local Supabase discovery + admin user provisioning (impure) -----------

/** Reads `npx supabase status -o env` (dev-offline.mjs's exact approach: no
 *  container name is ever hard-coded, the CLI resolves it). Throws a clear
 *  SeedError when the local stack is not running. Also used by the UI catalog
 *  capture to mint the owner's sign-in code. */
export function readSupabaseStatusEnv() {
  const result = spawnSync(npx, ['supabase', 'status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', shell });
  if (result.status !== 0) {
    throw new SeedError(
      'the local Supabase stack is not running; start it with `npm run dev:offline` (or `npx supabase start`) and retry.',
    );
  }
  const env = {};
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)="([^"]*)"$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** Finds an existing auth.users row by exact email via the local Supabase
 *  Auth admin API (dev-offline.mjs's ensureDevUser pattern), or null. */
export async function findAuthUser(supabaseApiUrl, serviceRoleKey, email) {
  const headers = { Authorization: `Bearer ${serviceRoleKey}` };
  // GoTrue's admin list ignores ?email; search every page before creating.
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${supabaseApiUrl}/auth/v1/admin/users?page=${page}&per_page=100`, { headers });
    if (res.status !== 200) throw new SeedError(`auth admin lookup failed for ${email} (${res.status})`);
    const body = await res.json();
    const list = Array.isArray(body.users) ? body.users : [];
    const found = list.find((user) => user.email === email);
    if (found) return found;
    if (list.length < 100) return null;
  }
}

/**
 * Ensures one confirmed, password-less auth.users row exists for `person`
 * with a real display name in user_metadata.name (read by
 * bob_private.space_member_profiles). Idempotent: an existing account has
 * its confirmation and name force-set to the current values, even after a
 * prior partial run. Sign-in goes through signInWithCode, never a password.
 */
async function ensureAuthUser(supabaseApiUrl, serviceRoleKey, person) {
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' };
  const existing = await findAuthUser(supabaseApiUrl, serviceRoleKey, person.email);
  if (existing) {
    const res = await fetch(`${supabaseApiUrl}/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ email_confirm: true, user_metadata: { name: person.name } }),
    });
    if (res.status !== 200) throw new SeedError(`auth admin update failed for ${person.email} (${res.status})`);
    return { id: existing.id, created: false };
  }
  const res = await fetch(`${supabaseApiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: person.email,
      email_confirm: true,
      user_metadata: { name: person.name },
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new SeedError(`auth admin create failed for ${person.email} (${res.status})`);
  }
  const body = await res.json();
  return { id: body.id, created: true };
}

/** Signs in as `email` with a one-time code minted by the local auth admin API
 *  (the email password provider is off locally), returning a real access token
 *  the Bob API's Supabase JWT guard accepts. The code is never printed. */
export async function signInWithCode(supabaseApiUrl, serviceRoleKey, apiKey, email) {
  const code = await createSignInCode(supabaseApiUrl, serviceRoleKey, email);
  const res = await fetch(`${supabaseApiUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: code }),
  });
  if (res.status !== 200) throw new SeedError(`sign-in failed for ${email} (${res.status})`);
  const body = await res.json();
  if (!body.access_token) throw new SeedError(`sign-in for ${email} returned no access_token`);
  return body.access_token;
}

// --- Bob HTTP API layer (impure) ------------------------------------------

/** GET {api}/health without auth; a clear error when the server is down. */
async function checkApiHealth(apiBase) {
  let res;
  try {
    res = await fetch(`${apiBase}/health`);
  } catch (err) {
    throw new SeedError(`the Bob API is not reachable at ${apiBase} (${err.message}); start it with \`npm run dev:offline\`.`);
  }
  if (!res.ok) throw new SeedError(`the Bob API at ${apiBase} answered ${res.status} on /health.`);
}

/** One authenticated /api call; never throws on a 4xx/5xx (the caller
 *  decides), so callers that need the status code (message dedup) can see it. */
async function apiCall(apiBase, token, method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

/** Same as apiCall, but throws SeedError on any 4xx/5xx -- the default for
 *  every call whose caller does not need to distinguish created vs deduped. */
async function apiFetch(apiBase, token, method, path, body) {
  const { status, data } = await apiCall(apiBase, token, method, path, body);
  if (status >= 400) throw new SeedError(`${method} ${path} failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

// --- resource seeding (each idempotent: find-by-identity, else create) -----

/** Finds the demo group space owned by `owner` by exact name, or creates it.
 *  POST /api/spaces (web-spaces.ts) always makes the caller its owner. */
async function ensureSpace(apiBase, ownerToken) {
  const list = await apiFetch(apiBase, ownerToken, 'GET', '/api/spaces');
  const existing = list.spaces.find((space) => space.name === DEMO_SPACE_NAME && space.kind === 'group');
  if (existing) return { space: existing, created: false };
  const space = await apiFetch(apiBase, ownerToken, 'POST', '/api/spaces', { kind: 'group', name: DEMO_SPACE_NAME });
  return { space, created: true };
}

/**
 * Ensures every non-owner member is an active member of the space: invite
 * (POST .../invitations) then immediately accept as that member's own token
 * (POST /api/invitations/:token/accept) -- the raw token is returned exactly
 * once, so a stale pending invitation from a prior crashed run (found via
 * GET .../invitations, which lists pending-only invitations) is revoked and
 * recreated rather than reused. Already-active members are skipped entirely.
 */
async function ensureMembers(apiBase, ownerToken, spaceId, members) {
  const membersList = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/members`);
  const activeIds = new Set(membersList.members.map((member) => member.user_id));
  const invitationsList = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/invitations`);
  let invited = 0;
  for (const person of members) {
    if (activeIds.has(person.userId)) continue;
    const stale = invitationsList.invitations.find((invitation) => invitation.invited_email === person.email);
    if (stale) {
      await apiFetch(apiBase, ownerToken, 'DELETE', `/api/invitations/${stale.id}`);
    }
    const created = await apiFetch(apiBase, ownerToken, 'POST', `/api/spaces/${spaceId}/invitations`, {
      email: person.email,
      role: 'member',
    });
    await apiFetch(apiBase, person.token, 'POST', `/api/invitations/${created.token}/accept`);
    invited += 1;
  }
  return { invited };
}

/** Finds the demo thread by exact title, or creates it. */
async function ensureThread(apiBase, ownerToken, spaceId) {
  const list = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/threads`);
  const existing = list.threads.find((thread) => thread.title === DEMO_THREAD_TITLE);
  if (existing) return { thread: existing, created: false };
  const thread = await apiFetch(apiBase, ownerToken, 'POST', `/api/spaces/${spaceId}/threads`, {
    title: DEMO_THREAD_TITLE,
  });
  return { thread, created: true };
}

/**
 * Posts four messages from four different authors: two @name person mentions
 * and one @bob mention, so mention rendering is visible (parsed client-side
 * per core/mentions.ts; posting a human message never invokes the model,
 * FR-008). Each carries a fixed client_message_id, so a retry (or a rerun
 * against the same thread) dedupes to the original message per
 * (author_user_id, client_message_id) -- the thread's own unique constraint.
 */
async function ensureMessages(apiBase, threadId, people) {
  const [dana, sam, jordan, casey] = people;
  const drafts = [
    { author: dana, id: 'demo-014-thread-msg-1', body: "Morning team — who's around to help pack for the lake trip this weekend?" },
    { author: sam, id: 'demo-014-thread-msg-2', body: '@Dana I can grab the cooler and the paddleboards on Friday.' },
    { author: jordan, id: 'demo-014-thread-msg-3', body: '@Casey can you double check the vet appointment is still on for Tuesday?' },
    { author: casey, id: 'demo-014-thread-msg-4', body: 'Will do! @bob can you remind me at 9am on Tuesday?' },
  ];
  let created = 0;
  for (const draft of drafts) {
    const { status, data } = await apiCall(apiBase, draft.author.token, 'POST', `/api/threads/${threadId}/messages`, {
      body: draft.body,
      client_message_id: draft.id,
    });
    if (status >= 400) throw new SeedError(`posting message ${draft.id} failed (${status}): ${JSON.stringify(data)}`);
    if (status === 201) created += 1;
  }
  return { created, existing: drafts.length - created };
}

/**
 * Ensures the four demo tasks exist (found by title within the space): one
 * date-only due, one time-specific due, one with no due, one created then
 * immediately completed. The date-only/timed pair is the point -- it proves a
 * "Friday" task never becomes a midnight alarm (dateOnlyDue vs instantDue).
 */
async function ensureTasks(apiBase, ownerToken, spaceId, people, zone) {
  const [dana, sam, jordan, casey] = people;
  const existing = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/tasks`);
  const byTitle = new Set(existing.tasks.map((task) => task.title));
  const now = new Date();
  const plan = [
    { title: 'Pack the car for the lake trip', assignee: sam.userId, due: dateOnlyDue(addDays(now, 3)) },
    { title: 'Pick up Casey from swim practice', assignee: jordan.userId, due: instantDue(addDays(now, 1), zone) },
    { title: 'Renew the library books', assignee: dana.userId, due: null },
    { title: 'Book the vet appointment', assignee: casey.userId, due: null, completed: true },
  ];
  let created = 0;
  for (const item of plan) {
    if (byTitle.has(item.title)) continue;
    const task = await apiFetch(apiBase, ownerToken, 'POST', `/api/spaces/${spaceId}/tasks`, {
      title: item.title,
      assignee_user_id: item.assignee,
      ...(item.due ? { due: item.due } : {}),
    });
    created += 1;
    if (item.completed) {
      await apiFetch(apiBase, ownerToken, 'PATCH', `/api/tasks/${task.id}`, { revision: task.revision, status: 'completed' });
    }
  }
  return { created, existing: plan.length - created };
}

// A wide window around "now" the events list checks fall within (30 days
// back, so a --reset run's freshly-created future events are always seen;
// far enough forward that the weekly recurrence has expanded at least once).
const EVENTS_WINDOW_PAST_DAYS = 30;
const EVENTS_WINDOW_FUTURE_DAYS = 400;

/** Finds the demo calendar by exact name, or creates it in `zone`. */
async function ensureCalendar(apiBase, ownerToken, spaceId, zone) {
  const list = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/calendars`);
  const existing = list.calendars.find((calendar) => calendar.name === DEMO_CALENDAR_NAME);
  if (existing) return { calendar: existing, created: false };
  const calendar = await apiFetch(apiBase, ownerToken, 'POST', `/api/spaces/${spaceId}/calendars`, {
    name: DEMO_CALENDAR_NAME,
    zone,
  });
  return { calendar, created: true };
}

/** GET .../events over the standard window; used both to find existing
 *  occurrences (idempotency) and, in resetSpaceContents, to enumerate events
 *  to cancel. A cancelled event's master yields zero occurrences (store's
 *  expandEvent short-circuits on status 'cancelled'), so this window never
 *  sees anything this script has already cancelled. */
async function listEventsInWindow(apiBase, token, calendarId) {
  const now = Date.now();
  const from = now - EVENTS_WINDOW_PAST_DAYS * DAY_MS;
  const to = now + EVENTS_WINDOW_FUTURE_DAYS * DAY_MS;
  return apiFetch(apiBase, token, 'GET', `/api/calendars/${calendarId}/events?from=${from}&to=${to}`);
}

/**
 * Ensures the three demo events exist (found by title in the standard
 * window): a timed one, an all-day one spanning two calendar days (end_date
 * exclusive, iCal-style: start + 2 covers exactly two days), and a weekly
 * recurring one, so recurrence expansion is visible.
 */
async function ensureEvents(apiBase, ownerToken, calendarId, zone) {
  const existing = await listEventsInWindow(apiBase, ownerToken, calendarId);
  const titles = new Set(existing.events.map((occurrence) => occurrence.title));
  const now = new Date();
  const conferenceStart = addDays(now, 2);
  const lakeStart = addDays(now, 5);
  const dinnerStart = addDays(now, 4);
  const wanted = [
    {
      title: 'Parent-Teacher Conference',
      all_day: false,
      start_at: conferenceStart.getTime(),
      end_at: conferenceStart.getTime() + 30 * 60 * 1000,
      zone,
    },
    {
      title: 'Lake Weekend Getaway',
      all_day: true,
      start_date: toCalendarDate(lakeStart),
      end_date: toCalendarDate(addDays(lakeStart, 2)),
      zone,
    },
    {
      title: 'Family Dinner',
      all_day: false,
      start_at: dinnerStart.getTime(),
      end_at: dinnerStart.getTime() + 60 * 60 * 1000,
      zone,
      rrule: { freq: 'weekly', byWeekday: [dinnerStart.getUTCDay()] },
    },
  ];
  let created = 0;
  for (const event of wanted) {
    if (titles.has(event.title)) continue;
    await apiFetch(apiBase, ownerToken, 'POST', `/api/calendars/${calendarId}/events`, event);
    created += 1;
  }
  return { created, existing: wanted.length - created };
}

/**
 * --reset: clears the demo space's tasks and events, scoped strictly to the
 * space (and its calendars) already found by ensureSpace -- never any other
 * row. Tasks are trashed (DELETE .../tasks/:id) and events are cancelled in
 * full (DELETE .../events/:id, scope 'series'), the only destructive
 * operations the API exposes; both make ensureTasks/ensureEvents' by-title
 * checks below see nothing, so the following seed step recreates them fresh.
 *
 * The demo thread and its messages are deliberately left alone: a thread can
 * only be archived, never deleted, and archiving it would just make
 * ensureThread create a second thread while message client_message_id is
 * deduped per-author GLOBALLY (not per-thread, per the messages
 * (author_user_id, client_message_id) unique index) -- reusing the same ids against a new thread would silently
 * resurrect the old (now-archived) messages instead of posting new ones.
 * Message posting is already naturally idempotent, so there is nothing to
 * reset there.
 */
async function resetSpaceContents(apiBase, ownerToken, spaceId) {
  const tasks = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/tasks`);
  for (const task of tasks.tasks) {
    await apiFetch(apiBase, ownerToken, 'DELETE', `/api/tasks/${task.id}`);
  }
  const calendars = await apiFetch(apiBase, ownerToken, 'GET', `/api/spaces/${spaceId}/calendars`);
  for (const calendar of calendars.calendars) {
    const events = await listEventsInWindow(apiBase, ownerToken, calendar.id);
    const seen = new Set();
    for (const occurrence of events.events) {
      if (seen.has(occurrence.event_id)) continue;
      seen.add(occurrence.event_id);
      await apiFetch(apiBase, ownerToken, 'DELETE', `/api/events/${occurrence.event_id}`, { scope: 'series' });
    }
  }
}

// --- entry point -------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[seed-demo] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const log = (...message) => {
    if (!args.quiet) console.log('[seed-demo]', ...message);
  };

  try {
    // Checked BEFORE any network call, including the health check below: a
    // hosted --api must never be dialed at all, not even a harmless GET.
    if (!isLoopbackUrl(args.api)) {
      throw new SeedError(`REFUSING to run: --api must be loopback (127.0.0.1/localhost/[::1]), got "${args.api}".`);
    }
    await checkApiHealth(args.api);
    const supabaseEnv = readSupabaseStatusEnv();
    assertLoopbackTargets(args.api, supabaseEnv);
    log('API and local Supabase confirmed on the loopback interface.');

    const serviceRoleKey = supabaseEnv.SERVICE_ROLE_KEY;
    const anonKey = supabaseEnv.PUBLISHABLE_KEY ?? supabaseEnv.ANON_KEY;
    if (!serviceRoleKey || !anonKey) {
      throw new SeedError('`npx supabase status -o env` did not report SERVICE_ROLE_KEY/PUBLISHABLE_KEY(ANON_KEY).');
    }
    const zone = defaultZone();

    let usersCreated = 0;
    const people = [];
    for (const person of FAMILY) {
      const { id, created } = await ensureAuthUser(supabaseEnv.API_URL, serviceRoleKey, person);
      if (created) usersCreated += 1;
      const token = await signInWithCode(supabaseEnv.API_URL, serviceRoleKey, anonKey, person.email);
      people.push({ ...person, userId: id, token });
    }
    log(`auth users: ${usersCreated} created, ${FAMILY.length - usersCreated} already present.`);

    const [owner, ...members] = people;
    const { space, created: spaceCreated } = await ensureSpace(args.api, owner.token);
    log(`space: ${space.id} (${spaceCreated ? 'created' : 'existing'}).`);

    if (args.reset) {
      log('--reset: clearing the demo space\'s tasks and events...');
      await resetSpaceContents(args.api, owner.token, space.id);
    }

    const { invited } = await ensureMembers(args.api, owner.token, space.id, members);
    log(`members: ${invited} invited, ${members.length - invited} already present.`);

    const { thread, created: threadCreated } = await ensureThread(args.api, owner.token, space.id);
    const messages = await ensureMessages(args.api, thread.id, people);
    log(`thread: ${thread.id} (${threadCreated ? 'created' : 'existing'}), ${messages.created} messages posted.`);

    const tasks = await ensureTasks(args.api, owner.token, space.id, people, zone);
    log(`tasks: ${tasks.created} created, ${tasks.existing} already present.`);

    const { calendar, created: calendarCreated } = await ensureCalendar(args.api, owner.token, space.id, zone);
    const events = await ensureEvents(args.api, owner.token, calendar.id, zone);
    log(`calendar: ${calendar.id} (${calendarCreated ? 'created' : 'existing'}), ${events.created} events created.`);

    console.log('[seed-demo] done.');
    console.log(`  space:     ${space.id} (${spaceCreated ? 'created' : 'existing'})`);
    console.log(`  members:   ${people.length} total, ${invited} newly invited, ${members.length - invited} already present`);
    console.log(`  thread:    ${thread.id} (${threadCreated ? 'created' : 'existing'}), ${messages.created} messages created, ${messages.existing} already present`);
    console.log(`  tasks:     ${tasks.created} created, ${tasks.existing} already present`);
    console.log(`  calendar:  ${calendar.id} (${calendarCreated ? 'created' : 'existing'}), ${events.created} events created, ${events.existing} already present`);
  } catch (err) {
    console.error(`[seed-demo] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
