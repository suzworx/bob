/**
 * #550: `npm run test:e2e:live` -- the suite against the REAL AI Gateway.
 * This spends money: every chat turn is a paid model call, capped per run by
 * BOB_E2E_LIVE_MAX_TURNS (default 8, enforced in fixtures.ts). Extra
 * arguments pass through to Playwright (e.g. a spec name or --project).
 */
import { spawnSync } from 'node:child_process';
import { UI_ROOT } from './stack.ts';

console.log(
  `[e2e] LIVE mode: real AI Gateway calls (paid), at most ${process.env.BOB_E2E_LIVE_MAX_TURNS ?? '8'} chat turns this run.`,
);
const result = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], {
  cwd: UI_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, BOB_E2E_LIVE: '1' },
});
process.exit(result.status ?? 1);
