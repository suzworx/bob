import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { createLineStream, runScenario } from './engine.mjs';
import { missingFeatures, validateScenario } from './schema.mjs';
import { SCENARIOS, scenariosFor, WAVESHARE_SCENARIOS } from './scenarios/index.mjs';
import { echoReply, guardSetting, PROBE_LENGTHS, probeSteps } from './scenarios/console-packet-edge.mjs';
import { BackoffViolation } from './scenarios/server-down-backoff.mjs';
import { REPLY_CANCELLED_BEFORE_START, REPLY_PLAYED, replyPlayed } from './scenarios/steps.mjs';

// Completed replies need EOF (or the explicit stopped/PCM proof). A pre-decoder
// cancellation is separate: zero output is valid only after a confirmed abort.
function assertCompletionProof(name, step, previous) {
  const source = step.waitDevice?.source ?? '';
  if (!/playback_completed/.test(source) || /wake_rejected/.test(source) || source === replyPlayed('pcm16').source) return;
  if (step.waitDevice === REPLY_CANCELLED_BEFORE_START) {
    expect(previous?.waitDevice?.source).toBe(/INFO v2\.playback_aborted /.source);
    return;
  }
  expect(`${name}: ${source}`).toMatch(/mp3_exit=(eof|stopped)/);
}

describe('bundled HIL scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.name, s]))('%s is valid', (_name, scenario) => {
    expect(validateScenario(scenario)).toEqual([]);
  });

  it('add the speaker loopback to Waveshare runs only, right after boot-ready (#1063)', () => {
    for (const s of WAVESHARE_SCENARIOS) expect(validateScenario(s)).toEqual([]);
    const ws = scenariosFor('waveshare-s3-185c-hil').map((s) => s.name);
    expect(ws.slice(0, 2)).toEqual(['boot-ready', 'speaker-loopback']);
    expect(new Set(ws).size).toBe(ws.length);
    expect(scenariosFor('m5stack-cardputer-hil')).toBe(SCENARIOS);
    const loop = WAVESHARE_SCENARIOS.find((s) => s.name === 'speaker-loopback');
    const reply = loop.steps.find((s) => s.send === 'T spk test').expect;
    const ok = 'spk_test pass=1,stage=ok,tone_rms=880,quiet_rms=21,amp_off_rise_db=0.4,es8311=83,r0d=01,codec_ok=1';
    expect(reply.test(ok)).toBe(true);
    expect(reply.test(ok.replace('pass=1,stage=ok', 'pass=0,stage=silent'))).toBe(false);
    expect(reply.test(ok.replace('codec_ok=1', 'codec_ok=0'))).toBe(false);
    expect(missingFeatures(loop, readFileSync(new URL('../../apps/cardputer/src/test_console.cpp', import.meta.url), 'utf8'))).toEqual([]);
  });

  it('keep the round-screen touch scenarios on the Waveshare and the GO tap guard on the Cardputer (#1063)', () => {
    const touch = SCENARIOS.filter((s) => /^(touch-|boot-tap-)/.test(s.name));
    expect(touch.map((s) => s.name).sort()).toEqual(['boot-tap-hands-free', 'touch-bob-info', 'touch-long-press-chips', 'touch-stop-and-talk', 'touch-swipe-volume', 'touch-tap-talk']);
    for (const s of touch) expect(s.board).toBe('waveshare');
    expect(SCENARIOS.find((s) => s.name === 'go-tap-ignored').board).toBe('cardputer');
    // Every finger is a console path; the firmware journals what it meant, so each waits on that.
    for (const s of touch.filter((t) => t.name !== 'boot-tap-hands-free')) {
      expect(s.steps.some((step) => /^T (touch|swipe) /.test(step.send ?? ''))).toBe(true);
      expect(s.steps.some((step) => (step.waitDevice?.source ?? '').includes('v2\\.touch '))).toBe(true);
    }
  });

  it('have unique names and start with boot-ready', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('boot-ready');
  });

  it('prove a reply sent in one burst still plays (MP3-BEGIN-RACE)', () => {
    const burst = SCENARIOS.find((s) => s.name === 'reply-burst');
    const arms = burst.steps.filter((s) => s.send === 'T server burst_next_reply');
    expect(arms).toHaveLength(3);
    const played = burst.steps.filter((s) => s.waitDevice === REPLY_PLAYED);
    const refused = burst.steps.filter((s) => s.noDevice && /mp3_begin_failed/.test(s.noDevice.source));
    expect(played).toHaveLength(3);
    expect(refused).toHaveLength(3);
    // Run 20260929-064635-40fc's dropped reply fails it; a played one passes.
    const completed = (exit) => `22324 INFO v2.playback_completed state=WAIT down_frames=17,ring_avail=16416,mp3_exit=${exit},decode_cpu_ms=0`;
    expect(['eof', 'n/a', 'stopped', 'loop_false_early', 'eofx'].map((exit) => REPLY_PLAYED.test(completed(exit))))
      .toEqual([true, false, false, false, false]);
    expect(refused[0].noDevice.test('22322 INFO v2.mp3_begin_failed state=WAIT')).toBe(true);
    const names = SCENARIOS.map((s) => s.name);
    expect(names.indexOf('reply-burst')).toBe(names.indexOf('ptt-turn') + 1);
  });

  it('never accept a bare playback_completed as a played reply (escaped defect: silent drops)', () => {
    for (const scenario of SCENARIOS) {
      const steps = [...scenario.steps, ...(scenario.finally ?? [])];
      steps.forEach((step, index) => assertCompletionProof(scenario.name, step, steps[index - 1]));
    }
  });

  it('pre-decoder cancellation proves zero output and never counts as a played reply', () => {
    const line = (fields) => `INFO v2.playback_completed state=READY ${fields}`;
    const cancelled = line('out_frames=0,mp3_exit=n/a,decode_cpu_ms=0');
    expect(REPLY_CANCELLED_BEFORE_START.test(cancelled)).toBe(true);
    expect(REPLY_PLAYED.test(cancelled)).toBe(false);
    expect(() => assertCompletionProof('invalid', { waitDevice: REPLY_CANCELLED_BEFORE_START }, {})).toThrow();
    expect(() => assertCompletionProof('invalid', { waitDevice: /playback_completed/ }, {})).toThrow();
    for (const fields of ['out_frames=1,mp3_exit=n/a', 'out_frames=0,mp3_exit=eof', 'out_frames=0', 'mp3_exit=n/a', 'out_frames=0,mp3_exit=n/ax']) {
      expect(REPLY_CANCELLED_BEFORE_START.test(line(fields))).toBe(false);
    }
  });

  it('replyPlayed is format-aware: MP3 is REPLY_PLAYED, PCM16 needs samples, no drops, no gaps', () => {
    expect(replyPlayed()).toBe(REPLY_PLAYED);
    expect(replyPlayed('mp3')).toBe(REPLY_PLAYED);
    expect(() => replyPlayed('opus')).toThrow(/unknown format/);
    const pcm = replyPlayed('pcm16');
    const line = (fields) => `41200 INFO v2.playback_completed state=WAIT ${fields}`;
    const good = 'samples=176000,down_frames=344,ring_peak=12,dropped_bytes=0,underruns=0,playraw_drops=0,seq_gaps=0,format=pcm16';
    expect(pcm.test(line(good))).toBe(true);
    expect(pcm.test(line('format=pcm16,seq_gaps=0,dropped_bytes=0,samples=1'))).toBe(true);  // any order.
    for (const bad of [
      good.replace('samples=176000', 'samples=0'),
      good.replace('dropped_bytes=0', 'dropped_bytes=640'),
      good.replace('seq_gaps=0', 'seq_gaps=3'),
      good.replace('format=pcm16', 'format=mp3'),
      good.replace('dropped_bytes=0,', ''),
      'samples=176000,format=pcm16',  // the pre-674 buffered line: proves no drops or gaps.
    ]) {
      expect(pcm.test(line(bad))).toBe(false);
    }
    expect(REPLY_PLAYED.test(line(good))).toBe(false);
  });

  it('prove the device recovers from a failed turn and ignores a GO tap (CP-FW-RECOVER)', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(names).toContain('turn-error-recovers');
    expect(names).toContain('go-tap-ignored');
    const turn = SCENARIOS.find((s) => s.name === 'ptt-turn');
    expect(turn.steps.at(-1)).toEqual({ cleanSerial: true });
  });

  it('prove gap-free capture and a spoken wake word (CP-WAKE-MIC)', () => {
    const rate = SCENARIOS.find((s) => s.name === 'wake-capture-rate');
    const fpsChecks = rate.steps.filter((s) => s.waitDevice && /fps=/.test(s.waitDevice.source));
    expect(fpsChecks.map((s) => s.waitDevice.source)).toEqual([
      expect.stringMatching(/wake_stats/),
      expect.stringMatching(/turn_ended/),
    ]);
    for (const { waitDevice } of fpsChecks) {
      const line = (fps) => `1 INFO v2.${/wake_stats/.test(waitDevice.source) ? 'wake_stats state=READY frames=500,' : 'turn_ended state=WAIT frames=170,'}fps=${fps},max_p=3`;
      expect([96, 97, 100, 103, 104, 85].map((fps) => waitDevice.test(line(fps)))).toEqual([false, true, true, true, false, false]);
    }
  });

  it('prove "Alexa" by default, "Hey Bob" after w, and no wake on "Hey Google" (CP-WAKE-BOB)', () => {
    const speaker = SCENARIOS.find((s) => s.name === 'wake-detect-speaker');
    expect(speaker.requiresFiles).toEqual(['data/wake-test/alexa.wav', 'data/wake-test/hey_bob.wav']);
    const listening = speaker.steps.filter((s) => s.waitDevice && /wake_listening/.test(s.waitDevice.source));
    const line = (word, arena = ',arena_used=21000') => `1 INFO v2.wake_listening state=READY word=${word},held=33000${arena},free=90000,largest=60000`;
    // alexa first, bob after w, alexa again after the second w; each logs
    // arena_used. After each detection the same word listens again (the
    // follow-up window has closed) before the next w.
    expect(listening.map((s) => (s.waitDevice.test(line('alexa')) ? 'alexa' : s.waitDevice.test(line('bob')) ? 'bob' : 'none'))).toEqual(['alexa', 'alexa', 'bob', 'bob', 'alexa']);
    for (const { waitDevice } of listening) {
      expect(waitDevice.test(line('alexa', '')) || waitDevice.test(line('bob', ''))).toBe(false);
    }
    const plays = speaker.steps.filter((s) => s.playAudio);
    expect(plays.map((s) => s.playAudio)).toEqual(['data/wake-test/alexa.wav', 'data/wake-test/hey_bob.wav']);
    for (const play of plays) expect(play.repeat).toBe(3);
    // Alexa (the default) must detect: nothing but wake_detected ends its plays.
    const [alexaPlay, bobPlay] = plays;
    const stats = (p) => `90000 INFO v2.wake_stats state=READY frames=500,fps=100,max_p=${p},peak_db=62,floor_db=16`;
    expect(alexaPlay.until.test('1 INFO v2.wake_detected state=READY max_invoke_us=16000')).toBe(true);
    expect(alexaPlay.until.test(stats(248))).toBe(false);
    // Hey Bob (the backup, a SAPI clip vs a Piper-trained model; run
    // 20260924-202048-b051 reached 167/248/222 against cutoff 251) is scored:
    // a detection, or a wake_stats window with max_p >= 200.
    expect(bobPlay.until.test('1 INFO v2.wake_detected state=READY max_invoke_us=16000')).toBe(true);
    expect([167, 199, 200, 222, 248, 255].map((p) => bobPlay.until.test(stats(p)))).toEqual([false, false, true, true, true, true]);
    // Only a detection opens a turn: its waits run only after one.
    const afterBob = speaker.steps.slice(speaker.steps.indexOf(bobPlay) + 1);
    const turnWait = afterBob.find((s) => s.waitDevice && /playback_completed/.test(s.waitDevice.source));
    expect(turnWait.onlyIf.source).toMatch(/wake_detected/);
    const relisten = afterBob.find((s) => s.waitDevice && /wake_listening/.test(s.waitDevice.source));
    expect(relisten.onlyIf.source).toMatch(/wake_detected/);
    expect(afterBob.indexOf(relisten)).toBeLessThan(afterBob.findIndex((s) => s.press === 'w'));
    const presses = speaker.steps.filter((s) => s.press === 'w');
    expect(presses.length).toBe(2);  // to bob, and back to the default for later scenarios.
    expect(speaker.steps.some((s) => s.waitDevice && s.waitDevice.test('1 INFO v2.wake_word_changed state=READY word=bob,source=key'))).toBe(true);
    expect(speaker.steps.some((s) => s.waitDevice && s.waitDevice.test('1 INFO v2.wake_word_changed state=READY word=alexa,source=key'))).toBe(true);

    const reject = SCENARIOS.find((s) => s.name === 'wake-reject-speaker');
    expect(reject.requiresFiles).toEqual(['data/wake-test/hey_google.wav']);
    const play = reject.steps.findIndex((s) => s.playAudio === 'data/wake-test/hey_google.wav');
    expect(play).toBeGreaterThan(-1);
    expect(reject.steps[play + 1]).toMatchObject({ noDevice: /INFO v2\.wake_detected /, timeoutMs: 10_000 });
    expect(reject.steps.at(-1)).toEqual({ assertState: { state: 'READY', mode: 'ptt' } });
  });

  it('prove follow-up listening and the flashed version (CP-WAKE-FOLLOWUP)', () => {
    const boot = SCENARIOS.find((s) => s.name === 'boot-ready').steps.find((s) => s.waitDevice && /boot/.test(s.waitDevice.source));
    expect(boot.waitDevice.test('4120 INFO v2.boot state=WIFI fw=0.1.0 build=78ed069')).toBe(true);
    expect(boot.waitDevice.test('4120 INFO v2.boot state=WIFI fw=0.1.0 build=dev')).toBe(true);
    expect(boot.waitDevice.test('4120 INFO v2.boot state=WIFI')).toBe(false);
    // #345: the build's SemVer: release, local (-dev+sha), and no-sha (-dev).
    for (const fw of ['0.57.0', '0.57.0-dev', '0.57.0-dev+1d98d4f', '1.2.3-rc.1']) {
      expect(boot.waitDevice.test(`4120 INFO v2.boot state=WIFI fw=${fw} build=1d98d4f`), fw).toBe(true);
    }
    // Still strict: a missing or malformed version fails.
    for (const fw of ['', '0.57', 'dev', '0.57.0-', '0.57.0+', '0.57.0-dev+', 'v0.57.0', '0.57.0-dev+1d9 8']) {
      expect(boot.waitDevice.test(`4120 INFO v2.boot state=WIFI fw=${fw} build=1d98d4f`), fw).toBe(false);
    }
    expect(boot.waitDevice.test('4120 INFO v2.boot state=WIFI build=1d98d4f')).toBe(false);

    const ping = SCENARIOS.find((s) => s.name === 'boot-ready').steps.find((s) => s.send === 'T ping');
    for (const fw of ['0.57.0', '0.57.0-dev', '0.57.0-dev+1d98d4f']) {
      expect(ping.expect.test(`pong fw=${fw} build=1d98d4f id=0d7b41faa5be`), fw).toBe(true);
    }
    expect(ping.expect.test('pong fw= build=1d98d4f id=0d7b41faa5be')).toBe(false);
    expect(ping.expect.test('pong fw=0.57 build=1d98d4f id=0d7b41faa5be')).toBe(false);

    const followup = SCENARIOS.find((s) => s.name === 'wake-followup');
    const sources = followup.steps.map((s) => (s.waitDevice ?? s.noDevice)?.source ?? '');
    const at = (re) => sources.findIndex((src) => re.test(src));
    // The window opens after a wake turn's reply, a tone without the wake word
    // opens a followup turn, its reply reopens the window, silence times it out.
    expect(at(/wake_detected/)).toBeGreaterThan(-1);
    expect(at(/mode=followup/)).toBeGreaterThan(at(/followup_opened/));
    expect(at(/reason=timeout/)).toBeGreaterThan(at(/mode=followup/));
    expect(followup.steps.some((s) => s.send === 'T wake fire')).toBe(true);
    // 6 s ±1: nothing for 5 s after the window opens, the timeout by 7 s.
    const quiet = followup.steps.find((s) => s.noDevice && /followup_closed/.test(s.noDevice.source));
    const timeout = followup.steps.find((s) => s.waitDevice && /reason=timeout/.test(s.waitDevice.source));
    expect(quiet.timeoutMs + timeout.timeoutMs).toBe(7000);
    expect(quiet.timeoutMs).toBe(5000);

    // D1 (#392): the window opens 250 ms after the speaker drained.
    const opened = followup.steps.find((s) => s.waitDevice && /followup_opened/.test(s.waitDevice.source)).waitDevice;
    const openedLine = (fields) => `51230 INFO v2.followup_opened state=READY session=s_1 window_ms=6000,${fields}pre_roll=1,free=90000,largest=40000`;
    expect(opened.test(openedLine('guard_ms=250,since_drain_ms=412,'))).toBe(true);
    expect(opened.test(openedLine(''))).toBe(false);

    // Step 22: the follow-up reply must play to the end; a transport abort
    // (run 20260925-205858-29cd) must not count, so it fails here, not at 23.
    const played = followup.steps[21];
    expect(played.waitDevice.source).toMatch(/playback_completed/);
    expect(followup.steps[22].waitDevice.source).toMatch(/followup_opened/);
    const completed = (exit) => `111863 INFO v2.playback_completed state=READY session=s_1 seq_gaps=0,mp3_exit=${exit},decode_cpu_ms=900,loop_max_us=48625`;
    expect(played.waitDevice.test(completed('eof'))).toBe(true);
    expect(played.waitDevice.test(completed('stopped'))).toBe(false);

    const key = SCENARIOS.find((s) => s.name === 'wake-followup-key');
    expect(key.steps.some((s) => s.waitDevice && /followup_closed .*reason=key/.test(s.waitDevice.source))).toBe(true);
    const names = SCENARIOS.map((s) => s.name);
    expect(names.indexOf('wake-followup-key')).toBeLessThan(names.indexOf('heap-floor'));
  });

  it('prove a long sentence is not cut off (#392)', () => {
    const long = SCENARIOS.find((s) => s.name === 'turn-long-sentence');
    expect(long.requiresFiles).toEqual(['data/wake-test/long_sentence.wav']);
    const ended = long.steps.find((s) => s.waitDevice && /turn_ended/.test(s.waitDevice.source)).waitDevice;
    const line = (reason, ms) =>
      `9000 INFO v2.turn_ended state=WAIT frames=700,fps=100,tx_wait_max_ms=1,tx_send_max_ms=3,end_reason=${reason},speech_ms=${ms}`;
    expect([4999, 5000, 7420, 12000].map((ms) => ended.test(line('silence', ms)))).toEqual([false, true, true, true]);
    expect(ended.test(line('max', 7420))).toBe(false);
    expect(ended.test(line('silence', 2480))).toBe(false); // the owner's cut-off turn.
    // turn_ended carries more after speech_ms (run 20260924-195519-54b4: the
    // anchored regex missed speech_ms=6520 followed by ,backlog=7).
    expect(ended.test(`${line('silence', 6520)},backlog=7,tx_busy=0,tx_busy_max_ms=0`)).toBe(true);
    expect(ended.test(`${line('silence', 65)},backlog=7`)).toBe(false);
    // wake-detect-speaker waits for the model to listen again before each `w`
    // (after a played reply a key would only close the follow-up window).
    const speaker = SCENARIOS.find((s) => s.name === 'wake-detect-speaker').steps;
    for (const [i, step] of speaker.entries()) {
      if (step.press !== 'w') continue;
      const before = speaker.slice(0, i).map((s) => s.waitDevice?.source ?? '');
      const lastTurnEnd = before.findLastIndex((src) => /wake_rejected\|playback_completed/.test(src));
      expect(before.slice(lastTurnEnd + 1).some((src) => /wake_listening/.test(src))).toBe(true);
    }
    const names = SCENARIOS.map((s) => s.name);
    expect(names.indexOf('turn-long-sentence')).toBeLessThan(names.indexOf('heap-floor'));
  });

  it('start every scenario after boot-ready from a known baseline (HIL run 20260924-165003-c15f)', () => {
    for (const scenario of SCENARIOS.slice(1)) {
      const [ptt, applied, ready, word, reset] = scenario.steps;
      expect(ptt, scenario.name).toMatchObject({ send: 'T server control mode=ptt dnd=0' });
      // Waits for the push to land, so it cannot undo the scenario's own k.
      expect(applied.waitDevice.test('63121 INFO v2.mode_changed state=READY session=s mode=ptt,wake_fallback=0,source=server'), scenario.name).toBe(true);
      expect(applied.waitDevice.test('63095 INFO v2.mode_changed state=READY session=s mode=wake,wake_fallback=0,source=key'), scenario.name).toBe(false);
      expect(ready, scenario.name).toMatchObject({ assertState: { state: 'READY', mode: 'ptt', dnd: 0 } });
      expect(ready.timeoutMs, scenario.name).toBeGreaterThanOrEqual(10_000);
      // The wake word is set outright, never left to what NVS kept.
      expect(word, scenario.name).toMatchObject({ send: 'T wake word alexa' });
      expect(reset, scenario.name).toMatchObject({ send: 'T state reset' });
    }
    // boot-ready proves the baseline itself and gets none.
    expect(SCENARIOS[0].steps[0]).toMatchObject({ send: 'T ping' });
  });

  it('prove the thread pointer: push, picker, saved turn, lost thread (#565)', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(names.indexOf('thread-pointer')).toBe(names.indexOf('space-picker') + 1);
    const { steps } = SCENARIOS.find((s) => s.name === 'thread-pointer');
    const at = (test) => steps.findIndex(test);
    const server = (re) => at((s) => s.waitServer && re.test(s.waitServer.source));
    const all = (test) => steps.map((s, i) => (test(s) ? i : -1)).filter((i) => i >= 0);
    const seeds = all((s) => s.send === 'T server thread seed');
    const archives = all((s) => s.send === 'T server thread archive');
    const saved = server(/device_thread_saved/);
    const lost = server(/device_thread_lost/);
    const cleared = server(/active_changed/);
    const general = all((s) => s.note === 'archive fallback completed');
    const slow = at((s) => /^T server slow_turn \d+$/.test(s.send ?? ''));
    const holding = server(/hil_slow_turn_holding/);
    const turns = all((s) => s.press === 'btn down');
    const readies = all((s) => s.assertState?.state === 'READY');
    // seed → picker → turn → saved; 5a archive → turn (cleared at start) → cnv_;
    // 5b seed → slow_turn → turn held → archive → lost → cnv_, in that order.
    expect(seeds).toHaveLength(2);
    expect(archives).toHaveLength(2);
    expect(turns).toHaveLength(3);
    expect(at((s) => s.press === 'c')).toBeGreaterThan(seeds[0]);
    expect(turns[0]).toBeGreaterThan(at((s) => s.press === 'enter'));
    const order = [
      turns[0], saved, archives[0], turns[1], cleared, general[0], seeds[1], slow, turns[2], holding, archives[1], lost, general[1],
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 5a's clear lands while GO is still held: at turn_start, not at the persist.
    expect(cleared).toBeLessThan(at((s, i) => i > turns[1] && s.press === 'btn up'));
    // 5a never meets the lost thread; each path ends READY.
    const quiet = steps.findIndex((s, i) => i > general[0] && i < seeds[1] && s.noServer);
    expect(quiet).toBeGreaterThan(-1);
    expect(steps[quiet].noServer.test('{"event":"v2.device_thread_lost"}')).toBe(true);
    expect(steps[quiet].noServer.test('{"event":"v2.device_thread_saved"}')).toBe(true);
    expect(readies.some((i) => i > general[0] && i < seeds[1])).toBe(true);
    expect(steps.at(-1)).toMatchObject({ assertState: { state: 'READY' } });

    const line = (event, fields) => JSON.stringify({ ts: '2026-09-28T00:00:00Z', event, ...fields });
    expect(steps[cleared].waitServer.test(line('v2.active_changed', { surface: 'device' }))).toBe(true);
    expect(steps[cleared].waitServer.test(line('v2.active_changed', { surface: 'picker' }))).toBe(false);
    const verified = all((s) => s.send === 'T server thread verify-general');
    expect(verified).toHaveLength(2);
    for (const [index, position] of verified.entries()) {
      expect(position).toBeGreaterThan(general[index]);
      expect(steps[position + 1].waitServer.test(line('v2.hil_command', { command: 'thread', outcome: 'general_verified' }))).toBe(true);
      expect(steps[position + 1].waitServer.test(line('v2.hil_command', { command: 'thread', outcome: 'failed_not_general' }))).toBe(false);
      expect(steps[position + 2].assertState).toEqual({ state: 'READY' });
    }
    const selected = at((s) => s.send === 'T server thread verify-selected');
    expect(selected).toBeGreaterThan(at((s) => s.press === 'enter'));
    expect(selected).toBeLessThan(turns[0]);
    expect(steps[selected + 1].waitServer.test(line('v2.hil_command', { command: 'thread', outcome: 'selected_seed' }))).toBe(true);
    expect(steps[selected + 1].waitServer.test(line('v2.hil_command', { command: 'thread', outcome: 'failed_wrong_thread' }))).toBe(false);
    const savedRe = steps[saved].waitServer;
    expect(savedRe.test(line('v2.device_thread_saved', { session: 's', thread_id: 't', created: true, outcome: 'completed', published: 1 }))).toBe(true);
    expect(savedRe.test(line('v2.device_thread_saved', { session: 's', thread_id: 't', created: false, outcome: 'busy', published: 0 }))).toBe(false);
    // After the archive no turn may still save into the thread.
    for (const [from, to] of [[archives[0], seeds[1]], [archives[1], steps.length]]) {
      expect(steps.slice(from, to).some((s) => s.noServer && /device_thread_/.test(s.noServer.source))).toBe(true);
    }
  });

  it('match settings lines with or without the journal session (escaped defect: HIL run 20260929-174227-773e)', () => {
    // Once the socket is up the journal puts session= between state= and the
    // fields; before it, the line has no session.
    const bare = '91032 INFO v2.settings_closed state=SETTINGS changed=none';
    const withSession = '91032 INFO v2.settings_closed state=SETTINGS session=session_0123456789abcdef01234567 changed=none';
    const changed = '91032 INFO v2.settings_closed state=SETTINGS session=session_0123456789abcdef01234567 changed=wifi';
    for (const name of ['settings-navigation', 'factory-reset-guard']) {
      const steps = SCENARIOS.find((s) => s.name === name).steps;
      const waits = steps.filter((s) => s.waitDevice && /settings_(opened|closed)/.test(s.waitDevice.source));
      expect(waits.length).toBeGreaterThanOrEqual(2);
      for (const { waitDevice } of waits) {
        const event = /settings_(opened|closed)/.exec(waitDevice.source)[0];
        expect(waitDevice.test(bare.replace('settings_closed', event))).toBe(true);
        expect(waitDevice.test(withSession.replace('settings_closed', event))).toBe(true);
      }
      const closed = waits.find((s) => /settings_closed/.test(s.waitDevice.source)).waitDevice;
      expect(closed.test(changed)).toBe(false);
    }
  });

  it('cover every issue the owner asked the device to prove', () => {
    const issues = new Set(SCENARIOS.map((s) => s.issue));
    for (const issue of ['#baseline', '#302', '#301', '#314', '#330', '#315', '#311', '#333', '#389', '#565']) {
      expect(issues).toContain(issue);
    }
  });

  describe('epic #611 gaps', () => {
    const NEW = ['pair-from-scratch', 'pcm-reply', 'server-restart-reconnect', 'server-down-backoff', 'settings-from-pairing', 'revoke-4003'];
    const byName = (name) => SCENARIOS.find((s) => s.name === name);
    const sends = (s) => s.steps.filter((step) => step.send).map((step) => step.send);

    it('run early (after ptt-turn and reply-burst), revoke last; all expect a reconnect', () => {
      const names = SCENARIOS.map((s) => s.name);
      expect(names.slice(1, 3)).toEqual(['ptt-turn', 'reply-burst']);
      expect(names.slice(3, 3 + NEW.length)).toEqual(NEW);
      expect(names.at(-1)).toBe('heap-floor');
      for (const name of NEW) expect(byName(name).expectsReconnect).toBe(true);
      expect(validateScenario({ ...byName('ptt-turn'), expectsReconnect: 'yes' })).toEqual(['expectsReconnect, if set, must be true']);
    });

    it('pair from scratch through the web route and give the owner token back', () => {
      for (const name of ['pair-from-scratch', 'revoke-4003']) {
        const commands = sends(byName(name));
        const order = ['T token backup', 'T token forget', 'T server pair approve', 'T server pair auto'].map((c) => commands.indexOf(c));
        expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
        const back = (byName(name).finally ?? []).filter((step) => step.send).map((step) => step.send);
        expect(back).toContain('T token restore');
        expect(back.at(-1)).toBe('T bridge reset');  // reboots onto the restored token.
      }
      const waits = byName('pair-from-scratch').steps.filter((s) => s.waitDevice).map((s) => s.waitDevice);
      expect(waits.some((re) => re.test('9 INFO v2.ws_mode state=SOCKET tls=0 auth=0'))).toBe(true);
      expect(waits.some((re) => re.test('9 INFO v2.pairing_required state=SOCKET session=a reason=none'))).toBe(true);
      expect(waits.some((re) => re.test('9 INFO v2.device_token_saved state=PAIR session=a'))).toBe(true);
    });

    it('revoke drops the socket, erases the token, and the device stays in pairing without looping', () => {
      const steps = byName('revoke-4003').steps;
      const revoke = steps.findIndex((s) => s.send === 'T server device revoke');
      expect(steps.findIndex((s) => s.send === 'T server device rename')).toBeLessThan(revoke);
      const after = steps.slice(revoke, steps.findIndex((s, i) => i > revoke && s.send === 'T server pair approve'));
      // v2.closed carries the code the device echoed (1000 on run
      // 20260929-110910-342e), not the 4003 sent: no step may require a code.
      const closed = after.find((s) => s.waitServer && /v2\\\.closed/.test(s.waitServer.source));
      expect(closed.waitServer.test('{"event":"v2.closed","session":"s","stage":"ready","code":1000}')).toBe(true);
      expect(after.some((s) => s.waitServer && /"code"/.test(s.waitServer.source))).toBe(false);
      // The run's own device lines, in order, each matched.
      const run = [
        '2173 INFO v2.socket_closed state=SOCKET clean=1,retry_ms=1000',
        '2579 INFO v2.ws_mode state=SOCKET tls=0 auth=2',
        '2641 INFO v2.device_token_erased state=SOCKET reason=revoked',
        '2642 INFO v2.pairing_required state=SOCKET reason=revoked',
        '2696 INFO v2.pair_code_received state=PAIR',
      ];
      const waits = after.filter((s) => s.waitDevice).map((s) => s.waitDevice);
      expect(waits.map((re) => run.some((line) => re.test(line)))).toEqual(waits.map(() => true));
      const quiet = after.find((s) => s.noDevice);
      const serverClose = after.find((s) => s.noServer?.test('{"event":"v2.closed"}'));
      expect(serverClose.sessionFrom.test('{"event":"v2.pairing_required","session":"current","reason":"revoked"}')).toBe(true);
      expect(serverClose.sessionFrom.test('{"event":"v2.pairing_required","session":"old","reason":"none"}')).toBe(false);
      const serverPairing = after.find((s) => s.noServer?.test('{"event":"v2.pairing_required"}'));
      expect(serverPairing.sessionFrom).toBeUndefined();
      for (const line of ['9 INFO v2.socket_connect state=SOCKET', '9 INFO v2.socket_retry state=SOCKET delay_ms=1000']) {
        expect(quiet.noDevice.test(line)).toBe(true);
      }
      expect(quiet.timeoutMs).toBeGreaterThanOrEqual(10_000);
    });

    it('restart the server through the rig and prove the reconnect on the device and the server', () => {
      const steps = byName('server-restart-reconnect').steps;
      const restart = steps.findIndex((s) => s.send === 'T rig server-restart');
      expect(restart).toBeGreaterThan(0);
      const after = steps.slice(restart);
      expect(after.some((s) => s.waitDevice?.test('9 INFO v2.socket_closed state=SOCKET clean=0,retry_ms=2000'))).toBe(true);
      expect(after.some((s) => s.waitServer?.test('{"event":"v2.welcome","session":"s","format_id":2}'))).toBe(true);
      expect(after.at(-1)).toEqual({ assertState: { state: 'READY' }, timeoutMs: 5000 });  // ends on a full turn.
    });

    describe('server-down-backoff (#709)', () => {
      const closed = (at, retryMs, clean = 0) => `${at} INFO v2.socket_closed state=SOCKET clean=${clean},retry_ms=${retryMs}`;
      const connect = (at) => `${at} INFO v2.socket_connect state=SOCKET`;
      const firstBad = (lines) => {
        const matcher = new BackoffViolation();
        const bad = lines.find((line) => matcher.test(line)) ?? null;
        return { bad, problems: matcher.problems };
      };
      // Refused connects: each close comes ~10 ms after its connect.
      const refused = [closed(1000, 2000), connect(3000), closed(3010, 4000), connect(7010), closed(7020, 8000),
        connect(15020), closed(15030, 16000), connect(31030), closed(31040, 30000), connect(61040), closed(61050, 30000)];

      it('stops the server, watches ~70 s, checks the ladder, starts it and ends on a turn', () => {
        const steps = byName('server-down-backoff').steps;
        const at = (send) => steps.findIndex((s) => s.send === send);
        const watch = steps.findIndex((s) => s.noDevice instanceof BackoffViolation);
        expect(at('T rig server-stop')).toBeGreaterThan(0);
        expect(watch).toBeGreaterThan(at('T rig server-stop'));
        expect(steps[watch].timeoutMs).toBeGreaterThanOrEqual(60_000);
        expect(at('T rig server-start')).toBeGreaterThan(watch);
        const ladder = steps.slice(watch, at('T rig server-start')).filter((s) => s.waitDevice);
        expect(ladder.map((s) => refused.filter((line) => s.waitDevice.test(line)).length)).toEqual([1, 1, 1, 1]);
        const back = steps.slice(at('T rig server-start'));
        const welcome = back.find((s) => s.waitDevice?.test('9 INFO v2.welcome_accepted state=READY session=a format=2'));
        expect(welcome.timeoutMs).toBeLessThanOrEqual(40_000);
        expect(back.some((s) => s.noDevice?.test('9 INFO v2.pairing_required state=SOCKET reason=unknown'))).toBe(true);
        expect(steps.at(-1)).toEqual({ assertState: { state: 'READY' }, timeoutMs: 5000 });
        expect(byName('server-down-backoff').finally).toEqual([{ send: 'T rig server-start', expect: /^ok rig$/, timeoutMs: 120_000 }]);
      });

      it('passes the back-off, refused or timed out, with a clean close reconnecting at once', () => {
        expect(firstBad(refused).bad).toBeNull();
        const timedOut = [closed(1000, 2000), connect(3000), closed(8000, 4000), connect(12000), closed(17000, 8000), connect(25000)];
        expect(firstBad(timedOut).bad).toBeNull();
        expect(firstBad([closed(1000, 1000, 1), connect(1005), closed(1010, 2000), connect(3010)]).bad).toBeNull();
      });

      it('fails a connect every second (the #709 bug), a double connect or a broken ladder', () => {
        const everySecond = [closed(1000, 2000), connect(2000), closed(2010, 4000)];
        expect(firstBad(everySecond)).toMatchObject({ bad: connect(2000), problems: [expect.stringMatching(/1000 ms after a close with retry_ms=2000/)] });
        expect(firstBad([closed(1000, 2000), connect(3000), connect(3100)]).problems[0]).toMatch(/second socket_connect/);
        expect(firstBad([closed(1000, 2000), connect(3000), closed(3010, 8000)]).problems[0]).toMatch(/expected 4000/);
        // r1: the library retried every ~1 s with retry_ms already at 30000.
        expect(firstBad([closed(1000, 30000), connect(2000)]).bad).toBe(connect(2000));
      });

      it('starts a new timeline after a reboot', () => {
        expect(firstBad([closed(90_000, 30000), connect(120_000), closed(500, 2000), connect(2600)]).bad).toBeNull();
      });

      it('fails the scenario step through the engine on the first bad line', async () => {
        const device = createLineStream();
        const send = (command) => { device.push('T> ok rig'); if (command === 'T rig server-stop') device.push([closed(1000, 2000), connect(1200)].join('\n')); };
        const scenario = { name: 'x', issue: '#709', title: 'x', steps: [{ send: 'T rig server-stop' }, { noDevice: new BackoffViolation(), timeoutMs: 50 }] };
        expect(validateScenario(scenario)).toEqual([]);
        const result = await runScenario(scenario, { device, server: createLineStream(), send });
        expect(result.status).toBe('fail');
        expect(result.reason).toContain(connect(1200));
      });
    });

    it('pcm-reply waits for the firmware hook and checks both formats', () => {
      const pcm = byName('pcm-reply');
      expect(pcm.requires.map((r) => r.event)).toEqual(['hello_format_forced']);
      // The HIL firmware has the hook, so the scenario runs rather than SKIPs.
      const firmware = ['state_connection.cpp', 'test_console.cpp'].map((f) => readFileSync(new URL(`../../apps/cardputer/src/${f}`, import.meta.url), 'utf8')).join('\n');
      expect(missingFeatures(pcm, firmware)).toEqual([]);
      expect(firmware).toMatch(/strncmp\(cmd, "hello ", 6\) == 0/);
      // Run 20260929-110910-342e: the PCM buffer did not fit and the reply was
      // silent, yet playback_end_received and READY came. That must fail.
      const failFast = pcm.steps.filter((s) => s.noDevice?.test('5560 INFO v2.playback_buffer_failed state=WAIT free=231320'));
      expect(failFast).toHaveLength(2);
      expect(pcm.steps.some((s) => /playback_end_received/.test(s.waitDevice?.source ?? ''))).toBe(false);
      // MP3 goes back even when a step failed, so the next scenario is not in PCM.
      expect(pcm.finally[0]).toEqual({ send: 'T hello mp3', expect: /^ok$/ });
      expect(pcm.finally.some((s) => s.waitDevice?.test('9 INFO v2.welcome_accepted state=READY session=a format=2'))).toBe(true);
      const restart = byName('server-restart-reconnect').steps;
      expect(restart.some((s) => s.waitDevice?.test('81660 INFO v2.welcome_accepted state=READY session=a format=1'))).toBe(false);
      expect(restart.some((s) => s.waitDevice?.test('81660 INFO v2.welcome_accepted state=READY session=a format=2'))).toBe(true);
      const completed = pcm.steps.filter((s) => s.waitDevice && /playback_completed/.test(s.waitDevice.source));
      // One PCM turn and one MP3 turn, each through the shared helper.
      expect(completed.map((s) => s.waitDevice)).toEqual([replyPlayed('pcm16'), replyPlayed('mp3')]);
    });
  });
});

describe('scenario finally steps (engine.mjs runFinally)', () => {
  // A console that answers every command `ok`, except `T bad` (refused).
  const fakeRig = () => {
    const device = createLineStream();
    const sent = [];
    const send = (command) => {
      sent.push(command);
      device.push(command === 'T bad' ? 'T> err unknown' : 'T> ok');
    };
    return { device, server: createLineStream(), send, sent };
  };
  const scenario = (steps, finallySteps) => ({ name: 'x', issue: '#611', title: 'x', steps, finally: finallySteps });

  it('run after a failed step and keep its reason', async () => {
    const rig = fakeRig();
    const result = await runScenario(scenario([{ send: 'T bad' }, { send: 'T never' }], [{ send: 'T hello mp3', expect: /^ok$/ }]), rig);
    expect(rig.sent).toEqual(['T bad', 'T hello mp3']);
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/^step 1: /);
    expect(result.evidence.at(-1)).toBe('finally: > T hello mp3  < ok');
  });

  it('run after a pass, and a failing one fails the scenario', async () => {
    const rig = fakeRig();
    expect((await runScenario(scenario([{ send: 'T a' }], [{ send: 'T b' }]), rig)).status).toBe('pass');
    const failed = await runScenario(scenario([{ send: 'T a' }], [{ send: 'T bad' }]), rig);
    expect(failed.status).toBe('fail');
    expect(failed.reason).toMatch(/^finally step 1: console refused "T bad"/);
  });

  it('are validated like steps', () => {
    expect(validateScenario(scenario([{ send: 'T a' }], []))).toEqual(['finally, if set, must be a non-empty array of steps']);
    expect(validateScenario(scenario([{ send: 'T a' }], [{ sleep: -1 }]))).toEqual(['finally step 1: sleep must be 0..600000 ms']);
  });
});

describe('console-packet-edge (#709 c3)', () => {
  const edge = SCENARIOS.find((s) => s.name === 'console-packet-edge');
  // The reply text as test_console.cpp builds it: "echo=<n> " then 'x' to n - 5.
  const firmwareReply = (n) => `echo=${n} `.padEnd(n - 5, 'x');

  it('is registered after the #611 group and probes every edge 3 times in 500 ms', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(names.indexOf('console-packet-edge')).toBe(names.indexOf('revoke-4003') + 1);
    const probes = edge.steps.filter((s) => /^T echo /.test(s.send ?? ''));
    expect(PROBE_LENGTHS).toEqual([63, 64, 65, 127, 128, 129, 192, 256]);
    expect(probes).toHaveLength(PROBE_LENGTHS.length * 3);
    expect(probes.every((s) => s.timeoutMs === 500)).toBe(true);
    for (const n of PROBE_LENGTHS) expect(probes.filter((s) => s.send === `T echo ${n}`)).toHaveLength(3);
  });

  it('expects each reply to be exactly n bytes on the wire, and only its own', () => {
    for (const n of [16, ...PROBE_LENGTHS, 300]) {
      const reply = firmwareReply(n);
      expect(`T> ${reply}\r\n`).toHaveLength(n);
      expect(echoReply(n).test(reply)).toBe(true);
      expect(echoReply(n).test(firmwareReply(n + 1))).toBe(false);
      expect(echoReply(n).test(firmwareReply(n - 1))).toBe(false);
    }
  });

  it('sets the guard from BOB_HIL_ZLP (on unless off) and always turns it back on', () => {
    expect(guardSetting({})).toBe('on');
    expect(guardSetting({ BOB_HIL_ZLP: 'off' })).toBe('off');
    expect(guardSetting({ BOB_HIL_ZLP: 'yes' })).toBe('on');
    // The first step after baseline() (index.mjs withBaseline), before any probe.
    const set = edge.steps.findIndex((s) => /^T zlp (on|off)$/.test(s.send ?? ''));
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(edge.steps.findIndex((s) => /^T echo /.test(s.send ?? '')));
    expect(edge.steps[set].expect.test(`ok zlp=${edge.steps[set].send.slice(6)} late=0`)).toBe(true);
    expect(edge.finally.map((s) => s.send)).toEqual(['T zlp on', 'T zlp']);
    expect(edge.finally[1].expect.test('zlp=on late=2')).toBe(true);
    expect(edge.finally[1].expect.test('zlp=off late=2')).toBe(false);
  });

  it('the firmware has T echo and T zlp in the test console', () => {
    const console = readFileSync(new URL('../../apps/cardputer/src/test_console.cpp', import.meta.url), 'utf8');
    expect(console).toMatch(/strncmp\(cmd, "echo ", 5\) == 0/);
    expect(console).toMatch(/strcmp\(cmd, "zlp on"\) == 0/);
  });

  it('fails the probe whose reply sticks until the next output (the run 20260929-233629-b7e0 symptom)', async () => {
    const device = createLineStream();
    let stuck = null;
    const send = (command) => {
      if (stuck) { device.push(stuck); stuck = null; }  // held until more output follows
      const n = Number(/^T echo (\d+)$/.exec(command)?.[1]);
      const reply = `T> ${Number.isFinite(n) ? firmwareReply(n) : 'ok'}`;
      if (n === 128) stuck = reply; else device.push(reply);
    };
    const scenario = { name: 'x', issue: '#709', title: 'x', steps: probeSteps([127, 128, 129], 1).map((s) => ({ ...s, timeoutMs: 50 })) };
    const result = await runScenario(scenario, { device, server: createLineStream(), send });
    expect(result.status).toBe('fail');
    expect(result.reason).toMatch(/^step 2: no console reply to "T echo 128"/);
  });
});

describe('settings-from-pairing (#681)', () => {
  const scenario = SCENARIOS.find((s) => s.name === 'settings-from-pairing');
  const at = (send) => scenario.steps.findIndex((s) => s.send === send);

  it('holds one pairing before the reset, approves none, and turns auto-approval back on', () => {
    expect(at('T server pair manual')).toBeGreaterThanOrEqual(0);
    expect(at('T server pairing hold')).toBeGreaterThan(at('T server pair manual'));
    expect(at('T bridge reset')).toBeGreaterThan(at('T server pairing hold'));
    expect(scenario.steps.some((s) => s.send === 'T server pair approve')).toBe(false);
    expect(scenario.finally.map((s) => s.send).filter(Boolean)).toEqual(['T server pair auto']);
  });

  it('opens Settings on the pairing screen and ends READY with no pair request after the switch', () => {
    const comma = scenario.steps.findIndex((s) => s.press === ',');
    const pair = scenario.steps.findIndex((s) => s.assertState?.state === 'PAIR');
    const quiet = scenario.steps.find((s) => s.noDevice);
    expect(pair).toBeGreaterThan(at('T bridge reset'));
    expect(comma).toBe(pair + 1);
    expect(quiet.noDevice.test('51234 INFO v2.pair_request_sent state=PAIR')).toBe(true);
    expect(quiet.noDevice.test('51234 INFO v2.device_token_erased state=SOCKET reason=unknown profile=dev')).toBe(true);
    expect(scenario.steps.at(-1)).toMatchObject({ assertState: { state: 'READY' } });
  });
});

describe('barge-in scenarios (#1364)', () => {
  const ws = 'waveshare-s3-185c-hil';

  it('are valid, Waveshare only, and both soaks are opt-in', async () => {
    const { bargeIn, bargeInSoak, bargeInSoakWakeWord, SOAK_CLIP, SOAK_TURNS, WAKE_WORD_CLIP } = await import('./scenarios/barge-in.mjs');
    for (const s of [bargeIn, bargeInSoak, bargeInSoakWakeWord]) {
      expect(validateScenario(s)).toEqual([]);
      expect(s.board).toBe('waveshare');
    }
    expect(bargeInSoak.optIn).toBe(true);
    expect(bargeInSoakWakeWord.optIn).toBe(true);
    const names = (env, argv) => scenariosFor(env, argv).map((s) => s.name);
    expect(names(ws, ['node', 'run.mjs'])).toContain('barge-in');
    expect(names(ws, ['node', 'run.mjs'])).not.toContain('barge-in-soak');
    expect(names(ws, ['node', 'run.mjs'])).not.toContain('barge-in-soak-wake-word');
    expect(names(ws, ['node', 'run.mjs', '--scenario', 'barge-in-soak'])).toContain('barge-in-soak');
    expect(names(ws, ['node', 'run.mjs', '--scenario', 'barge-in-soak'])).not.toContain('barge-in-soak-wake-word');
    expect(names(ws, ['node', 'run.mjs', '--scenario', 'barge-in-soak-wake-word'])).toContain('barge-in-soak-wake-word');
    expect(names(ws, ['node', 'run.mjs', '--scenario', 'barge-in-soak-wake-word'])).not.toContain('barge-in-soak');
    expect(names('m5stack-cardputer-hil', ['--scenario', 'barge-in-soak-wake-word'])).not.toContain('barge-in-soak-wake-word');
    expect(WAKE_WORD_CLIP).toBe('data/wake-test/sapi-bob-bdaae7a5ff6643079615e87f828d83b6/hey_bob.wav');
    for (const [soak, clip] of [[bargeInSoak, SOAK_CLIP], [bargeInSoakWakeWord, WAKE_WORD_CLIP]]) {
      expect(soak.requiresFiles).toEqual([clip]);
      const sends = soak.steps.filter((s) => s.send?.startsWith('T server tts_next'));
      expect(sends).toHaveLength(SOAK_TURNS);
      for (const s of sends) expect(s.send).toBe(`T server tts_next 20 ${clip}`);
      // The run-long check: no barge_in since the run began, and the device is READY in wake mode.
      const quiet = soak.steps.filter((s) => s.noDevice && s.since === 'run');
      expect(quiet).toHaveLength(1);
      expect(quiet[0].noDevice.test('4120 INFO v2.barge_in state=WAIT stage=reply')).toBe(true);
      expect(quiet[0].noDevice.test('4120 INFO v2.barge_listening state=WAIT')).toBe(false);
    }
  });

  it('speaks at volume 30 at most, with at most 3 tries', async () => {
    const { parseSpeak, speechCommand } = await import('./rig.mjs');
    expect(parseSpeak('T rig speak 30 3 Hey Bob')).toEqual({ volume: 30, tries: 3, text: 'Hey Bob' });
    expect(parseSpeak('T rig speak 31 3 Hey Bob')).toBeNull();
    expect(parseSpeak('T rig speak 30 4 Hey Bob')).toBeNull();
    expect(parseSpeak("T rig speak 30 1 Hey'; calc")).toBeNull();
    const [cmd, args] = speechCommand('Hey Bob', 30);
    expect(cmd).toBe('powershell.exe');
    expect(args.at(-1)).toContain('$s.Volume = 30');
    expect(args.at(-1)).toContain("Speak('Hey Bob')");
  });
});
