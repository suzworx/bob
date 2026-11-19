import { describe, expect, it, vi } from 'vitest';

import { createLineStream, parseFields, runScenario } from './engine.mjs';
import { validateScenario } from './schema.mjs';

/** A fake Cardputer: answers the T console like the firmware contract says,
 *  and lets a test script extra journal lines per command. */
function fakeRig({ state = { state: 'READY', mode: 'ptt', vol: 5, muted: 0, dnd: 0 }, heap = { free: 90000, min: 70000, largest: 40000 }, onCommand = () => {} } = {}) {
  const device = createLineStream();
  const server = createLineStream();
  const sent = [];
  const send = (command) => {
    sent.push(command);
    setTimeout(() => {
      if (command === 'T state') {
        device.push(`T> state=${state.state} mode=${state.mode} vol=${state.vol} muted=${state.muted} dnd=${state.dnd}`);
      } else if (command === 'T heap') {
        device.push(`T> heap free=${heap.free} min=${heap.min} largest=${heap.largest}`);
      } else if (command === 'T ping') {
        device.push('T> pong fw=0.1.0 build=abc1234');
      } else {
        device.push('1234 INFO v2.loop_slow state=READY ms=120');
        const handled = onCommand(command, { device, server, state });
        if (handled !== false) device.push('T> ok');
      }
    }, 1);
  };
  return { device, server, sent, send, state };
}

const scenario = (steps, extra = {}) => ({ name: 't', issue: '#baseline', title: 't', steps, ...extra });

function pushSessionEvents(kind, server) {
  if (!['missing', 'previous-run'].includes(kind)) {
    server.push(JSON.stringify({ event: 'v2.pairing_required', reason: 'revoked', ...(kind === 'missing-session' ? {} : { session: 'current' }) }));
  }
  if (kind === 'live-current') {
    setTimeout(() => server.push('{"event":"v2.closed","session":"current","stage":"ready"}'), 50);
  } else if (kind === 'malformed') {
    setTimeout(() => server.push('{"event":"v2.closed",'), 50);
  } else {
    server.push(JSON.stringify({ event: 'v2.closed', session: kind === 'current' ? 'current' : 'stale', stage: 'ready', code: 1000 }));
  }
}

function sessionRig(kind) {
  const rig = fakeRig({ onCommand: (_command, { server }) => pushSessionEvents(kind, server) });
  if (kind === 'previous-run') rig.server.push('{"event":"v2.pairing_required","reason":"revoked","session":"current"}');
  return rig;
}

describe('parseFields', () => {
  it('reads key=value pairs, numbers as numbers', () => {
    expect(parseFields('state=READY mode=ptt vol=5 muted=0')).toEqual({ state: 'READY', mode: 'ptt', vol: 5, muted: 0 });
  });
});

describe('runScenario', () => {
  it.each(['stale', 'current', 'live-current', 'missing', 'previous-run', 'missing-session', 'malformed'])('scopes a server quiet window to its captured session: %s', async (kind) => {
    vi.useFakeTimers();
    try {
      const rig = sessionRig(kind);
      const pending = runScenario(scenario([
        { send: 'T test' },
        { noServer: /"event":"v2\.closed"/, sessionFrom: /"event":"v2\.pairing_required"/, timeoutMs: 1000 },
      ]), rig);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.status).toBe(kind === 'stale' ? 'pass' : 'fail');
      if (['missing', 'previous-run', 'missing-session'].includes(kind)) expect(result.reason).toMatch(/session/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes when every step is satisfied, and keeps the evidence lines', async () => {
    const rig = fakeRig({
      onCommand: (cmd, { device, server }) => {
        if (cmd === 'T key n') device.push('5000 INFO v2.new_conversation_opened state=NEWCHAT');
        if (cmd === 'T enter') server.push('{"ts":"x","event":"v2.conversation_cleared"}');
      },
    });
    rig.server.push('{"ts":"x","event":"v2.welcome"}');
    const result = await runScenario(scenario([
      { waitServer: /"v2\.welcome"/, since: 'run', timeoutMs: 100 },
      { assertState: { state: 'READY' } },
      { press: 'n' },
      { waitDevice: /new_conversation_opened/, timeoutMs: 200 },
      { press: 'enter' },
      { waitServer: /conversation_cleared/, timeoutMs: 200 },
    ]), rig);
    expect(result.status).toBe('pass');
    expect(rig.sent).toEqual(['T state', 'T key n', 'T enter']);
    expect(result.evidence.join('\n')).toMatch(/new_conversation_opened/);
  });

  it('only matches lines that arrive after the last press', async () => {
    const rig = fakeRig();
    rig.device.push('100 INFO v2.new_conversation_opened state=NEWCHAT');
    const result = await runScenario(scenario([{ press: 'n' }, { waitDevice: /new_conversation_opened/, timeoutMs: 60 }]), rig);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/step 2.*new_conversation_opened.*60 ms/);
  });

  it('fails on a state readback that disagrees, showing what the device said', async () => {
    const result = await runScenario(scenario([{ assertState: { state: 'READY', vol: 7 } }]), fakeRig());
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/vol.*expected 7.*got 5/);
  });

  it('polls an assertState with timeoutMs until the device gets there', async () => {
    const rig = fakeRig({ state: { state: 'WIFI', mode: 'ptt', vol: 5, muted: 0, dnd: 0 } });
    setTimeout(() => { rig.state.state = 'SOCKET'; }, 300);
    setTimeout(() => { rig.state.state = 'READY'; }, 700);
    const result = await runScenario(scenario([{ assertState: { state: 'READY' }, timeoutMs: 3000 }]), rig);
    expect(result.status).toBe('pass');
    expect(rig.sent.filter((c) => c === 'T state').length).toBeGreaterThan(2);
    expect(result.evidence.at(-1)).toMatch(/state=READY .*\(poll \d+\)/);
  });

  it('fails a polled assertState at its timeout with the last readback', async () => {
    const rig = fakeRig({ state: { state: 'WIFI', mode: 'ptt', vol: 5, muted: 0, dnd: 0 } });
    const started = Date.now();
    const result = await runScenario(scenario([{ assertState: { state: 'READY' }, timeoutMs: 800 }]), rig);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/after \d+ polls in 800 ms.*expected READY, got WIFI/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('decides an assertState without timeoutMs on one readback', async () => {
    const rig = fakeRig({ state: { state: 'WIFI', mode: 'ptt', vol: 5, muted: 0, dnd: 0 } });
    setTimeout(() => { rig.state.state = 'READY'; }, 50);
    const result = await runScenario(scenario([{ assertState: { state: 'READY' } }]), rig);
    expect(result.status).toBe('fail');
    expect(rig.sent).toEqual(['T state']);
  });

  it('releases GO when a scenario fails while it is held', async () => {
    const rig = fakeRig();
    const result = await runScenario(scenario([
      { press: 'btn down' },
      { waitServer: /v2\.turn_started/, timeoutMs: 40 },
      { press: 'btn up' },
    ]), rig);
    expect(result.status).toBe('fail');
    expect(rig.sent).toEqual(['T btn down', 'T btn up']);
    expect(result.evidence.at(-1)).toMatch(/released GO after the failure: ok/);
  });

  it('does not press GO again when a scenario fails with GO released', async () => {
    const rig = fakeRig();
    const result = await runScenario(scenario([
      { press: 'btn down' },
      { press: 'btn up' },
      { waitServer: /v2\.turn_ended/, timeoutMs: 40 },
    ]), rig);
    expect(result.status).toBe('fail');
    expect(rig.sent).toEqual(['T btn down', 'T btn up']);
  });

  it('compares against a saved snapshot for relative changes', async () => {
    const rig = fakeRig({ onCommand: (cmd, { state }) => {
      if (cmd === 'T key =') state.vol += 1;
      if (cmd === 'T key k') state.mode = 'wake';
    } });
    const result = await runScenario(scenario([
      { saveState: 'before' },
      { press: '=' },
      { press: 'k' },
      { assertState: { vol: { delta: 1, of: 'before' }, muted: { same: 'before' }, mode: { differs: 'before' } } },
    ]), rig);
    expect(result.status).toBe('pass');
  });

  it('fails a heap floor and reports the reading', async () => {
    const result = await runScenario(scenario([{ assertHeapMin: { largest: 50000 } }]), fakeRig());
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/largest=40000.*50000/);
  });

  it('fails when the console refuses a command', async () => {
    const rig = fakeRig({ onCommand: (_cmd, { device }) => { device.push('T> err unknown command'); return false; } });
    const result = await runScenario(scenario([{ press: 'q' }]), rig);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/err unknown command/);
  });

  it('fails when the console never answers', async () => {
    const rig = fakeRig();
    rig.send = () => {};
    const result = await runScenario(scenario([{ send: 'T ping', timeoutMs: 40 }]), rig);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/no console reply/);
  });

  it('skips, without touching the device, when the firmware lacks the feature', async () => {
    const rig = fakeRig();
    const result = await runScenario(
      scenario([{ press: 'k' }], { requires: [{ event: 'mode_changed', feature: 'mode cycle (#330)' }] }),
      { ...rig, firmwareSource: 'journal("boot")' },
    );
    expect(result).toMatchObject({ status: 'skip', reason: expect.stringMatching(/mode cycle \(#330\)/) });
    expect(rig.sent).toEqual([]);
  });

  it('skips, without touching the device, when a required file is missing', async () => {
    const rig = fakeRig();
    const result = await runScenario(
      scenario([{ playAudio: 'data/wake-test/hey_jarvis.wav' }], { requiresFiles: ['data/wake-test/hey_jarvis.wav'] }),
      { ...rig, fileExists: () => false, playAudio: async () => {} },
    );
    expect(result).toMatchObject({ status: 'skip', reason: expect.stringMatching(/data\/wake-test\/hey_jarvis\.wav/) });
    expect(rig.sent).toEqual([]);
  });

  it('plays a file through the rig speaker and waits for it to finish', async () => {
    const rig = fakeRig();
    const played = [];
    const playAudio = async (path) => {
      await new Promise((r) => setTimeout(r, 5));
      played.push(path);
      rig.device.push('9000 INFO v2.wake_detected state=READY max_invoke_us=16000');
    };
    const wav = 'data/wake-test/hey_jarvis.wav';
    const result = await runScenario(
      scenario([{ playAudio: wav }, { waitDevice: /wake_detected/, timeoutMs: 100 }], { requiresFiles: [wav] }),
      { ...rig, fileExists: () => true, playAudio },
    );
    expect(result.status).toBe('pass');
    expect(played).toEqual([wav]);
  });

  it('repeats a playback until the device answers, and stops there', async () => {
    const rig = fakeRig();
    let plays = 0;
    const playAudio = async () => {
      plays += 1;
      if (plays === 2) rig.device.push('9000 INFO v2.wake_detected state=READY max_invoke_us=16000');
    };
    const result = await runScenario(
      scenario([{ playAudio: 'data/a.wav', repeat: 3, until: /wake_detected/ }]),
      { ...rig, playAudio },
    );
    expect(result.status).toBe('pass');
    expect(plays).toBe(2);
    expect(result.evidence.join('\n')).toMatch(/wake_detected/);
  });

  it('fails a repeated playback the device never answers', async () => {
    const rig = fakeRig();
    let plays = 0;
    const result = await runScenario(
      scenario([{ playAudio: 'data/a.wav', repeat: 2, until: /wake_detected/, timeoutMs: 20 }]),
      { ...rig, playAudio: async () => { plays += 1; } },
    );
    expect(result).toMatchObject({ status: 'fail', reason: expect.stringMatching(/2 plays/) });
    expect(plays).toBe(2);
  });

  it('fails the step when the speaker cannot play', async () => {
    const rig = fakeRig();
    const result = await runScenario(scenario([{ playAudio: 'data/a.wav' }]), {
      ...rig,
      playAudio: async () => { throw new Error('powershell exited 1'); },
    });
    expect(result).toMatchObject({ status: 'fail', reason: expect.stringMatching(/powershell exited 1/) });
  });

  it('passes a noServer window no matching line arrives in, and waits it out', async () => {
    const rig = fakeRig();
    const started = Date.now();
    const result = await runScenario(scenario([{ press: 'btn down' }, { press: 'btn up' }, { noServer: /v2\.turn_started/, timeoutMs: 150 }]), rig);
    expect(result.status).toBe('pass');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(result.evidence.at(-1)).toMatch(/no server line matching .*turn_started.* in 150 ms/);
  });

  it('fails a noDevice or noServer step on the first matching line after the mark', async () => {
    const rig = fakeRig({ onCommand: (cmd, { device, server }) => {
      if (cmd === 'T btn down') {
        device.push('10 INFO v2.turn_started state=LISTEN');
        server.push('{"event":"v2.turn_started"}');
      }
    } });
    const device = await runScenario(scenario([{ press: 'btn down' }, { noDevice: /turn_started/, timeoutMs: 500 }]), rig);
    expect(device.status).toBe('fail');
    expect(device.reason).toMatch(/step 2: unexpected device line .*turn_started/);
    const server = await runScenario(scenario([{ press: 'btn down' }, { noServer: /turn_started/, timeoutMs: 500 }]), rig);
    expect(server.reason).toMatch(/step 2: unexpected server line .*v2\.turn_started/);
  });

  it('lets since: run catch a noDevice or noServer line from before the last mark, and keeps the default window after it', async () => {
    const rig = fakeRig({ onCommand: (cmd, { device, server }) => {
      if (cmd === 'T btn down') {
        device.push('10 INFO v2.turn_started state=LISTEN');
        server.push('{"event":"v2.turn_started"}');
      }
    } });
    const deviceSteps = [{ press: 'btn down' }, { press: 'btn up' }];
    const device = await runScenario(scenario([...deviceSteps, { noDevice: /turn_started/, since: 'run', timeoutMs: 50 }]), rig);
    expect(device).toMatchObject({ status: 'fail', reason: expect.stringMatching(/step 3: unexpected device line .*turn_started/) });
    const deviceDefault = await runScenario(scenario([...deviceSteps, { noDevice: /turn_started/, timeoutMs: 50 }]), rig);
    expect(deviceDefault.status).toBe('pass');
    const server = await runScenario(scenario([...deviceSteps, { noServer: /turn_started/, since: 'run', timeoutMs: 50 }]), rig);
    expect(server).toMatchObject({ status: 'fail', reason: expect.stringMatching(/step 3: unexpected server line .*v2\.turn_started/) });
    const serverDefault = await runScenario(scenario([...deviceSteps, { noServer: /turn_started/, timeoutMs: 50 }]), rig);
    expect(serverDefault.status).toBe('pass');
  });

  it('accepts since: run on noDevice and noServer steps', () => {
    expect(validateScenario(scenario([{ noDevice: /x/, since: 'run', timeoutMs: 10 }, { noServer: /y/, since: 'run', timeoutMs: 10 }]))).toEqual([]);
  });

  it('passes cleanSerial when every device line since the scenario began is a journal or console line', async () => {
    const rig = fakeRig();
    rig.device.push('[BOB-DIAG] readCb ok bytes=2 elapsed=3');  // before the scenario: not judged.
    const result = await runScenario(scenario([{ press: 'k' }, { cleanSerial: true }]), rig);
    expect(result.status).toBe('pass');
    expect(result.evidence.at(-1)).toMatch(/serial clean: \d+ lines/);
  });

  it('fails cleanSerial on a raw print, quoting the first offenders', async () => {
    const rig = fakeRig({ onCommand: (cmd, { device }) => {
      if (cmd === 'T key k') {
        device.push('[BOB-DIAG] readCb ok bytes=2 elapsed=3');
        device.push('[wake] ready arena_used=1 held=2 stride=3');
      }
    } });
    const result = await runScenario(scenario([{ press: 'k' }, { cleanSerial: true }]), rig);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/2 device line\(s\) outside the journal\/console format: "\[BOB-DIAG\] readCb/);
  });

  it('checks a send reply against its expect pattern', async () => {
    const result = await runScenario(scenario([{ send: 'T ping', expect: /^pong fw=\S+ build=\S+$/ }]), fakeRig());
    expect(result.status).toBe('pass');
    const bad = await runScenario(scenario([{ send: 'T ping', expect: /^pong fw=9/ }]), fakeRig());
    expect(bad.status).toBe('fail');
  });
});

describe('onlyIf (a step that runs only when an earlier line says so)', () => {
  it('runs the step when a matching device line arrived since the last command', async () => {
    const rig = fakeRig({
      onCommand: (cmd, { device }) => {
        if (cmd === 'T key w') device.push('2000 INFO v2.wake_detected state=READY');
        if (cmd === 'T key w') setTimeout(() => device.push('2600 INFO v2.playback_completed state=WAIT'), 20);
      },
    });
    const result = await runScenario(scenario([
      { press: 'w' },
      { sleep: 5 },
      { waitDevice: /playback_completed/, onlyIf: /wake_detected/, timeoutMs: 500 },
    ]), rig);
    expect(result.status).toBe('pass');
    expect(result.evidence.join('\n')).toMatch(/playback_completed/);
  });

  it('skips the step, and says so, when no such line arrived', async () => {
    const rig = fakeRig();
    const result = await runScenario(scenario([
      { press: 'w' },
      { waitDevice: /playback_completed/, onlyIf: /wake_detected/, timeoutMs: 50 },
    ]), rig);
    expect(result.status).toBe('pass');
    expect(result.evidence.join('\n')).toMatch(/skipped: no device line matching \/wake_detected\//);
  });
});
