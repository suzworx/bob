// The Waveshare flash gate, end to end: render the firmware (bob-sim), diff it against the approved-demo goldens,
// and record the verdict for this exact firmware in data/visual-pass.json, which every Waveshare flash checks.
//   npm run visual:gate                               the firmware in this checkout
//   npm run visual:gate -- --fw <checkout>            another checkout (its own data/visual-pass.json is written)
//   npm run visual:gate -- --candidates <dir>         judge given renders, e.g. device captures named <id>.png
//                                                     (`T ui <state>` + `npm run screenshot` on the hil build);
//                                                     report only: a flash pass is only ever written from bob-sim
//   npm run visual:gate -- --rig on|off               the Bob variant to judge; default: what a flash from this
//                                                     environment builds (BOB_RIG=1 = the rig renderer)
//   npm run visual:gate -- --check                    only say whether the record allows a flash (exit 0/1)
//   npm run visual:gate -- --require                  validate's step: run the gate unless a pass for this tree is on record
// Exit 0 only when every case passes. Reports land in <checkout>/data/visual-gate/report/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderCandidates } from './candidate.mjs';
import { checkVisualPass, deviceRig, goldenManifestSha, PASS_FILE, rigOffHint, variantCases } from './flash-guard.mjs';
import { firmwareHashOnDisk } from '../../scripts/hil/firmware-hash.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, 'cases.json'), 'utf8')).cases;
const PY = (process.env.BOB_PY ?? (process.platform === 'win32' ? 'py -3.11' : 'python3')).split(' ');

export function runGate({ fw = ROOT, candidates = null, rig = deviceRig() } = {}) {
  fw = resolve(fw);
  const work = resolve(fw, 'data/visual-gate');
  const candDir = candidates ? resolve(candidates) : resolve(work, 'candidates');
  if (!candidates) {
    rmSync(resolve(fw, PASS_FILE), { force: true });  // a failed render must not leave an older pass standing
    renderCandidates(fw, candDir, { rig });  // throws, naming each case without a render
  }
  const report = resolve(work, 'report');
  const diff = spawnSync(PY[0], [...PY.slice(1), '-I', resolve(import.meta.dirname, 'diff.py'), '--golden', resolve(ROOT, 'docs/waveshare/golden'),
    '--candidate', candDir, '--out', report], { stdio: 'inherit' });
  if (diff.status !== 0 && diff.status !== 1) throw new Error(`diff.py failed to run (exit ${diff.status})`);
  const full = JSON.parse(readFileSync(resolve(report, 'report.json'), 'utf8'));
  // diff.py judges every case in cases.json; a rig-off build has no render for the rig-only moves, so only this variant's cases count.
  const judged = new Set(variantCases(spec, rig).map((c) => c.id));
  const results = full.cases.filter((c) => judged.has(c.id));
  const pass = results.length === judged.size && results.every((c) => c.pass);
  if (candidates) {
    console.log(`[visual-gate] ${pass ? 'PASS' : 'FAIL'} for the renders in ${candDir} (report only, no flash pass); sheets in ${report}`);
    return pass;
  }
  const record = {
    firmwareHash: firmwareHashOnDisk(fw),
    goldenManifestSha: goldenManifestSha(ROOT),
    source: 'bob-sim',
    rig,
    variant: rig ? 'rig-on' : 'rig-off',
    caseCount: judged.size,
    judgedAt: new Date().toISOString(),
    pass,
    thresholds: full.thresholds,
    cases: results.map((c) => ({ id: c.id, pass: c.pass, scores: c.scores, failures: c.failures.map((f) => f.check) })),
  };
  mkdirSync(resolve(fw, 'data'), { recursive: true });
  writeFileSync(resolve(fw, PASS_FILE), `${JSON.stringify(record, null, 2)}\n`);
  const passed = record.cases.filter((c) => c.pass).length;
  console.log(`[visual-gate] ${pass ? 'PASS' : 'FAIL'}: ${passed}/${record.cases.length} states (${record.variant}); recorded in ${resolve(fw, PASS_FILE)}; sheets in ${report}`);
  return pass;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const rigArg = arg('--rig');
  if (rigArg && !['on', 'off'].includes(rigArg)) { console.error('[visual-gate] --rig takes on or off'); process.exit(2); }
  const rig = rigArg ? rigArg === 'on' : deviceRig();
  const hint = rigOffHint(rig);
  const printHint = () => { if (hint) console.error(`[visual-gate] hint: ${hint}`); };
  if (argv.includes('--check') || argv.includes('--require')) {
    const problem = checkVisualPass(resolve(arg('--fw') ?? ROOT), rig);
    console.log(problem ? `[visual-gate] no flash: ${problem}` : '[visual-gate] PASS on record for this firmware');
    if (!problem || argv.includes('--check')) {
      if (problem) printHint();
      process.exit(problem ? 1 : 0);
    }
  }
  try {
    const pass = runGate({ fw: arg('--fw') ?? ROOT, candidates: arg('--candidates'), rig });
    if (!pass) printHint();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`[visual-gate] ${e.message}`);
    printHint();
    process.exit(1);
  }
}
