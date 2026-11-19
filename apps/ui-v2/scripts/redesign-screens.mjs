#!/usr/bin/env node
/**
 * Bob web redesign (#1240) rendered check. Starts Vite, opens every redesigned
 * route in Chromium at 375x812 and 1440x900 with every /api/* call answered
 * from FICTIONAL fixtures (no network, no database, no real person), saves a
 * PNG per route and width to docs/design/redesign-after/, and checks:
 *
 *   gutter   the page's first heading sits a non-zero distance from the main
 *            region's left edge, and the same distance on every page at that
 *            width (the positive gate in apps/ui-v2/CLAUDE.md)
 *   composer on the phone chat, the composer is in the bottom third of the
 *            viewport and fully on screen
 *   rail     at 1440, Today, Calendar, Memory and Devices are visible in the
 *            side navigation without scrolling
 *
 * Usage, from the repo root:  node apps/ui-v2/scripts/redesign-screens.mjs
 * Exit code 1 when any check fails. Needs Chromium (PLAYWRIGHT_BROWSERS_PATH).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT = join(APP, '..', '..', 'docs', 'design', 'redesign-after');
const PORT = Number(process.env.REDESIGN_PORT ?? 5199);
const BASE = `http://localhost:${PORT}`;

// ---- Fictional fixtures ---------------------------------------------------
const NOW = Date.now();
const HOUR = 3_600_000;
const ME = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-000000000002';
const SPACE_ID = '6f86817c-ea95-481d-8456-8e608d5db780';
const THREAD_ID = '5baa4dd3-311c-4abb-adc1-0eecd0ea06ca';
const DEVICE_ID = '0b1e7c2a-9f3d-4e5a-8b6c-7d8e9f0a1b2c';
const ZONE = 'America/Los_Angeles';

const members = [
  { user_id: ME, role: 'owner', joined_at: NOW - 90 * 24 * HOUR, display_name: 'Alex Example', handle: 'alex', email: 'alex@example.test' },
  { user_id: SAM, role: 'member', joined_at: NOW - 60 * 24 * HOUR, display_name: 'Sam Example', handle: 'sam', email: 'sam@example.test' },
];
const spaceSummary = {
  id: SPACE_ID, kind: 'group', name: 'Example Family', role: 'owner', membership_revision: 2,
  created_at: NOW - 90 * 24 * HOUR, updated_at: NOW - HOUR, archived_at: null,
  unread_count: 2, thread_count: 2, last_activity_at: NOW - HOUR, audience: 'family',
};
const space = { ...spaceSummary, members };
const threads = [
  { id: THREAD_ID, space_id: SPACE_ID, title: 'Weekend picnic plan', created_by: ME, archived_at: null, last_sequence: 4, unread_count: 2, created_at: NOW - 3 * HOUR, updated_at: NOW - HOUR },
  { id: '7c1e2a40-0000-4000-8000-00000000aa01', space_id: SPACE_ID, title: 'Groceries for the week', created_by: SAM, archived_at: null, last_sequence: 2, unread_count: 0, created_at: NOW - 30 * HOUR, updated_at: NOW - 26 * HOUR },
];
const conversations = [
  { id: 'cnv_8a2b1c3d-0000-4000-8000-000000000001', title: 'Ideas for a rainy Saturday', createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, pinned: true },
  { id: 'cnv_8a2b1c3d-0000-4000-8000-000000000002', title: 'Pancake recipe for four', createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR },
  { id: 'cnv_8a2b1c3d-0000-4000-8000-000000000003', title: 'Packing list for the lake trip', createdAt: NOW - 50 * HOUR, updatedAt: NOW - 49 * HOUR },
];
const settings = { volume: 60, muted: false, mode: 'ptt', dnd: false, ring_seconds: 20, ring_sound: 'chime', wake_word: 'bob' };
const devices = [{
  id: DEVICE_ID, name: 'Kitchen Bob', model: 'waveshare', paired_at: NOW - 30 * 24 * HOUR, last_seen_at: NOW - 60_000,
  connected: true, settings, pending: false, settings_supported: true, ring_settings_supported: true, wake_word_supported: true,
  live: { connected: true, battery_pct: 80, charging: false, fw_version: '1.4.0' },
  active_conversation_id: null, active_space_id: SPACE_ID,
}];
const memory = (id, content, kind = 'fact') => ({
  id, kind, content, confidence: 0.9, sensitive: false,
  source: { conversation_id: null, message_id: null, surface: 'web_text' }, superseded_by: null,
  created_at: NOW - 24 * HOUR, updated_at: NOW - 24 * HOUR,
});
const memories = [
  memory('mem_1', 'You prefer green tea in the morning'),
  memory('mem_2', 'Your favourite park is the one by the river', 'preference'),
  memory('mem_3', 'You want to learn to bake sourdough', 'intent'),
];
const task = (id, title, due) => ({
  id, space_id: SPACE_ID, title, notes: null, status: 'open', due_at: due, due_date: null, due_zone: ZONE,
  assignee_id: ME, created_by: ME, created_at: NOW - 24 * HOUR, updated_at: NOW - 24 * HOUR, completed_at: null,
  priority: null, items_total: 0, items_done: 0, revision: 1,
});
const reminder = (id, title, at) => ({
  id, space_id: SPACE_ID, title, due_at: at, due_zone: ZONE, rrule: null, status: 'scheduled', kind: 'reminder',
  created_by: ME, recipients: [ME], created_at: NOW - HOUR, updated_at: NOW - HOUR,
});
const accounts = [
  { id: ME, email: 'alex@example.test', createdAt: new Date(NOW - 90 * 24 * HOUR).toISOString(), lastSignInAt: new Date(NOW - HOUR).toISOString(), status: 'enabled', isAdmin: true, emailConfirmed: true },
  { id: SAM, email: 'sam@example.test', createdAt: new Date(NOW - 60 * 24 * HOUR).toISOString(), lastSignInAt: null, status: 'enabled', isAdmin: false, emailConfirmed: true },
];

/** The fixture answer for one request, or undefined for a plain `{}`. */
function answer(method, path) {
  if (method !== 'GET' && path === '/api/admin/accounts/search') return { accounts, counts: { total: 2, enabled: 2, disabled: 0, awaitingConfirmation: 0 }, nextCursor: null };
  if (method !== 'GET' && path === '/api/admin/waitlist/search') return { entries: [], counts: { total: 0 }, nextCursor: null };
  const fixed = {
    '/api/public-config': { devSignIn: true },
    '/api/account': { display_name: 'Alex Example', email: 'alex@example.test', time_zone: ZONE },
    '/api/active': { active: null },
    '/api/spaces': { spaces: [spaceSummary] },
    [`/api/spaces/${SPACE_ID}`]: space,
    [`/api/spaces/${SPACE_ID}/members`]: { members },
    [`/api/spaces/${SPACE_ID}/threads`]: { threads },
    [`/api/spaces/${SPACE_ID}/tasks`]: { tasks: [task('tsk_1', 'Book the picnic table', NOW + 4 * HOUR)] },
    [`/api/spaces/${SPACE_ID}/reminders`]: { reminders: [reminder('rem_1', 'Water the plants', NOW + 2 * HOUR)] },
    [`/api/spaces/${SPACE_ID}/notes`]: { notes: [] },
    [`/api/spaces/${SPACE_ID}/invitations`]: { invitations: [] },
    '/api/conversations': { conversations },
    '/api/devices': { devices, active_conversation: null, active_space: { id: SPACE_ID, name: 'Example Family' } },
    [`/api/devices/${DEVICE_ID}/activity`]: { items: [] },
    '/api/timers': { timers: [{ id: 'tmr_1', kind: 'timer', label: 'Pasta', fire_at: NOW + 7 * 60_000, remaining_ms: 7 * 60_000, zone: ZONE }] },
    '/api/memories': { memories, next_cursor: null },
    '/api/action-items': { action_items: [] },
    '/api/notifications': { notifications: [], next_cursor: null, unread_count: 0 },
    '/api/notification-preferences': { preferences: [] },
    '/api/google-accounts': { accounts: [] },
    '/api/me/usage': {
      range: '30d', from: new Date(NOW - 30 * 24 * HOUR).toISOString(), to: new Date(NOW).toISOString(), generated_at: new Date(NOW).toISOString(),
      active_days: 12, turns: { total: 48, by_surface: { device: 20, web_voice: 8, web_text: 20 }, by_day: [], by_weekday_hour: [] },
      conversations_created: 9, created: { tasks: 4, notes: 2, reminders: 6 }, todos_done: 7, memories: { new_in_range: 3, total: 3 }, game_minutes: null,
    },
    [`/api/threads/${THREAD_ID}/messages`]: { messages: [], next_cursor: null },
  };
  if (fixed[path] !== undefined) return fixed[path];
  if (path === '/api/agenda') return { items: [], remote_items: [], sources: [] };
  if (path.startsWith('/api/spaces/') && path.endsWith('/threads')) return { threads: [] };
  return undefined;
}

function status(path) {
  if (path === '/api/admin/access' || path === '/api/operator/access') return 204;
  if (path === '/api/events') return 204;
  return 200;
}

// ---- Routes ---------------------------------------------------------------
const ROUTES = [
  { name: 'chat', path: '/' },
  { name: 'today', path: '/today' },
  { name: 'calendar', path: '/calendar' },
  { name: 'memory', path: '/memory' },
  { name: 'devices', path: '/devices' },
  { name: 'devices-pair', path: '/devices/pair', dialog: 'Pair a device' },
  { name: 'spaces', path: '/spaces' },
  { name: 'space', path: `/spaces/${SPACE_ID}` },
  { name: 'integrations', path: '/integrations' },
  { name: 'settings', path: '/settings' },
  { name: 'admin', path: '/admin' },
];
const SIZES = [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
];

// ---- Vite -----------------------------------------------------------------
async function startVite() {
  // Its own process group, so stopping it also stops the vite that npx starts.
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: APP, stdio: 'ignore', detached: true, env: { ...process.env, BROWSER: 'none' } });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE)).ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stopVite(child);
  throw new Error('vite did not start');
}

function stopVite(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

// ---- Measurements ---------------------------------------------------------
/** In the page: the first heading's text and the content line's distance from the main region's left edge. */
function readGutter() {
  const main = document.querySelector('main, [role="main"]');
  const heading = main?.querySelector('h1') ?? main?.querySelector('h2');
  if (!main || !heading) return { gutter: null, heading: null };
  // The page's content line: its leftmost heading, picture or composer (the
  // chat landing puts Bob's picture to the left of its heading).
  const boxes = [...main.querySelectorAll('h1, h2, img, [role="img"], [aria-label="Message input"]')]
    .map((node) => node.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0 && box.top < window.innerHeight);
  const left = Math.min(...boxes.map((box) => box.left));
  return { gutter: Math.round(left - main.getBoundingClientRect().left), heading: heading.textContent?.trim() ?? null };
}

/** In the page: the composer's top and bottom, or null without one. */
function readComposer() {
  const box = document.querySelector('[aria-label="Message input"]')?.getBoundingClientRect();
  return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom) } : null;
}

/** In the page: whether each primary destination is visible in the side navigation without scrolling. */
function readRail() {
  const links = [...(document.querySelector('nav[aria-label="Side navigation"]')?.querySelectorAll('a') ?? [])];
  return ['Today', 'Calendar', 'Memory', 'Devices'].map((name) => {
    const box = links.find((a) => a.textContent?.trim() === name)?.getBoundingClientRect();
    return { name, visible: box !== undefined && box.height > 0 && box.bottom <= window.innerHeight };
  });
}

async function measure(page, route, size) {
  const phone = size.width < 768;
  const { gutter, heading } = await page.evaluate(readGutter);
  const composer = phone && route.name === 'chat' ? await page.evaluate(readComposer) : null;
  const rail = phone ? null : await page.evaluate(readRail);
  const crashed = await page.getByText('Reload the page to try again').count() > 0;
  return { gutter, heading, composer, rail, crashed };
}

/** A browser context at one size, signed in as the fictional dev user, with every /api call answered from the fixtures. */
async function fixtureContext(browser, size) {
  const context = await browser.newContext({ viewport: size, colorScheme: 'light', deviceScaleFactor: 1 });
  await context.addInitScript(({ me }) => {
    localStorage.setItem('bob.dev.token', 'fictional-redesign-screens');
    localStorage.setItem('bob.dev.tokenExpiry', String(Date.now() + 86_400_000));
    localStorage.setItem('bob.dev.userId', me);
    localStorage.setItem('bob.theme', 'light');
  }, { me: ME });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const code = status(url.pathname);
    if (code === 204) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: code, json: answer(route.request().method(), url.pathname) ?? {} });
  });
  return context;
}

/** Opens one route, screenshots it and measures it. */
async function capture(context, route, size) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('pageerror', (error) => console.error(`page error on ${route.path}: ${error.message.slice(0, 160)}`));
  await page.goto(`${BASE}${route.path}?brand=bob`);
  if (route.dialog) await page.getByRole('dialog', { name: route.dialog }).waitFor({ timeout: 15_000 }).catch(() => {});
  await page.locator('[role="main"] h1, [role="main"] h2').first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `${route.name}-${size.width}.png`) });
  const m = await measure(page, route, size);
  await page.close();
  return { route: route.path, width: size.width, ...m, errors: errors.length, file: `docs/design/redesign-after/${route.name}-${size.width}.png` };
}

/** The failed checks for one row. */
function rowChecks(row) {
  const checks = [];
  if (row.crashed) checks.push('CRASH');
  if (row.gutter === null) checks.push('no heading');
  else if (row.gutter <= 0) checks.push('gutter 0');
  const phoneChat = row.route === '/' && row.width < 768;
  if (phoneChat && row.composer === null) checks.push('no composer');
  if (row.composer && !(row.composer.bottom <= 812 && row.composer.top >= 812 * (2 / 3))) checks.push('composer not at bottom');
  const hidden = (row.rail ?? []).filter((item) => !item.visible).map((item) => item.name);
  if (hidden.length > 0) checks.push(`rail: ${hidden.join(',')} hidden`);
  return checks;
}

/** One failure per width whose pages do not share a gutter. Space pages own a full-height chat frame and are left out. */
function gutterFailures(rows) {
  return SIZES.flatMap(({ width }) => {
    const framed = rows.filter((row) => row.width === width && row.gutter !== null && !row.route.startsWith('/spaces/'));
    if (new Set(framed.map((row) => row.gutter)).size <= 1) return [];
    return [`${width}px: gutters differ across pages: ${framed.map((row) => `${row.route}=${row.gutter}`).join(' ')}`];
  });
}

function printTable(rows) {
  console.log('| route | width | heading | gutter px | composer | rail @1440 | page errors | result | screenshot |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const composer = row.composer ? `${row.composer.top}-${row.composer.bottom}` : '-';
    const rail = row.rail ? (row.rail.every((item) => item.visible) ? 'all 4 visible' : 'MISSING') : '-';
    const result = row.checks.length ? row.checks.join('; ') : 'ok';
    console.log(`| ${row.route} | ${row.width} | ${row.heading ?? '-'} | ${row.gutter ?? '-'} | ${composer} | ${rail} | ${row.errors} | ${result} | ${row.file} |`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vite = await startVite();
  const browser = await chromium.launch();
  const rows = [];
  try {
    for (const size of SIZES) {
      const context = await fixtureContext(browser, size);
      for (const route of ROUTES) {
        rows.push(await capture(context, route, size));
        console.error(`captured ${route.path} @${size.width}`);
      }
      await context.close();
    }
  } finally {
    // Closing can stall on a slow machine; never let teardown hold the results back.
    await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    stopVite(vite);
  }
  for (const row of rows) row.checks = rowChecks(row);
  const failures = [...gutterFailures(rows), ...rows.filter((row) => row.checks.length > 0).map((row) => `${row.route} @${row.width}: ${row.checks.join('; ')}`)];
  printTable(rows);
  console.log(failures.length > 0 ? `\nFAIL\n${failures.map((failure) => `- ${failure}`).join('\n')}` : '\nPASS');
  process.exit(failures.length > 0 ? 1 : 0);
}

await main();
