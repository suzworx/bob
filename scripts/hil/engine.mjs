import { commandFor, DEFAULT_TIMEOUT_MS, missingFeatures, missingFiles } from './schema.mjs';
import { waitForBootWifi } from './boot-wifi.mjs';

/*
 * engine.mjs — runs one scenario's steps against a device and a server.
 *
 * The rig is { device, server, send, firmwareSource?, fileExists?, playAudio? }
 * (the last two: a repo-relative path exists / play it through the PC
 * speaker, resolving when it ends): `device` and `server`
 * are line streams (device serial lines, server journal JSON lines), `send`
 * writes one console line to the device. run.mjs wires them to the real serial
 * bridge and journal file; the tests wire them to fakes. The console only
 * drives: evidence of behaviour is always a journal line or a `T state`/`T heap`
 * readback, and a wait only matches lines that arrived after the last command.
 */

export function createLineStream() {
  const lines = [];
  const waiters = new Set();
  return {
    lines,
    get length() {
      return lines.length;
    },
    push(raw) {
      for (const part of String(raw).split(/\r?\n/)) {
        const line = part.replace(/\r/g, '');
        if (!line.trim()) continue;
        lines.push(line);
        for (const waiter of [...waiters]) waiter(lines.length - 1);
      }
    },
    /** Resolves to the first line at or after `from` matching `re`, or null
     *  after `timeoutMs`. */
    waitFor(re, from, timeoutMs) {
      for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return Promise.resolve(lines[i]);
      return new Promise((done) => {
        const waiter = (i) => {
          if (i >= from && re.test(lines[i])) finish(lines[i]);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        const finish = (line) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          done(line);
        };
        waiters.add(waiter);
      });
    },
  };
}

/** `a=1 b=x` → { a: 1, b: 'x' }. */
export function parseFields(text) {
  const out = {};
  for (const [, key, value] of String(text).matchAll(/(\w+)=(\S+)/g)) {
    out[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

class StepFailure extends Error {}

/** assertState polling: the gap between `T state` readbacks, and how long one
 *  readback may take before the step fails. */
export const STATE_POLL_INTERVAL_MS = 250;
const STATE_POLL_REPLY_MS = 3000;
/** playAudio with `until`: how long after each play the device may take to
 *  answer before the next play (the wake model decides within ~1 s). */
const PLAY_LISTEN_MS = 2000;

/** The only lines the firmware may print: journal() lines (src/journal.cpp)
 *  and test console replies. Anything else is a raw print (cleanSerial). */
const JOURNAL_OR_CONSOLE_LINE = /^(\d+ INFO v2\.[a-z0-9_]+ state=[A-Z_]+\b|T> )/;

async function consoleCommand(rig, command, timeoutMs) {
  const from = rig.device.length;
  rig.send(command);
  const line = await rig.device.waitFor(/^T> /, from, timeoutMs);
  if (line === null) throw new StepFailure(`no console reply to "${command}" in ${timeoutMs} ms (is the hil firmware env flashed?)`);
  const reply = line.slice(3).trim();
  if (/^err\b/.test(reply)) throw new StepFailure(`console refused "${command}": ${reply}`);
  return reply;
}

function checkState(expected, actual, snapshots) {
  const problems = [];
  for (const [field, want] of Object.entries(expected)) {
    const got = actual[field];
    if (want && typeof want === 'object') {
      const base = snapshots.get(want.same ?? want.differs ?? want.of)?.[field];
      if ('same' in want && got !== base) problems.push(`${field}: expected unchanged ${base}, got ${got}`);
      if ('differs' in want && got === base) problems.push(`${field}: expected a change from ${base}, still ${got}`);
      if ('delta' in want && got !== Math.min(10, Math.max(0, base + want.delta))) {
        problems.push(`${field}: expected ${base}${want.delta >= 0 ? '+' : ''}${want.delta}, got ${got}`);
      }
    } else if (got !== want) {
      problems.push(`${field}: expected ${want}, got ${got}`);
    }
  }
  return problems;
}

function journalSession(line) {
  try {
    const session = JSON.parse(line).session;
    return typeof session === 'string' && session ? session : null;
  } catch {
    return null;
  }
}

function serverSessionMatcher(step, rig, ctx, re) {
  if (!step.sessionFrom) return re;
  const source = rig.server.lines.slice(ctx.start.server).findLast((line) => step.sessionFrom.test(line));
  if (!source) throw new StepFailure('no server session source in this scenario');
  const session = journalSession(source);
  if (session === null) throw new StepFailure('server session source has no session');
  return {
    // A malformed matching event must fail the quiet window, not disappear.
    test: (line) => re.test(line) && (journalSession(line) ?? session) === session,
    toString: () => `${re} for session ${session}`,
  };
}

async function runStep(step, rig, ctx) {
  const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (step.onlyIf && !rig.device.lines.slice(ctx.mark.device).some((l) => step.onlyIf.test(l))) {
    ctx.evidence.push(`skipped: no device line matching ${step.onlyIf} since the last command`);
    return;
  }
  const mark = () => {
    ctx.mark = { device: rig.device.length, server: rig.server.length };
  };
  if ('send' in step || 'press' in step) {
    const command = 'send' in step ? step.send : commandFor(step.press);
    mark();
    const reply = await consoleCommand(rig, command, timeoutMs);
    ctx.evidence.push(`> ${command}  < ${reply}`);
    if (command === 'T btn down') ctx.goHeld = true;
    if (command === 'T btn up') ctx.goHeld = false;
    if ('press' in step && reply !== 'ok') throw new StepFailure(`"${command}" answered "${reply}", expected "ok"`);
    if (step.expect && !step.expect.test(reply)) throw new StepFailure(`"${command}" answered "${reply}", expected ${step.expect}`);
  } else if ('waitBootWifi' in step) {
    await waitForBootWifi(rig.device, ctx.mark.device, ctx.evidence)
      .catch((error) => { throw new StepFailure(error.message); });
  } else if ('waitDevice' in step || 'waitServer' in step) {
    const [stream, re, which] = 'waitDevice' in step ? [rig.device, step.waitDevice, 'device'] : [rig.server, step.waitServer, 'server'];
    const line = await stream.waitFor(re, step.since === 'run' ? 0 : ctx.mark[which], timeoutMs);
    if (line === null) throw new StepFailure(`no ${which} line matching ${re} within ${timeoutMs} ms`);
    ctx.evidence.push(`${which}: ${line}`);
  } else if ('noDevice' in step || 'noServer' in step) {
    const [stream, re, which] = 'noDevice' in step ? [rig.device, step.noDevice, 'device'] : [rig.server, step.noServer, 'server'];
    const matcher = serverSessionMatcher(step, rig, ctx, re);
    const line = await stream.waitFor(matcher, step.since === 'run' ? 0 : ctx.mark[which], timeoutMs);
    if (line !== null) throw new StepFailure(`unexpected ${which} line ${line}`);
    ctx.evidence.push(`no ${which} line matching ${re} in ${timeoutMs} ms`);
  } else if ('cleanSerial' in step) {
    const lines = rig.device.lines.slice(ctx.start.device);
    const raw = lines.filter((l) => !JOURNAL_OR_CONSOLE_LINE.test(l));
    if (raw.length) {
      const quoted = raw.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 120))).join(', ');
      throw new StepFailure(`${raw.length} device line(s) outside the journal/console format: ${quoted}`);
    }
    ctx.evidence.push(`serial clean: ${lines.length} lines, all journal or console`);
  } else if ('saveState' in step) {
    const reply = await consoleCommand(rig, 'T state', timeoutMs);
    ctx.evidence.push(`state: ${reply}`);
    ctx.snapshots.set(step.saveState, parseFields(reply));
  } else if ('assertState' in step) {
    // With timeoutMs the device is given until then to get there: `T state`
    // is polled until it matches. Without, one readback decides.
    const deadline = Date.now() + timeoutMs;
    for (let polls = 1; ; polls++) {
      const left = Math.max(1, deadline - Date.now());
      const reply = await consoleCommand(rig, 'T state', 'timeoutMs' in step ? Math.min(left, STATE_POLL_REPLY_MS) : timeoutMs);
      const problems = checkState(step.assertState, parseFields(reply), ctx.snapshots);
      if (!problems.length || !('timeoutMs' in step) || Date.now() + STATE_POLL_INTERVAL_MS >= deadline) {
        ctx.evidence.push(`state: ${reply}${polls > 1 ? ` (poll ${polls})` : ''}`);
        if (problems.length) {
          throw new StepFailure(`state mismatch${polls > 1 ? ` after ${polls} polls in ${timeoutMs} ms` : ''} (${problems.join('; ')})`);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
    }
  } else if ('assertHeapMin' in step) {
    const reply = await consoleCommand(rig, 'T heap', timeoutMs);
    const heap = parseFields(reply);
    ctx.evidence.push(`heap: ${reply}`);
    const low = Object.entries(step.assertHeapMin).filter(([k, floor]) => !(heap[k] >= floor));
    if (low.length) throw new StepFailure(`heap below floor: ${low.map(([k, f]) => `${k}=${heap[k]} < ${f}`).join(', ')}`);
  } else if ('sleep' in step) {
    await new Promise((r) => setTimeout(r, step.sleep));
  } else if ('playAudio' in step) {
    if (typeof rig.playAudio !== 'function') throw new StepFailure('this rig cannot play audio');
    mark();  // waits after it match lines from the first playback on.
    const plays = step.repeat ?? 1;
    for (let i = 1; i <= plays; i++) {
      try {
        await rig.playAudio(step.playAudio);
      } catch (error) {
        throw new StepFailure(`could not play ${step.playAudio}: ${error.message}`);
      }
      ctx.evidence.push(`played ${step.playAudio} through the PC speaker (${i}/${plays})`);
      if (!step.until) continue;
      const line = await rig.device.waitFor(step.until, ctx.mark.device, step.timeoutMs ?? PLAY_LISTEN_MS);
      if (line !== null) {
        ctx.evidence.push(`device: ${line}`);
        return;
      }
    }
    if (step.until) throw new StepFailure(`no device line matching ${step.until} after ${plays} plays of ${step.playAudio}`);
  }
}

/** Runs a scenario; resolves to { name, issue, status, reason?, evidence, ms }. */
export async function runScenario(scenario, rig) {
  const started = Date.now();
  const base = { name: scenario.name, issue: scenario.issue };
  if (rig.firmwareSource !== undefined) {
    const missing = missingFeatures(scenario, rig.firmwareSource);
    if (missing.length) {
      return { ...base, status: 'skip', reason: `firmware does not implement: ${missing.join(', ')}`, evidence: [], ms: 0 };
    }
  }
  if (typeof rig.fileExists === 'function') {
    const absent = missingFiles(scenario, rig.fileExists);
    if (absent.length) return { ...base, status: 'skip', reason: `missing on this PC: ${absent.join(', ')}`, evidence: [], ms: 0 };
  }
  const start = { device: rig.device.length, server: rig.server.length };
  const ctx = { start, mark: { ...start }, snapshots: new Map(), evidence: [], goHeld: false };
  const result = await runSteps(scenario, rig, ctx, base, started);
  if (!scenario.finally?.length) return result;
  return { ...(await runFinally(scenario.finally, rig, ctx, result)), ms: Date.now() - started };
}

/**
 * A scenario's `finally` steps run after its steps whether they passed or
 * failed, to put back device state a later scenario depends on (pcm-reply's
 * hello format). Their evidence is prefixed `finally: `. A failing finally
 * step fails a scenario that had passed; on one that failed it only adds
 * evidence, and the first failure stays the reason.
 */
async function runFinally(steps, rig, ctx, result) {
  const from = ctx.evidence.length;
  let problem = null;
  for (const [i, step] of steps.entries()) {
    try {
      await runStep(step, rig, ctx);
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      problem = `finally step ${i + 1}: ${error.message}`;
      break;
    }
  }
  const added = ctx.evidence.slice(from).map((line) => `finally: ${line}`);
  const evidence = result.status === 'pass' ? [...ctx.evidence.slice(0, from), ...added] : [...result.evidence, ...added];
  if (problem === null) return { ...result, evidence };
  if (result.status === 'pass') return { ...result, status: 'fail', reason: problem, evidence };
  return { ...result, evidence: [...evidence, problem] };
}

async function runSteps(scenario, rig, ctx, base, started) {
  for (const [i, step] of scenario.steps.entries()) {
    try {
      await runStep(step, rig, ctx);
    } catch (error) {
      if (!(error instanceof StepFailure)) throw error;
      const tail = rig.device.lines.slice(-12).map((l) => `device: ${l}`);
      // A failure between `btn down` and `btn up` must not leave GO held:
      // the device would keep capturing and fail every later scenario.
      if (ctx.goHeld) {
        const released = await consoleCommand(rig, 'T btn up', DEFAULT_TIMEOUT_MS).catch(() => 'no reply');
        tail.push(`released GO after the failure: ${released}`);
      }
      return { ...base, status: 'fail', reason: `step ${i + 1}: ${error.message}`, evidence: [...ctx.evidence, ...tail], ms: Date.now() - started };
    }
  }
  return { ...base, status: 'pass', evidence: ctx.evidence, ms: Date.now() - started };
}
