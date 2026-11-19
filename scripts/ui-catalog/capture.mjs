// UI catalog captures with Playwright, into <outDir>/img/{pages,components,astryx,templates} plus capture json.
// bob: each screen state at desktop + phone, and (desktop) a clipped shot of every mounted Bob component,
// found by walking React's dev-mode fiber tree by component name. Signs in as the seed-demo owner and discovers
// the ids it needs through the API; a state whose data is missing is skipped and recorded.
// astryx (best effort, --skip-astryx skips): one Storybook story per component and the template previews.
// Usage: node scripts/ui-catalog/capture.mjs [outDir] [--skip-astryx]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSignInCode } from '../dev-offline.mjs';
import { assertLoopbackTargets, DEMO_SPACE_NAME, FAMILY, readSupabaseStatusEnv } from '../seed-demo.mjs';
import { REGISTRY_FILE } from './registry.mjs';
import { ensureCaptureMemories } from './capture-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const OUT = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'data/ui-catalog'));
const WEB = process.env.BOB_CATALOG_WEB || 'http://localhost:5173';
const API = process.env.BOB_CATALOG_API || 'http://localhost:7444';
const ASTRYX = 'https://astryx.atmeta.com';
const IMG = (d, f) => path.join(OUT, 'img', d, f);
for (const d of ['pages', 'components', 'astryx', 'templates']) fs.mkdirSync(path.join(OUT, 'img', d), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const JPG = { type: 'jpeg', quality: 72 };
const firstLine = (e) => String(e).split('\n')[0].slice(0, 140);

// Signs in through the real sign-in page with a one-time code minted for the seed-demo owner (the local
// stack has the password provider off); returns the storage state and the API bearer token.
async function signIn(browser) {
  const email = FAMILY.find((p) => p.key === 'owner').email;
  const supabaseEnv = readSupabaseStatusEnv();
  assertLoopbackTargets(API, supabaseEnv);
  const code = await createSignInCode(supabaseEnv.API_URL, supabaseEnv.SERVICE_ROLE_KEY, email);
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Email' }).fill(email, { timeout: 30000 });
  await page.getByRole('button', { name: 'I already have a code' }).click();
  await page.getByRole('textbox', { name: 'Six-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  const token = await page.waitForFunction(() => {
    const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k));
    return key ? JSON.parse(localStorage.getItem(key)).access_token : null;
  }, null, { timeout: 30000 }).then((h) => h.jsonValue());
  const storageState = await ctx.storageState();
  await ctx.close();
  return { storageState, token };
}

// The ids the states need; null where the seeded data has none.
async function discover(token) {
  const get = async (p) => {
    const res = await fetch(API + p, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? res.json() : {};
  };
  const { spaces = [] } = await get('/api/spaces');
  const space = spaces.find((s) => s.name === DEMO_SPACE_NAME) ?? spaces[0];
  const { threads = [] } = space ? await get(`/api/spaces/${space.id}/threads`) : {};
  const { conversations = [] } = await get('/api/conversations');
  return { V: space?.id ?? null, T: threads[0]?.id ?? null, C: conversations[0]?.id ?? null };
}

// Each state: route + optional interaction; `needs` names the discovered ids it requires.
// Visible matches only: some controls render a hidden twin for the other layout.
const clickText = (t) => async (p) => { await p.getByText(t, { exact: true }).filter({ visible: true }).first().click(); };
const clickRole = (role, name) => async (p) => { await p.getByRole(role, { name, exact: typeof name === 'string' }).filter({ visible: true }).first().click(); };
const then = (...steps) => async (p) => { for (const s of steps) { await s(p); await sleep(400); } };
const states = ({ V, T, C }) => [
  { id: 'landing', route: '/' },
  { id: 'conversation', route: `/c/${C}`, needs: [C] },
  { id: 'conversation-menu', route: `/c/${C}`, needs: [C], act: clickRole('button', /^Conversation actions for /), phone: false },
  { id: 'palette', route: '/', act: (p) => p.evaluate(() => window.dispatchEvent(new Event('bob:open-palette'))) },
  { id: 'notifications', route: '/', act: clickText('Notifications'), phone: false },
  { id: 'notification-settings', route: '/', act: then(clickText('Notifications'), clickRole('button', 'Notification settings')), phone: false },
  { id: 'account-menu', route: '/', act: clickRole('button', 'Account menu'), phone: false },
  { id: 'appearance', route: '/account', act: clickRole('button', 'Appearance'), phone: false },
  { id: 'drawer', route: '/calendar', act: clickRole('button', 'Open navigation'), desktop: false },
  { id: 'calendar', route: '/calendar' },
  { id: 'reminder-dialog', route: '/calendar', act: clickRole('button', 'New reminder') },
  { id: 'memory', route: '/memory' },
  { id: 'memory-correct', route: '/memory', act: clickRole('button', /^Correct /), phone: false },
  { id: 'memory-promote', route: '/memory', act: clickRole('button', /^Make it a task: /), phone: false },
  { id: 'devices', route: '/devices' },
  { id: 'pair', route: '/pair' },
  { id: 'connectors', route: '/connectors' },
  { id: 'gmail', route: '/gmail' },
  { id: 'account', route: '/account' },
  { id: 'reset', route: '/reset' },
  { id: 'invite-invalid', route: '/invite/not-a-real-token' },
  { id: 'space-thread', route: `/spaces/${V}/threads/${T}`, needs: [V, T] },
  { id: 'space-new-thread', route: `/spaces/${V}/threads/new`, needs: [V] },
  { id: 'space-actions', route: `/spaces/${V}/threads/${T}`, needs: [V, T], act: clickRole('button', 'Space actions'), phone: false },
  { id: 'space-rename', route: `/spaces/${V}/threads/${T}`, needs: [V, T], act: then(clickRole('button', 'Space actions'), clickRole('menuitem', 'Rename')), phone: false },
  { id: 'space-archive', route: `/spaces/${V}/threads/${T}`, needs: [V, T], act: then(clickRole('button', 'Space actions'), clickRole('menuitem', 'Archive')), phone: false },
  { id: 'space-tasks', route: `/spaces/${V}/tasks`, needs: [V] },
  { id: 'task-edit', route: `/spaces/${V}/tasks`, needs: [V], act: clickRole('button', /^Edit /) },
  { id: 'tasks-deleted', route: `/spaces/${V}/tasks`, needs: [V], act: clickText('Deleted'), phone: false },
  { id: 'space-notes', route: `/spaces/${V}/notes`, needs: [V] },
  { id: 'space-agenda', route: `/spaces/${V}/agenda`, needs: [V] },
  { id: 'event-dialog', route: `/spaces/${V}/agenda`, needs: [V], act: clickRole('button', 'New event') },
  { id: 'space-members', route: `/spaces/${V}/members`, needs: [V] },
  { id: 'new-space', route: '/', act: clickText('New space'), phone: false },
];

// Runs in the page: every mounted function component whose name is in `names`, with the union box
// of its top-level host nodes (visible ones only).
const COLLECT = (names) => {
  const want = new Set(names);
  const rootEl = document.getElementById('root');
  const ck = Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$'));
  if (!ck) return { error: 'no react root' };
  const out = {};
  const hostNodes = (fiber) => {
    const nodes = [];
    const walk = (f) => { for (let c = f.child; c; c = c.sibling) { if (c.tag === 5 && c.stateNode instanceof Element) nodes.push(c.stateNode); else walk(c); } };
    walk(fiber);
    return nodes;
  };
  const nameOf = (t) => {
    if (typeof t === 'function') return t.displayName || t.name;
    if (t && typeof t === 'object') return t.displayName || t.render?.name || t.type?.name;
    return null;
  };
  const boxOf = (fiber) => {
    let box = null;
    for (const el of hostNodes(fiber)) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      box = box ? { x: Math.min(box.x, r.x), y: Math.min(box.y, r.y), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { x: r.x, y: r.y, r: r.right, b: r.bottom };
    }
    return box ? { x: box.x, y: box.y, w: box.r - box.x, h: box.b - box.y } : null;
  };
  const visit = (f) => {
    for (let c = f; c; c = c.sibling) {
      const n = nameOf(c.type);
      if (n && want.has(n)) {
        out[n] ??= [];
        out[n].push(boxOf(c));
      }
      if (c.child) visit(c.child);
    }
  };
  // The container keeps the first HostRoot fiber; after later commits the live tree is FiberRoot.current.
  const live = rootEl[ck].stateNode?.current ?? rootEl[ck];
  visit(live.child ?? live);
  return out;
};

// Records which components a desktop state mounts and clips the first visible shot of each.
async function shootComponents(page, stateId, names, cap) {
  const found = await page.evaluate(COLLECT, names);
  if (found.error) throw new Error(found.error);
  for (const [n, boxes] of Object.entries(found)) {
    cap.mounted[n] ??= [];
    if (!cap.mounted[n].includes(stateId)) cap.mounted[n].push(stateId);
    if (cap.shot[n]) continue;
    const b = boxes.find((x) => x && x.w >= 8 && x.h >= 8 && x.y < 900 && x.x < 1440 && x.y + x.h > 0);
    if (!b) continue;
    const clip = { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4) };
    clip.width = Math.min(1440 - clip.x, b.w + 8);
    clip.height = Math.min(900 - clip.y, b.h + 8);
    if (clip.width < 8 || clip.height < 8) continue;
    await page.screenshot({ path: IMG('components', `${n}.jpg`), clip, ...JPG });
    cap.shot[n] = { file: `${n}.jpg`, state: stateId, w: Math.round(clip.width), h: Math.round(clip.height) };
  }
}

async function captureBob(browser, names) {
  const cap = { states: [], mounted: {}, shot: {}, skipped: [], failed: [] };
  // The API rate-limits /api per IP (120/min by default); a page that lost its loads to it gets one more
  // try after the bucket refills.
  const shoot = async (ctxOpts, vp, st, retry = true) => {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    try {
      // Fixed waits: the app holds an event stream open, so the network never idles.
      await page.goto(WEB + st.route, { waitUntil: 'domcontentloaded' });
      await sleep(2200);
      if (st.act) { await st.act(page); await sleep(1200); }
      await page.screenshot({ path: IMG('pages', `${st.id}-${vp}.jpg`), ...JPG });
      if (vp === 'desktop') await shootComponents(page, st.id, names, cap);
      console.log('ok', vp, st.id);
    } catch (e) {
      if (retry) {
        console.log('retry in 30s', vp, st.id, firstLine(e));
        await ctx.close();
        await sleep(30000);
        return shoot(ctxOpts, vp, st, false);
      }
      cap.failed.push({ state: st.id, vp, error: firstLine(e) });
      console.log('FAIL', vp, st.id, firstLine(e));
    } finally {
      await ctx.close();
    }
  };
  // Signed out first, so the sign-in screen is captured even when sign-in later fails.
  for (const [vp, opts] of [['desktop', DESKTOP], ['phone', PHONE]]) await shoot(opts, vp, { id: 'sign-in', route: '/', act: (p) => p.getByRole('button', { name: 'Use password instead' }).waitFor({ timeout: 20000 }) });
  cap.states.push({ id: 'sign-in', route: '/', phone: true, desktop: true });
  const session = await signIn(browser).catch((e) => {
    cap.failed.push({ state: 'sign-in as demo owner', error: firstLine(e) });
    console.log('FAIL sign-in as the demo owner; signed-in states skipped:', firstLine(e));
    return null;
  });
  const { storageState, token } = session ?? {};
  if (session) await ensureCaptureMemories(API, token, readSupabaseStatusEnv());
  for (const st of session ? states(await discover(token)) : []) {
    if (st.needs?.some((id) => !id)) { cap.skipped.push(st.id); console.log('skip (no seeded data)', st.id); continue; }
    cap.states.push({ id: st.id, route: st.route, phone: st.phone !== false, desktop: st.desktop !== false });
    for (const [vp, opts] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      if (st[vp] !== false) await shoot({ ...opts, storageState }, vp, st);
    }
  }
  fs.writeFileSync(path.join(OUT, 'bob-capture.json'), JSON.stringify(cap, null, 2));
  console.log(`bob: ${Object.keys(cap.shot).length} components shot, ${Object.keys(cap.mounted).length} of ${names.length} mounted, ${cap.skipped.length} states skipped, ${cap.failed.length} failed`);
}

// Up to two tries; returns the error line of the last failure, or null.
const attempt = async (fn) => { let err = null; for (let i = 0; i < 2; i++) { try { await fn(); return null; } catch (e) { err = firstLine(e); } } return err; };

async function captureAstryx(browser) {
  const idx = await (await fetch(`${ASTRYX}/storybook/index.json`)).json();
  const byComp = {};
  for (const s of Object.values(idx.entries || idx.stories)) {
    if (s.type !== 'story' || !s.id.startsWith('core-')) continue;
    const comp = s.title.split('/').pop();
    byComp[comp] ??= [];
    byComp[comp].push(s);
  }
  const pick = (list) => list.find((s) => /--(default|basic|playground|showcase|overview)$/.test(s.id)) || list[0];
  const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
  const shot = {};
  for (const [comp, list] of Object.entries(byComp)) {
    const s = pick(list);
    const err = await attempt(async () => {
      await page.goto(`${ASTRYX}/storybook/iframe.html?id=${s.id}&viewMode=story`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('#storybook-root').waitFor({ timeout: 15000 });
      await sleep(1200);
      const box = await page.evaluate(() => {
        let x = Infinity, y = Infinity, r = 0, b = 0;
        for (const el of document.querySelectorAll('#storybook-root *')) {
          const e = el.getBoundingClientRect();
          if (e.width < 2 || e.height < 2) continue;
          x = Math.min(x, e.x); y = Math.min(y, e.y); r = Math.max(r, e.right); b = Math.max(b, e.bottom);
        }
        return Number.isFinite(x) ? { x, y, w: r - x, h: b - y } : null;
      });
      const clip = box && { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(900, box.w + 16), height: Math.min(700, box.h + 16) };
      await page.screenshot({ path: IMG('astryx', `${comp}.jpg`), ...(clip && clip.width > 8 && clip.height > 8 ? { clip } : {}), ...JPG });
    });
    shot[comp] = { story: s.id, name: s.name, stories: list.length, ...(err && { error: err }) };
    console.log(err ? 'FAIL' : 'ok', 'astryx', comp, err ?? '');
  }
  fs.writeFileSync(path.join(OUT, 'astryx-capture.json'), JSON.stringify(shot, null, 2));
}

async function captureTemplates(browser) {
  const mapping = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/ui-v2/ux-catalog/mapping.json'), 'utf8'));
  const slugs = [...new Set([...mapping.pages.flatMap((p) => p.templates.map((t) => t.slug)), ...mapping.future.map((f) => f.template)])].sort();
  const shot = {};
  for (const [vp, opts] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    for (const slug of slugs) {
      const err = await attempt(async () => {
        // Public preview slugs are stable IDs, not normalized display titles
        // ("AI Chat Conversation" still uses "ai-chat"). Use the deep link;
        // gallery overlays can intercept clicks on its preview buttons.
        await page.goto(`${ASTRYX}/templates?preview=${slug}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.getByRole('dialog').first().waitFor({ timeout: 15000 });
        await sleep(3000);
        await page.screenshot({ path: IMG('templates', `${slug}-${vp}.jpg`), ...JPG });
      });
      shot[slug] ??= {};
      shot[slug][vp] = err ?? 'ok';
      console.log(err ? 'FAIL' : 'ok', 'template', slug, vp, err ?? '');
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, 'templates-capture.json'), JSON.stringify(shot, null, 2));
}

const names = [...new Set(JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).bob.map((c) => c.name))];
const browser = await chromium.launch();
try {
  await captureBob(browser, names);
  if (!args.includes('--skip-astryx')) {
    for (const [label, fn] of [['astryx stories', captureAstryx], ['astryx templates', captureTemplates]]) {
      await fn(browser).catch((e) => console.log(`${label} unavailable (best effort):`, firstLine(e)));
    }
  }
} finally {
  await browser.close();
}
