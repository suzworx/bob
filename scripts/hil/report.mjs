/*
 * report.mjs — the evidence a HIL run leaves behind, shaped for a PR body.
 * data/hil/<run-id>/report.md holds the scenario table plus, per scenario,
 * the console exchanges and journal lines that satisfied (or failed) it.
 */

const ICON = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

/** Replaces every MAC address (esptool prints the chip's on each flash) so
 *  none reaches a run log. The device's `T ping` id stands in for it. */
export function redactMacs(text) {
  return String(text).replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, '<mac>');
}

export function newRunId(now = new Date(), random = Math.random) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.floor(random() * 0xffff).toString(16).padStart(4, '0')}`;
}

export function scenarioTable(results) {
  const rows = results.map((r) => `| ${r.name} | ${r.issue} | ${ICON[r.status]} | ${r.ms ?? 0} | ${(r.reason ?? '').replace(/\|/g, '\\|')} |`);
  return ['| Scenario | Issue | Result | ms | Note |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function counts(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  return { pass: n('pass'), fail: n('fail'), skip: n('skip') };
}

export function renderReport({ runId, firmwareHash, head, flashed, ping, results, attested, notAttestedReason, hilEnv = 'm5stack-cardputer-hil' }) {
  const { pass, fail, skip } = counts(results);
  const evidence = results
    .filter((r) => r.evidence?.length)
    .map((r) => `### ${r.name} (${ICON[r.status]})\n\n\`\`\`text\n${r.evidence.slice(-20).join('\n')}\n\`\`\``)
    .join('\n\n');
  return [
    `# HIL run ${runId}`,
    '',
    `- HEAD: \`${head}\`  firmware hash: \`${firmwareHash}\``,
    `- flashed this run: ${flashed ? `yes (${hilEnv})` : 'no (--no-flash)'}; device: \`${ping ?? 'no pong'}\``,
    `- result: ${pass} passed, ${fail} failed, ${skip} skipped`,
    `- attested: ${attested ? 'yes, data/hil-pass.json written' : `no — ${notAttestedReason}`}`,
    '',
    scenarioTable(results),
    '',
    '## Evidence',
    '',
    evidence || '_none_',
    '',
    'Full logs beside this file: `serial.log` (device, `>>` marks console commands), `server-journal.log`, `flash.log`.',
    '',
  ].join('\n');
}

/** Whether a run may be recorded as the pass for HEAD's firmware, and why not. */
export function recordable({ results, fullSet, diskHash, headHash, flashed, pingBuild, headSha }) {
  const { pass, fail } = counts(results);
  if (!fullSet) return { ok: false, reason: '--scenario ran a subset; only a full run is recorded' };
  if (fail > 0) return { ok: false, reason: `${fail} scenario(s) failed` };
  if (pass === 0) return { ok: false, reason: 'no scenario passed' };
  if (diskHash !== headHash) return { ok: false, reason: 'the firmware on disk differs from HEAD; commit it and re-run' };
  if (!flashed) {
    const build = String(pingBuild ?? '');
    const matches = build.length >= 7 && build !== 'dev' && (headSha.startsWith(build) || build.startsWith(headSha));
    if (!matches) return { ok: false, reason: `--no-flash and the device reports build=${build || '?'}, not HEAD; flash it` };
  }
  return { ok: true };
}
