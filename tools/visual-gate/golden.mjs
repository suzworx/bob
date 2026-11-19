// Golden renders for the Waveshare flash gate: every case in cases.json drawn by the owner-approved demo
// (docs/waveshare/golden/approved-demo.html) in headless Chromium at 360 px, with time frozen.
//   node tools/visual-gate/golden.mjs                      re-render all and compare with the committed goldens
//   node tools/visual-gate/golden.mjs --update ready reply  re-render and overwrite only the named goldens
//   node tools/visual-gate/golden.mjs --out <dir>           render all into <dir> (no compare); --rig-dir <dir> swaps the parts
//   node tools/visual-gate/golden.mjs --text-runs           rewrite text-runs.json (each golden's text lines) only
// REST mode: the demo runs with ?freeze=rest, so Bob sits in the rest pose of the state and emotion (no breath, sway,
// gaze, blink, idle delights or state gestures) and a move is shown at a named key pose, bobDemo.poseAt(move, t).
// The firmware side is the same contract under -DBOBSIM_FREEZE=1 (bobMotionFreeze / bobMotionPoseAt).
// Determinism: Playwright's fake clock drives Date, performance.now, timers and rAF; CSS animations (ring, props)
// are paused at phase 0; Math.random is seeded. A golden changes only through --update <id>.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright'; // @playwright/test's engine, hoisted from apps/ui-v2 (as in scripts/ui-catalog)

const ROOT = resolve(import.meta.dirname, '..', '..');
const GOLDEN = resolve(ROOT, 'docs/waveshare/golden');
const DEMO = resolve(GOLDEN, 'approved-demo.html');
// The rig parts (and static fallback poses) the demo was approved with, pinned next to it: the firmware's own art moves
// on, and the demo's embedded placement only fits the parts it shipped with.
const RIG = resolve(GOLDEN, 'assets/rig');
// faithful.py swaps in the device's own resampled parts (--rig-dir) to measure what device art can score.
let rigDir = RIG;
const MANIFEST = resolve(GOLDEN, 'manifest.json');
const RIG_PARTS = readdirSync(RIG).filter((f) => f.endsWith('.png'));
const { cases } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8'));

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// The demo page and its pinned rig parts and static poses over loopback HTTP.
function serve() {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const m = url.match(/^\/assets\/(rig|static)\/([A-Za-z0-9_]+\.png)$/);
    const tok = url.match(/^\/(bob-tokens\.(?:css|js))$/);  // the design tokens the demo was approved with
    const file = url === '/' ? DEMO : m ? (m[1] === 'rig' ? resolve(rigDir, m[2]) : resolve(GOLDEN, 'assets', m[1], m[2]))
      : tok ? resolve(GOLDEN, tok[1]) : null;
    if (!file || !existsSync(file)) { res.writeHead(404).end(); return; }
    const type = { png: 'image/png', css: 'text/css', js: 'text/javascript' }[file.split('.').pop()] ?? 'text/html';
    res.writeHead(200, { 'content-type': type }).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const STEP_MS = 16;
const T0 = Date.parse('2026-01-01T00:00:00Z');

async function renderCase(browser, base, c) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  // Paused from the first instruction: no frame or timer runs on real time, so load speed cannot leak in.
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await page.addInitScript(() => {
    // performance.now counts from the real navigation start even under the fake clock; tie it to Date.
    const t0 = Date.now();
    performance.now = () => Date.now() - t0;
    let s = 0x9e3779b9; // mulberry32: the speaking level and any other randomness repeat run to run
    Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  await page.goto(`${base}?freeze=rest`, { waitUntil: 'load' });
  // Every rig part decoded up front: a pose swap mid-case must not wait on an async image load.
  await page.evaluate(async (parts) => {
    await document.fonts.ready;
    window.__rigCache = await Promise.all(parts.map(async (n) => { const i = new Image(); i.src = `assets/rig/${n}`; await i.decode(); return i; }));
  }, RIG_PARTS);
  // The demo's own manual clock drives Bob's frames (16 ms steps), so where the fake rAF grid happens to fall
  // cannot shift a pose; the fake clock moves the page's timers in the same steps.
  await page.evaluate((cs) => {
    window.bobDemo.freeze();
    window.bobDemo.setState(cs.state, { instant: true });
    if (cs.emotion) {
      const b = [...document.querySelectorAll('#emos button')].find((x) => x.textContent.trim() === cs.emotion);
      if (!b) throw new Error(`demo has no emotion ${cs.emotion}`);
      b.click();
    }
  }, c);
  for (let t = 0; t < c.atMs; t += STEP_MS) {
    const dt = Math.min(STEP_MS, c.atMs - t);
    await page.clock.runFor(dt);
    await page.evaluate((ms) => window.bobDemo.advance(ms), dt);
  }
  await page.waitForLoadState('networkidle');
  if (c.move) {
    const ok = await page.evaluate((cs) => window.bobDemo.poseAt(cs.move, cs.t), c);
    if (!ok) throw new Error(`demo has no move ${c.move}`);
  }
  // Ring and prop animations at phase 0: the same constant the sim's frozen ring draws.
  // Transitions (the rig scaling into a view) are finished, never rewound: whether one exists at all depends on a style
  // recalc landing before the state change, and rewinding it would show Bob at his previous size.
  await page.evaluate(() => document.getAnimations().forEach((a) => {
    if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) a.finish();
    else { a.pause(); a.currentTime = 0; }
  }));
  // The glass box, snapped to whole pixels (the scaled device can sit on a half pixel).
  const box = await page.locator('#glass').boundingBox();
  const origin = { x: Math.round(box.x), y: Math.round(box.y) };
  const png = await page.screenshot({ clip: { ...origin, width: 360, height: 360 }, animations: 'allow', caret: 'hide' });
  const runs = await page.evaluate(textRuns, origin);
  await page.close();
  return { png, runs };
}

// Every case is rendered again 891 ms (27 frames) earlier on every run: REST mode must give the same bytes, or the
// demo's Bob is moving. Both captures fall inside the same pairing-countdown second.
const STILL_CASES = cases.map((c) => c.id);
const STILL_EARLIER_MS = 891;

/**
 * The text the golden shows, one entry per visible line: the string, its line box in glass pixels, and its CSS size,
 * weight and colour. faithful.py redraws each line with the device's own font to measure what device text can score.
 * Props (the ✦ ? ♪ glyphs in #props and #fx) are shapes on the device, not text, and are left out.
 */
function textRuns(origin) {
  const glass = document.getElementById('glass');
  const out = [];
  const walker = document.createTreeWalker(glass, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || el.closest('#props, #fx')) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const cs = getComputedStyle(el);
    const lines = [];
    for (let i = 0; i < n.length; i += 1) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      let line = lines.find((l) => Math.abs(l.top - b.top) < 2);
      if (!line) { line = { top: b.top, text: '', x0: b.left, x1: b.right, y0: b.top, y1: b.bottom }; lines.push(line); }
      line.text += n.textContent[i];
      line.x0 = Math.min(line.x0, b.left); line.x1 = Math.max(line.x1, b.right);
      line.y0 = Math.min(line.y0, b.top); line.y1 = Math.max(line.y1, b.bottom);
    }
    for (const l of lines) {
      const text = l.text.trim();
      if (!text) continue;
      const r = (v) => Math.round(v * 100) / 100;
      out.push({ text, x0: r(l.x0 - origin.x), x1: r(l.x1 - origin.x), y0: r(l.y0 - origin.y), y1: r(l.y1 - origin.y),
        size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), color: cs.color, family: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() });
    }
  }
  return out;
}

const TEXT_RUNS = resolve(GOLDEN, 'text-runs.json');

export async function renderAll(ids, outDir) {
  const server = await serve();
  const browser = await chromium.launch();
  const out = {};
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    for (const c of cases.filter((x) => ids.includes(x.id))) {
      out[c.id] = await renderCase(browser, base, c);
      if (outDir) writeFileSync(join(outDir, `${c.id}.png`), out[c.id].png);
    }
    for (const c of cases.filter((x) => STILL_CASES.includes(x.id))) {
      const main = (out[c.id] ?? await renderCase(browser, base, c)).png;
      const earlier = (await renderCase(browser, base, { ...c, atMs: c.atMs - STILL_EARLIER_MS })).png;
      if (!main.equals(earlier)) throw new Error(`the demo's Bob is not held still in REST mode: ${c.id} at ${c.atMs - STILL_EARLIER_MS} ms and ${c.atMs} ms differ`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const all = cases.map((c) => c.id);
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { goldens: {} };
  const demoSha = sha256(readFileSync(DEMO));

  if (args[0] === '--text-runs') {
    // The goldens' text lines (for faithful.py), rewritten without touching a golden PNG.
    const rendered = await renderAll(all, null);
    writeFileSync(TEXT_RUNS, `${JSON.stringify(Object.fromEntries(all.map((id) => [id, rendered[id].runs])), null, 1)}\n`);
    console.log(`text runs for ${all.length} goldens written to ${TEXT_RUNS}`);
    return 0;
  }
  if (args[0] === '--out') {
    // --out <dir> [--rig-dir <dir>]: render every case, optionally with other rig parts (faithful.py's device art)
    if (args[2] === '--rig-dir') rigDir = resolve(args[3]);
    mkdirSync(args[1], { recursive: true });
    await renderAll(all, args[1]);
    console.log(`rendered ${all.length} goldens into ${args[1]}`);
    return 0;
  }
  if (args[0] === '--update') {
    const ids = args.slice(1);
    const unknown = ids.filter((id) => !all.includes(id));
    if (!ids.length || unknown.length) {
      console.error(`--update needs the case ids to replace (unknown: ${unknown.join(', ') || 'none given'}); known: ${all.join(' ')}`);
      return 2;
    }
    const rendered = await renderAll(ids, GOLDEN);
    const runs = existsSync(TEXT_RUNS) ? JSON.parse(readFileSync(TEXT_RUNS, 'utf8')) : {};
    for (const id of ids) {
      const c = cases.find((x) => x.id === id);
      const png = rendered[id].png;
      manifest.goldens[id] = { file: `${id}.png`, sha256: sha256(png), demoSha256: demoSha, case: c, updated: new Date().toISOString().slice(0, 10) };
      runs[id] = rendered[id].runs;
      console.log(`golden ${id} updated (${sha256(png).slice(0, 12)})`);
    }
    writeFileSync(TEXT_RUNS, `${JSON.stringify(Object.fromEntries(all.filter((id) => runs[id]).map((id) => [id, runs[id]])), null, 1)}\n`);
    manifest.about = 'Goldens for the Waveshare flash gate (tools/visual-gate). Change one only with: node tools/visual-gate/golden.mjs --update <id>.';
    manifest.goldens = Object.fromEntries(Object.entries(manifest.goldens).sort(([a], [b]) => all.indexOf(a) - all.indexOf(b)));
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  }
  // Check: every case has a golden, the committed PNG matches the manifest, and a fresh render reproduces it.
  const dir = mkdtempSync(join(tmpdir(), 'bob-golden-'));
  const rendered = await renderAll(all, dir);
  const runs = existsSync(TEXT_RUNS) ? JSON.parse(readFileSync(TEXT_RUNS, 'utf8')) : {};
  let bad = 0;
  for (const id of all) {
    const g = manifest.goldens[id];
    const file = resolve(GOLDEN, `${id}.png`);
    const committed = existsSync(file) ? sha256(readFileSync(file)) : null;
    const fresh = sha256(rendered[id].png);
    const why = !g ? 'no manifest entry' : committed !== g.sha256 ? 'committed PNG does not match the manifest'
      : fresh !== g.sha256 ? `a fresh render differs (see ${join(dir, `${id}.png`)})`
        : JSON.stringify(runs[id]) !== JSON.stringify(rendered[id].runs) ? 'text-runs.json does not match a fresh render (node tools/visual-gate/golden.mjs --text-runs)' : null;
    console.log(`${why ? 'DRIFT' : 'ok   '} ${id}${why ? `: ${why}` : ''}`);
    if (why) bad += 1;
  }
  console.log(bad ? `${bad} golden(s) drifted; replace one only with --update <id>` : 'goldens reproduce byte for byte');
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
