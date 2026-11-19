/**
 * npm run ui:mobile-sweep [label]: screenshots every phone screen (the SCREENS
 * table of e2e/pages/mobile-layout.ts) at 390x844 against the e2e stack, saves
 * data/mobile-sweep/<label>/<screen>.png, and writes <screen>-vs-mockup.png
 * beside the matching docs/design/images/bob-mobile-v4 mockup. Exits non-zero
 * when any screen shows a role=alert error. The stack, account and rate limit
 * come from the Playwright config (mobile-390 project), not from this script.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { SCREENS } from '../e2e/pages/mobile-layout.ts';
import { REPO_ROOT, UI_ROOT } from '../e2e/stack.ts';

const label = process.argv[2] ?? new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(REPO_ROOT, 'data', 'mobile-sweep', label);
const mockupDir = join(REPO_ROOT, 'docs', 'design', 'images', 'bob-mobile-v4');
mkdirSync(outDir, { recursive: true });

const run = spawnSync(
  'npx',
  ['playwright', 'test', '--config', join(UI_ROOT, 'playwright.config.ts'), '--project=mobile-390', 'mobile-layout', '-g', 'sweep:'],
  { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, BOB_MOBILE_SWEEP_DIR: outDir } },
);

const dataUrl = (file: string): string => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

const browser = await chromium.launch({ channel: process.env.CI ? 'chromium' : 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  for (const screen of SCREENS) {
    const shot = join(outDir, `${screen.label}.png`);
    const mockup = screen.mockup ? join(mockupDir, `${screen.mockup}.png`) : undefined;
    if (!existsSync(shot) || !mockup || !existsSync(mockup)) continue;
    await page.setContent(
      `<body style="margin:0;background:#888;display:flex;gap:16px;padding:16px;align-items:flex-start;width:max-content">` +
        `<figure style="margin:0"><figcaption style="color:#fff;font:14px sans-serif">${screen.label} (app)</figcaption><img style="height:844px" src="${dataUrl(shot)}"></figure>` +
        `<figure style="margin:0"><figcaption style="color:#fff;font:14px sans-serif">${screen.mockup} (mockup)</figcaption><img style="height:844px" src="${dataUrl(mockup)}"></figure></body>`,
    );
    await page.locator('img').last().evaluate((img: HTMLImageElement) => img.decode());
    await page.screenshot({ path: join(outDir, `${screen.label}-vs-mockup.png`), fullPage: true });
  }
} finally {
  await browser.close();
}

console.log(`mobile sweep: ${outDir}`);
process.exit(run.status ?? 1);
