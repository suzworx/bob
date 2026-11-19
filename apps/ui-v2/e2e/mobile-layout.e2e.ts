/**
 * Phone-layout gate (#1349 round 3): every screen at 390x844 stays inside the
 * 14..376 gutter, has no overflow, "//" text or error banner, a slim composer
 * and a short header above its first list item. Real browser geometry.
 *
 * KNOWN_GAPS lists assertions that fail today. Each is wrapped in test.fail(),
 * so the gate is green now and turns RED the moment a gap is fixed without its
 * entry being removed. Each round-3 unit deletes its own entries.
 *
 * With BOB_MOBILE_SWEEP_DIR set (npm run ui:mobile-sweep) the file instead
 * defines one "sweep:" test per screen that saves a PNG there.
 */
import { join } from 'node:path';
import { expect, test } from './fixtures.ts';
import { ASSERTIONS, SCREENS, measureScreen, type AssertionName, type Measurement, type Screen } from './pages/mobile-layout.ts';

const KNOWN_GAPS: Record<string, AssertionName[]> = {
  // Search + tabs above the list put the first memory at ~173px, about where
  // mockup 10-memory has it; tighten when the page header is reworked.
  memory: ['listGap'],
  // Astryx SideNav rows span the drawer panel to x 382 and it has no inner
  // gutter prop (R4-SHELL); the text inside sits within the gutter.
  drawer: ['bounds'],
};

const SWEEP_DIR = process.env.BOB_MOBILE_SWEEP_DIR;
const measured = new Map<string, Measurement>();

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'mobile-390', 'the phone-layout gate runs at 390x844 only');
});

async function measure(screen: Screen, fx: Parameters<typeof measureScreen>[1]): Promise<Measurement> {
  const cached = measured.get(screen.label);
  if (cached) return cached;
  const result = await measureScreen(screen, fx);
  measured.set(screen.label, result);
  return result;
}

if (SWEEP_DIR) {
  for (const screen of SCREENS) {
    test(`sweep: ${screen.label}`, async ({ page, api, tag, seed, cleanup }) => {
      const { failures } = await measureScreen(screen, { page, api, tag, seed, cleanup });
      await page.screenshot({ path: join(SWEEP_DIR, `${screen.label}.png`) });
      expect(failures.alerts ?? [], 'role=alert error banner').toEqual([]);
    });
  }
} else {
  for (const screen of SCREENS) {
    test.describe(screen.label, () => {
      for (const name of ASSERTIONS) {
        if ((name === 'composer' || name === 'inlineMessageActions') && !screen.chat) continue;
        if (name === 'listGap' && !screen.list) continue;
        if (name === 'reachable' && !screen.reachable) continue;
        test(name, async ({ page, api, tag, seed, cleanup }) => {
          if (KNOWN_GAPS[screen.label]?.includes(name)) test.fail();
          const { failures } = await measure(screen, { page, api, tag, seed, cleanup });
          expect(failures[name] ?? [], `${screen.label}: ${name}`).toEqual([]);
        });
      }
    });
  }
}
