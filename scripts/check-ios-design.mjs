#!/usr/bin/env node
/**
 * iOS design consistency ratchet (apps/ios/DESIGN.md §8).
 *
 * Screens must draw with the shared design system (apps/ios/Bob/Bob/DesignSystem): BobColor, BobFont,
 * BobLayout, BobMotion, BobFeedback. This counts, per Swift file and per rule, the places a screen goes
 * around it. A count may fall but never rise, and a file not in the baseline starts at zero, so new code
 * is fully consistent while old screens are rebuilt one by one.
 *
 *   node scripts/check-ios-design.mjs            check against scripts/ios-design-baseline.json
 *   node scripts/check-ios-design.mjs --update   record counts that fell (refuses to raise any)
 *   ... --update --allow-increase                record a rise on purpose
 *
 * `countViolations` and `compare` are pure and exported for `npm run test:scripts`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ios/Bob/Bob');
const EXEMPT_DIR = 'DesignSystem/';
const BASELINE_PATH = join(ROOT, 'scripts/ios-design-baseline.json');
const posix = (p) => p.split(sep).join('/');

const TEXT_STYLES = 'largeTitle|title|title2|title3|headline|subheadline|body|callout|footnote|caption|caption2';

/** Rule name -> pattern that counts one place a screen bypasses the design system. */
export const RULES = {
  'raw-font': new RegExp(String.raw`\.font\(\s*(?:\.system\(|Font\.system\(|\.custom\(|\.(?:${TEXT_STYLES})\b)`, 'g'),
  'raw-color': /\b(?:UI)?Color\(\s*(?:red:|white:|hue:|\.system|hex)|\bColor\.(?:red|blue|green|orange|yellow|purple|pink|gray|grey|black|white|brown|cyan|mint|teal|indigo)\b/g,
  'system-grey': /\.foreground(?:Style|Color)\(\s*\.(?:secondary|tertiary|quaternary)\b/g,
  'literal-radius': /cornerRadius:\s*\d/g,
  shadow: /\.shadow\(/g,
  'raw-haptic': /\.sensoryFeedback\(|UI(?:Impact|Notification|Selection)FeedbackGenerator/g,
  'raw-animation': /\.(?:spring|easeInOut|easeOut|easeIn|linear|interpolatingSpring|bouncy|snappy|smooth)\(/g,
};

/** `{ rule: count }` for one Swift source, comments ignored; rules with no hit are left out. */
export function countViolations(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = {};
  for (const [rule, pattern] of Object.entries(RULES)) {
    const hits = code.match(pattern)?.length ?? 0;
    if (hits) out[rule] = hits;
  }
  return out;
}

/** Problems where `current` exceeds `baseline` (`{ file: { rule: count } }`), plus counts that fell. */
export function compare(current, baseline) {
  const rises = [];
  const falls = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (count > allowed) rises.push(`${file}: ${rule} ${allowed} -> ${count}`);
    }
  }
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, count] of Object.entries(rules)) {
      const now = current[file]?.[rule] ?? 0;
      if (now < count) falls.push(`${file}: ${rule} ${count} -> ${now}`);
    }
  }
  return { rises, falls };
}

function* swiftFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* swiftFiles(full);
    else if (entry.name.endsWith('.swift')) yield full;
  }
}

export function measure(appDir = APP) {
  const out = {};
  for (const file of swiftFiles(appDir)) {
    const rel = posix(relative(appDir, file));
    if (rel.startsWith(EXEMPT_DIR)) continue;
    const counts = countViolations(readFileSync(file, 'utf8'));
    if (Object.keys(counts).length) out[rel] = counts;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const current = measure();
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};
  const { rises, falls } = compare(current, baseline);
  if (args.has('--update')) {
    if (rises.length && !args.has('--allow-increase')) {
      console.error(`ios design: refusing to raise the baseline:\n  ${rises.join('\n  ')}`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`ios design: baseline written (${Object.keys(current).length} files)`);
    return;
  }
  if (rises.length) {
    console.error('ios design: a screen draws around the design system (apps/ios/DESIGN.md).');
    console.error('Use BobColor, BobFont, BobLayout, BobMotion and BobFeedback instead:');
    console.error(`  ${rises.join('\n  ')}`);
    process.exit(1);
  }
  if (falls.length) {
    console.error(`ios design: counts fell; record them with --update so they cannot creep back:\n  ${falls.join('\n  ')}`);
    process.exit(1);
  }
  const total = Object.values(current).reduce((n, r) => n + Object.values(r).reduce((a, b) => a + b, 0), 0);
  console.log(`ios design: ok (${total} legacy places left to move onto the design system)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
