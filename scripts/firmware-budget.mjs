import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * firmware-budget.mjs — static memory budget for the Cardputer firmware.
 *
 * Reads PlatformIO's size summary (the "RAM: [..] (used N bytes from M bytes)"
 * and "Flash: ..." lines every `pio run` prints) and holds it against
 * apps/cardputer/memory-budget.json: over a region's limitBytes fails, growth
 * over baselineBytes by more than growthWarnBytes warns (a GitHub Actions
 * ::warning:: in CI), and a changed region size fails so a partition or board
 * change re-bases the budget on purpose. The runtime heap table in the same
 * JSON is documentation; docs/cardputer/testing.md explains the policy.
 *
 *   node scripts/firmware-budget.mjs --check               runs `pio run`, then checks
 *   node scripts/firmware-budget.mjs --check --log <file>  checks a saved `pio run` log
 *
 * Without --check it prints the report and always exits 0. PlatformIO runs as
 * $BOB_PIO when set (e.g. "pio"), else through the Python launcher as
 * apps/cardputer/scripts/run-pio.mjs does ($BOB_PIO_PY, default "py -3.11").
 */

const ROOT = resolve(import.meta.dirname, '..');
const APP_DIR = resolve(ROOT, 'apps/cardputer');
const BUDGET_FILE = resolve(APP_DIR, 'memory-budget.json');
const LABELS = { ram: 'RAM', flash: 'flash' };

// Strips ANSI colour codes and returns the last RAM/Flash summary, or null
// when either line is missing (a failed or interrupted build).
export function parseSizeReport(text) {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  const last = (label) => {
    const pattern = new RegExp(`^${label}:.*\\(used (\\d+) bytes from (\\d+) bytes\\)`, 'gm');
    const matches = [...plain.matchAll(pattern)];
    const match = matches.at(-1);
    return match ? { usedBytes: Number(match[1]), totalBytes: Number(match[2]) } : null;
  };
  const ram = last('RAM');
  const flash = last('Flash');
  return ram && flash ? { ram, flash } : null;
}

function formatBytes(bytes) {
  return Math.abs(bytes) < 10 * 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

// Holds a parsed report against budget.static. Pure, so the tests drive it.
export function checkBudget(report, budget) {
  const errors = [];
  const warnings = [];
  for (const region of ['ram', 'flash']) {
    const label = LABELS[region];
    const { usedBytes, totalBytes } = report[region];
    const limits = budget.static[region];
    if (totalBytes !== limits.totalBytes) {
      errors.push(`${label} region is ${totalBytes} B, budget assumes ${limits.totalBytes} B: re-base apps/cardputer/memory-budget.json`);
    }
    if (usedBytes > limits.limitBytes) {
      errors.push(`${label} ${usedBytes} B is over the ${limits.limitBytes} B limit (${((usedBytes / totalBytes) * 100).toFixed(1)}% of ${totalBytes} B)`);
    }
    const growth = usedBytes - limits.baselineBytes;
    if (growth > limits.growthWarnBytes) {
      warnings.push(`${label} grew ${formatBytes(growth)} over the ${limits.baselineBytes} B baseline (warns above ${formatBytes(limits.growthWarnBytes)})`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function runPio() {
  const command = process.env.BOB_PIO
    ? process.env.BOB_PIO.split(' ')
    : [...(process.env.BOB_PIO_PY ?? 'py -3.11').split(' '), '-m', 'platformio'];
  const [bin, ...args] = command;
  const result = spawnSync(bin, [...args, 'run', '-e', 'm5stack-cardputer-v2-poc'], {
    cwd: APP_DIR, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) console.error(`firmware-budget: ${bin}: ${result.error.message}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const isDirectRun = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const check = process.argv.includes('--check');
  const logIndex = process.argv.indexOf('--log');
  const text = logIndex > 0 ? readFileSync(resolve(process.argv[logIndex + 1]), 'utf8') : runPio();
  const report = parseSizeReport(text);
  if (!report) {
    console.error(text.split('\n').slice(-30).join('\n'));
    console.error('firmware-budget: no RAM/Flash size summary found; did the build fail?');
    process.exit(1);
  }
  const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  const result = checkBudget(report, budget);
  for (const region of ['ram', 'flash']) {
    const { usedBytes, totalBytes } = report[region];
    const { limitBytes, baselineBytes } = budget.static[region];
    console.log(`${LABELS[region].padEnd(5)} ${String(usedBytes).padStart(8)} B used / ${limitBytes} B limit / ${totalBytes} B region` +
      ` (${((usedBytes / totalBytes) * 100).toFixed(1)}%, ${usedBytes - baselineBytes >= 0 ? '+' : ''}${usedBytes - baselineBytes} B vs baseline)`);
  }
  const ci = Boolean(process.env.GITHUB_ACTIONS);
  for (const warning of result.warnings) console.warn(ci ? `::warning title=firmware budget::${warning}` : `WARN: ${warning}`);
  for (const error of result.errors) console.error(ci ? `::error title=firmware budget::${error}` : `FAIL: ${error}`);
  console.log(`firmware-budget: ${result.ok ? 'within budget' : 'OVER BUDGET'}`);
  process.exit(check && !result.ok ? 1 : 0);
}
