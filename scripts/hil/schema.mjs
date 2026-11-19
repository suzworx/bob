import { JournalMatch } from './journal-match.mjs';

/*
 * schema.mjs — the shape of a HIL scenario, checked without hardware.
 *
 * A scenario is data: { name, issue, title, requires?, steps }. Each step has
 * exactly one action:
 *   send: 'T …'              a raw console command; awaits its `T> ` reply
 *                            (optional `expect` regex on the reply text)
 *   press: 'n' | 'enter' | 'backtick' | 'del' | 'tab' | 'fn ,' | 'fn /' | 'fn `'
 *          | 'btn down' | 'btn up'
 *                            a key or the GO button via the console; awaits `T> ok`
 *   waitBootWifi: true       boot Wi-Fi readiness, allowing exactly one60s
 *                            failed-round backoff and its bounded retry round
 *   waitDevice: /re/         a device serial line after the last send/press
 *   waitServer: /re/         a server journal line (raw JSON) after the same mark
 *   noDevice: /re/           no device line matching /re/ arrives within
 *   noServer: /re/           timeoutMs (required) after the mark; the step
 *                            always waits the whole window
 *   cleanSerial: true        every device line since the scenario began is a
 *                            journal line (`<ms> INFO v2.<event> state=…`) or
 *                            a console reply (`T> …`): no raw prints
 *   assertState: { state, mode, vol, muted, dnd }   `T state` readback; a value
 *                            may be { same: 'x' }, { differs: 'x' } or
 *                            { delta: n, of: 'x' } against a saveState snapshot.
 *                            With timeoutMs it polls `T state` until it matches
 *                            or the timeout ends; without, one readback decides
 *   saveState: 'x'           snapshot `T state` under a name
 *   assertHeapMin: { free, min, largest }   `T heap` floors in bytes
 *   sleep: ms
 *   playAudio: 'data/….wav'  plays a repo-relative WAV through the PC's default
 *                            speaker and waits for it to end (it must also be
 *                            listed in requiresFiles). With `until: /re/` it
 *                            plays up to `repeat` times (1-10), waiting
 *                            timeoutMs (default 2 s) after each play for a
 *                            device line matching /re/, and stops at the first
 * Waits may set `since: 'run'` to also match lines from before the scenario.
 * Any step may set `onlyIf: /re/`: it runs only when a device line matching
 * /re/ arrived since the last send/press/playAudio, else it is skipped (the
 * evidence says so), e.g. waiting out a turn only if a detection opened one.
 * Every step may set timeoutMs (default 10 s, at most 10 min).
 *
 * `requires: [{ event, feature }]` names firmware journal events the scenario
 * depends on. When the firmware source has no such event the feature is not
 * built yet and the scenario reports SKIP with the reason — never PASS.
 * `board: 'cardputer' | 'waveshare'` runs the scenario only on that board's
 * hil env (`waveshare-…` envs are the Waveshare); elsewhere it reports SKIP.
 * Without it the scenario runs on both.
 * `requiresFiles: ['data/….wav']` does the same for local, git-ignored test
 * media (e.g. a recorded wake word): absent on this PC, the scenario SKIPs.
 * `expectsReconnect: true` marks a scenario whose steps make the device
 * reconnect on purpose (a server restart, a revoke, a new pairing): run.mjs
 * then runs it without the transport watch, which would otherwise fail it as
 * `transport: reconnect`. Its steps must prove the reconnect themselves.
 * `finally: [steps]` (same step grammar) runs after the steps whether they
 * passed or failed, to put back device state later scenarios depend on
 * (engine.mjs runFinally): a failing finally step fails a passing scenario.
 */

// noServer may specify sessionFrom: /journal event/: its latest matching JSON
// event in this scenario supplies the session to check. Missing identity fails.
export const ACTIONS = ['send', 'press', 'waitBootWifi', 'waitDevice', 'waitServer', 'noDevice', 'noServer', 'cleanSerial', 'assertState', 'saveState', 'assertHeapMin', 'sleep', 'playAudio'];
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 600_000;
const NAMED_PRESSES = {
  enter: 'T enter', backtick: 'T backtick', 'btn down': 'T btn down', 'btn up': 'T btn up',
  // The text field (#677): Del, Tab and the Fn chords.
  del: 'T del', tab: 'T tab', 'fn ,': 'T fn ,', 'fn /': 'T fn /', 'fn `': 'T fn `',
};
const STATE_FIELDS = {
  state: (v) => typeof v === 'string' && /^[A-Z_]+$/.test(v),
  mode: (v) => ['ptt', 'wake', 'announce_only'].includes(v),
  vol: (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  muted: (v) => v === 0 || v === 1,
  dnd: (v) => v === 0 || v === 1,
};
const HEAP_FIELDS = ['free', 'min', 'largest'];

/** The console command for a press. */
export function commandFor(press) {
  return NAMED_PRESSES[press] ?? `T key ${press}`;
}

function validPress(press) {
  return typeof press === 'string' && (press in NAMED_PRESSES || /^[\x21-\x7e]$/.test(press));
}

function stateErrors(where, expected, saved) {
  if (!expected || typeof expected !== 'object' || Object.keys(expected).length === 0) {
    return [`${where}: assertState needs at least one of ${Object.keys(STATE_FIELDS).join(', ')}`];
  }
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (!(field in STATE_FIELDS)) {
      errors.push(`${where}: unknown state field "${field}"`);
    } else if (value && typeof value === 'object') {
      const ref = value.same ?? value.differs ?? value.of;
      if (typeof ref !== 'string' || !saved.has(ref)) errors.push(`${where}: ${field} compares against "${ref}", which no earlier saveState recorded`);
      if ('delta' in value && !Number.isInteger(value.delta)) errors.push(`${where}: ${field}.delta must be an integer`);
    } else if (!STATE_FIELDS[field](value)) {
      errors.push(`${where}: ${field}=${JSON.stringify(value)} is outside the console contract`);
    }
  }
  return errors;
}

function stepErrors(step, index, saved) {
  const where = `step ${index + 1}`;
  if (!step || typeof step !== 'object') return [`${where}: not an object`];
  const actions = Object.keys(step).filter((k) => ACTIONS.includes(k));
  const unknown = Object.keys(step).filter((k) => !ACTIONS.includes(k) && !['timeoutMs', 'expect', 'since', 'note', 'repeat', 'until', 'onlyIf', 'sessionFrom'].includes(k));
  if (unknown.length) return [`${where}: unknown key(s) ${unknown.join(', ')}`];
  if ('sessionFrom' in step && (!('noServer' in step) || !(step.sessionFrom instanceof RegExp))) return [`${where}: sessionFrom must be a RegExp on noServer`];
  if (('repeat' in step || 'until' in step) && !('playAudio' in step)) return [`${where}: repeat/until only go with playAudio`];
  if ('repeat' in step && !(Number.isInteger(step.repeat) && step.repeat >= 1 && step.repeat <= 10)) return [`${where}: repeat must be 1..10`];
  if ('until' in step && !(step.until instanceof RegExp)) return [`${where}: until must be a RegExp`];
  if ('onlyIf' in step && !(step.onlyIf instanceof RegExp)) return [`${where}: onlyIf must be a RegExp`];
  if (actions.length !== 1) return [`${where}: needs exactly one action of ${ACTIONS.join(', ')} (has ${actions.length})`];
  if ('timeoutMs' in step && !(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= MAX_TIMEOUT_MS)) {
    return [`${where}: timeoutMs must be 1..${MAX_TIMEOUT_MS}`];
  }
  const [action] = actions;
  const value = step[action];
  switch (action) {
    case 'send':
      return typeof value === 'string' && /^T \S/.test(value) && (!step.expect || step.expect instanceof RegExp)
        ? [] : [`${where}: send must be a "T …" console command (expect, if set, a RegExp)`];
    case 'press':
      return validPress(value) ? [] : [`${where}: press "${value}" is not a printable char or ${Object.keys(NAMED_PRESSES).join('/')}`];
    case 'waitDevice':
      return value instanceof RegExp ? [] : [`${where}: ${action} must be a RegExp`];
    case 'waitBootWifi':
      return value === true && !('timeoutMs' in step) && !('since' in step)
        ? [] : [`${where}: waitBootWifi takes true and its fixed policy bounds`];
    case 'waitServer':
      return value instanceof RegExp || value instanceof JournalMatch ? [] : [`${where}: ${action} must be a RegExp or JournalMatch`];
    case 'noDevice':
    case 'noServer':
      if (!(value instanceof RegExp)) return [`${where}: ${action} must be a RegExp`];
      return 'timeoutMs' in step ? [] : [`${where}: ${action} needs timeoutMs (the window it waits out)`];
    case 'cleanSerial':
      return value === true ? [] : [`${where}: cleanSerial takes true`];
    case 'assertState':
      return stateErrors(where, value, saved);
    case 'saveState':
      if (typeof value !== 'string' || !value) return [`${where}: saveState needs a name`];
      saved.add(value);
      return [];
    case 'assertHeapMin':
      return value && typeof value === 'object' && Object.keys(value).length > 0 &&
        Object.entries(value).every(([k, v]) => HEAP_FIELDS.includes(k) && Number.isInteger(v) && v >= 0)
        ? [] : [`${where}: assertHeapMin takes non-negative byte floors for ${HEAP_FIELDS.join('/')}`];
    case 'sleep':
      return Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS ? [] : [`${where}: sleep must be 0..${MAX_TIMEOUT_MS} ms`];
    case 'playAudio':
      return isRepoWav(value) ? [] : [`${where}: playAudio takes a repo-relative .wav path (forward slashes, no "..")`];
    default:
      return [`${where}: unhandled action ${action}`];
  }
}

/** Every problem with a scenario, as readable strings; [] when valid. */
export function validateScenario(scenario) {
  const errors = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(scenario?.name ?? '')) errors.push('name must be kebab-case');
  if (!/^#(\d+|baseline)$/.test(scenario?.issue ?? '')) errors.push('issue must be "#<number>" or "#baseline"');
  if (typeof scenario?.title !== 'string' || !scenario.title) errors.push('title is required');
  if ('expectsReconnect' in (scenario ?? {}) && scenario.expectsReconnect !== true) errors.push('expectsReconnect, if set, must be true');
  if ('board' in (scenario ?? {}) && !BOARDS.includes(scenario.board)) errors.push(`board, if set, must be one of ${BOARDS.join(', ')}`);
  for (const req of scenario?.requires ?? []) {
    if (!/^[a-z0-9_]+$/.test(req?.event ?? '') || typeof req?.feature !== 'string') {
      errors.push('requires entries need { event: snake_case, feature: text }');
    }
  }
  const files = scenario?.requiresFiles ?? [];
  if (!Array.isArray(files) || !files.every(isRepoWav)) {
    errors.push('requiresFiles must list repo-relative .wav paths (forward slashes, no "..")');
  }
  if (!Array.isArray(scenario?.steps) || scenario.steps.length === 0) return [...errors, 'steps must be a non-empty array'];
  const saved = new Set();
  scenario.steps.forEach((step, i) => errors.push(...stepErrors(step, i, saved)));
  if ('finally' in scenario) {
    if (!Array.isArray(scenario.finally) || scenario.finally.length === 0) errors.push('finally, if set, must be a non-empty array of steps');
    else scenario.finally.forEach((step, i) => errors.push(...stepErrors(step, i, saved).map((e) => `finally ${e}`)));
  }
  scenario.steps.forEach((step, i) => {
    if (step && typeof step.playAudio === 'string' && isRepoWav(step.playAudio) && !files.includes(step.playAudio)) {
      errors.push(`step ${i + 1}: playAudio "${step.playAudio}" must be listed in requiresFiles (the run skips when it is absent)`);
    }
  });
  return errors;
}

/** A repo-relative .wav path: forward slashes, no drive, no "..". */
function isRepoWav(path) {
  return typeof path === 'string' && /^[\w.-]+(\/[\w.-]+)*\.wav$/.test(path) && !path.split('/').includes('..');
}

export const BOARDS = ['cardputer', 'waveshare'];

/** The board a hil env flashes: the `waveshare-…` envs are the Waveshare, the rest the Cardputer. */
export function boardOf(hilEnv) {
  return String(hilEnv ?? '').startsWith('waveshare-') ? 'waveshare' : 'cardputer';
}

/** Why the scenario does not run on this env's board, or null when it does. */
export function wrongBoard(scenario, hilEnv) {
  return scenario.board && scenario.board !== boardOf(hilEnv) ? `${scenario.board} only` : null;
}

/** Required files (repo-relative) the rig does not have; `exists` checks one. */
export function missingFiles(scenario, exists) {
  return (scenario.requiresFiles ?? []).filter((path) => !exists(path));
}

/** Features whose journal events do not appear, quoted, in the firmware source. */
export function missingFeatures(scenario, firmwareSource) {
  return (scenario.requires ?? [])
    .filter((req) => !firmwareSource.includes(`"${req.event}"`))
    .map((req) => req.feature);
}
