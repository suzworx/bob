/*
 * env-lint.mjs — pure checks over .env text for setup.mjs.
 *
 * Findings carry key names and remedies only; values must never be echoed,
 * into logs or messages, because .env holds credentials.
 */

const REQUIRED_FOR_LIVE = 'AI_GATEWAY_API_KEY';
const BROWSER_TOKEN = 'BOB_WEB_TOKEN';
const MIN_TOKEN_LENGTH = 16;

// Known misspellings of real keys seen in the wild, mapped to the correct
// name. A silent misspelling looks exactly like a missing credential.
const KNOWN_TYPOS = new Map([
  ['OPEN_ROUTER_API_KEY', REQUIRED_FOR_LIVE],
]);

function parseLines(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    entries.push({ name: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return entries;
}

export function lintEnvText(text) {
  const entries = parseLines(text);
  const byName = new Map(entries.map((entry) => [entry.name, entry.value]));
  const findings = [];

  for (const [typo, correct] of KNOWN_TYPOS) {
    if (!byName.has(typo)) continue;
    if (byName.has(correct)) {
      findings.push({
        level: 'warn',
        code: 'redundant_typo',
        message: `.env defines both ${typo} and ${correct}; the app reads only ${correct}. Delete the ${typo} line.`,
      });
    } else {
      findings.push({
        level: 'error',
        code: 'typo_key',
        message: `.env defines ${typo}, which nothing reads. Rename it to ${correct} or live provider calls will silently have no credential.`,
      });
    }
  }

  const hasLiveKey = Boolean(byName.get(REQUIRED_FOR_LIVE));
  const systemTest = byName.get('BOB_SYSTEM_TEST');
  if (!hasLiveKey && systemTest !== '1') {
    findings.push({
      level: 'warn',
      code: 'no_provider',
      message: `${REQUIRED_FOR_LIVE} is empty and BOB_SYSTEM_TEST is not 1: chat and voice will fail upstream. Set the key for live runs, or BOB_SYSTEM_TEST=1 for stub replies.`,
    });
  }

  const token = byName.get(BROWSER_TOKEN) ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    findings.push({
      level: 'warn',
      code: 'weak_token',
      message: `${BROWSER_TOKEN} is missing or too short (<${MIN_TOKEN_LENGTH} chars). On the default non-loopback bind the browser routes under /api/* stay unmounted without it.`,
    });
  }

  return findings;
}
