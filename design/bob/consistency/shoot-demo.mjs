// Renders each device state of the demo page (docs/waveshare/device-ux-prototype.html) to a 360x360 PNG of the glass.
//   node design/bob/consistency/shoot-demo.mjs <outDir> [state ...]
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const out = resolve(process.argv[2] || 'out/consistency');
const wanted = process.argv.slice(3);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => { const st = document.createElement('style'); st.textContent = '.sb{animation:none!important}'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st)); });
await page.goto(pathToFileURL(resolve(root, 'docs/waveshare/device-ux-prototype.html')).href);
await page.waitForTimeout(800);
const ids = wanted.length ? wanted : await page.$$eval('#states button', (b) => b.map((x) => x.dataset.id));
for (const id of ids) {
  await page.click(`#states button[data-id="${id}"]`);
  await page.waitForTimeout(1600);
  const box = await (await page.$('#glass')).boundingBox();
  await page.screenshot({ path: resolve(out, `demo-${id}.png`), clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  console.log(`demo-${id}.png ${Math.round(box.width)}x${Math.round(box.height)}`);
}
await browser.close();
