// Automated on-device downlink test: builds+flashes (unless --skip-flash),
// streams audio at the device, watches the serial output for a bounded window,
// and reports pass/fail — so verifying a firmware change against real hardware
// doesn't require manually juggling flash/monitor/server processes and hunting
// stray PIDs afterward.
//
// Two modes:
//   --server=mock (default) streams a known MP3 file via the mock server.
//   --server=real drives the device's BOB_AUTO_TURN build against the real
//     API server in BOB_SYSTEM_TEST mode (real TTS), scoring each auto-turn
//     cycle from the device serial cross-checked against the server journal.
//
// Usage (from repo root): npm run device:test [-- --skip-flash --duration=30000 --file=audio.mp3]
//                         [--runs=10 --run-timeout=45000 --pcm16-hello --tone-test]
// Usage (from repo root): npm run device:integration [-- --runs=10 --transcript="..."]
// Usage (from apps/cardputer): npm run test:device [-- --skip-flash]
//
// --runs=N        stream the file N times over ONE connection and score each
//                  stream/playback pair separately (flash happens once). The
//                  socket deliberately stays up between cycles: dropping it
//                  puts the device into its reconnect backoff (up to 30 s) and
//                  the soak ends up measuring reconnect timing, not downlink
//                  reliability.
// --gap-ms=       idle time between cycles. Defaults to the audio's real
//                  duration + 2500 ms; it MUST exceed playback plus teardown
//                  drain or cycles overlap and merge into one playback.
// --run-timeout=  per-run budget for "mock streams + playback completes"
//                  (default 45 s).
// --pcm16-hello   add -DBOB_PCM16_HELLO to the build (hello requests PCM16
//                  instead of the MP3 default), for comparison runs.
// --tone-test     add -DBOB_TONE_TEST to the build (plays a 1 s tone probe
//                  at boot and journals tone_play ms).
//
// Every child process this script spawns is tracked and force-killed in a
// single cleanup path (normal exit, error, or Ctrl+C) — nothing is left
// holding the serial port or the mock server's TCP port afterward.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectMp3 } from '../../api/scripts/inspect-mp3.mjs';

const CARDPUTER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CARDPUTER_DIR, '..', '..');
const ENV = 'm5stack-cardputer-v2-poc';
const PORT = process.env.BOB_COM_PORT ?? 'COM3';
const PY = process.env.BOB_PIO_PY ?? 'py -3.11';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const skipFlash = args.includes('--skip-flash');
// MP3 is the firmware default now; this flag forces the PCM16 path.
const pcm16Hello = args.includes('--pcm16-hello');
const toneTest = args.includes('--tone-test');
// --server=real drives the device's BOB_AUTO_TURN firmware against the real
// API server in BOB_SYSTEM_TEST mode (real TTS) instead of the mock MP3
// server. --transcript overrides the deterministic STT transcript; the default
// is a ~500-char neutral paragraph. --keep-test-firmware skips restoring the
// normal build on exit.
const realServer = args.includes('--server=real');
const keepTestFirmware = args.includes('--keep-test-firmware');
// --real-tts keeps TTS real inside --server=real (BOB_SYSTEM_TEST_REAL_TTS=1),
// i.e. today's behaviour; the default is the deterministic WAV stub whose length
// is set by --tts-seconds.
const realTts = args.includes('--real-tts');
const ttsSeconds = flag('tts-seconds', '12');
const transcript =
  flag(
    'transcript',
    'It is a truth universally acknowledged that the answer to a spoken question is not always simple. This automated integration test exercises the full voice pipeline from the device through the server and back to the speaker, using real speech synthesis. Keeping the transcript long and deterministic guarantees the reply contains enough audio to validate buffered playback, pacing, sequence integrity, and drop-free delivery over the WebSocket. This paragraph is deliberately neutral and contains no sensitive information whatsoever.',
  );
const runs = Math.max(1, Number(flag('runs', '1')));
const runTimeoutMs = Number(flag('run-timeout', flag('duration', realServer ? '150000' : '45000')));
const mockPort = Number(flag('mock-port', '7445'));
const mp3File = resolve(REPO_ROOT, flag('file', 'audio.mp3'));
const logFile = resolve(REPO_ROOT, 'data', 'device-test.log');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/device-test.mjs [options]

Builds+flashes the Cardputer, streams audio at it, watches serial, and reports
pass/fail per stream/playback cycle.

Modes:
  --server=mock   (default) stream a known MP3 file via the mock server.
  --server=real   drive the device's BOB_AUTO_TURN build against the real
                  API server (BOB_SYSTEM_TEST=1) scoring device auto-turns.
                  TTS is the deterministic stub (--tts-seconds) unless
                  --real-tts restores real synthesis.

Options:
  --runs=N                number of cycles to score (default 1).
  --transcript=<text>     deterministic STT transcript for --server=real.
  --real-tts              in --server=real, keep TTS real via
                          BOB_SYSTEM_TEST_REAL_TTS=1 instead of the
                          deterministic stub.
  --tts-seconds=N         in --server=real deterministic mode, stub TTS length
                          in seconds (default 12).
  --keep-test-firmware    on exit, leave the AUTO_TURN firmware flashed instead
                          of re-flashing the normal build.
  --mock-port=N           port for the server (default 7445).
  --run-timeout=MS        per-run budget for stream+playback (default 45000
                          mock / 150000 --server=real).
  --gap-ms=MS             idle between mock cycles (default audio length+2500).
  --pcm16-hello           build with -DBOB_PCM16_HELLO.
  --tone-test             build with -DBOB_TONE_TEST.
  --skip-flash            reuse firmware already on the device.

Every child process is tracked and force-killed on exit; secrets.h and
platformio.ini build flags are restored, and --server=real re-flashes the
normal build unless --keep-test-firmware.`);
  process.exit(0);
}
mkdirSync(dirname(logFile), { recursive: true });

// --- Mock mode only: source MP3 analysis for streamed-audio scoring ---
// sourceSamples is the only reference that can catch a cut tail: the device's
// out_expected_ms is derived from the frames it actually decoded, so if the
// tail is lost both the measured and expected spans shrink together and the
// duration ratio stays ~1.0.
let sourceSamples = 0;
let sourceDurationMs = 0;
let gapMs = 0;
let kSampleSlack = 0;
if (!realServer) {
  if (!existsSync(mp3File)) {
    console.error(`[device-test] MP3 file not found: ${mp3File}`);
    process.exit(1);
  }
  const source = inspectMp3(readFileSync(mp3File));
  sourceSamples = source.samples;
  sourceDurationMs = source.durationMs;
  // Tolerance for the final partial output buffer, which is legitimately never
  // flushed as a full chunk. This was two MP3 frames while inspectMp3 counted
  // the Xing/Info header frame as audio: the source read 1152 samples high, so
  // a device decoding the stream EXACTLY looked one frame short and the slack
  // was covering for the parser. With the header frame excluded the device
  // matches to within a sample, so half a frame is ample and truncation is
  // detected ~4x sooner.
  kSampleSlack = 576;

  // The gap between cycles MUST exceed playback plus teardown drain, or the next
  // playback_start lands while the previous one is still draining. The cycles
  // then merge: down_frames counts both (53 of an expected 30 observed), the
  // per-cycle sequence restart reads as a gap, and the overlap is scored as a
  // firmware failure when it is purely a harness artifact. Derive it from the
  // audio's real length rather than guessing a constant.
  gapMs = Number(flag('gap-ms', String(sourceDurationMs + 2500)));
}

// The device connects to whatever host:port include/secrets.h was compiled
// with, so testing against the local mock server means temporarily repointing
// V2_PORT at it. Rewrite it here and always restore the original on the way
// out (including Ctrl+C / crash) so a test run can never silently leave the
// firmware source pointed at the mock — that repoint-by-hand step was the
// last manual part of this workflow.
const secretsPath = resolve(CARDPUTER_DIR, 'include', 'secrets.h');
let secretsOriginal = null;

// Restore is normally driven by a process 'exit' handler, but that does not
// run on an abrupt kill. A compile once died with 0xC0000142 and left
// secrets.h pointed at the mock and -DBOB_PCM16_HELLO in the build, which
// silently changes what every LATER build targets. Persist the originals to a
// sentinel so the next startup can put them back before doing anything else.
const sentinelPath = resolve(REPO_ROOT, 'data', 'device-test-restore.json');

function writeSentinel() {
  if (secretsOriginal === null && iniOriginal === null) return;
  writeFileSync(sentinelPath, JSON.stringify({
    [secretsPath]: secretsOriginal,
    [iniPath]: iniOriginal,
  }));
}

function recoverSentinel() {
  if (!existsSync(sentinelPath)) return;
  try {
    const saved = JSON.parse(readFileSync(sentinelPath, 'utf8'));
    for (const [file, contents] of Object.entries(saved)) {
      if (typeof contents === 'string' && readFileSync(file, 'utf8') !== contents) {
        writeFileSync(file, contents);
        console.log(`[device-test] recovered ${file} from an interrupted run`);
      }
    }
  } catch (err) {
    console.error(`[device-test] could not read restore sentinel: ${err.message}`);
  }
  rmSync(sentinelPath, { force: true });
}
function repointSecretsAtMock() {
  if (skipFlash) return;  // not reflashing, so the on-device target is unchanged
  if (!existsSync(secretsPath)) {
    console.error(`[device-test] ${secretsPath} not found — copy secrets.example.h first`);
    process.exit(1);
  }
  const current = readFileSync(secretsPath, 'utf8');
  const repointed = current.replace(/#define\s+V2_PORT\s+\d+/, `#define V2_PORT ${mockPort}`);
  if (repointed !== current) {
    secretsOriginal = current;
    writeFileSync(secretsPath, repointed);
    writeSentinel();
    console.log(`[device-test] temporarily repointed secrets.h V2_PORT -> ${mockPort}`);
  }
}
function restoreSecrets() {
  if (secretsOriginal === null) return;
  writeFileSync(secretsPath, secretsOriginal);
  secretsOriginal = null;
  console.log('[device-test] restored original secrets.h V2_PORT');
}

// Test-only build flags (BOB_PCM16_HELLO / BOB_TONE_TEST) are appended to
// platformio.ini build_flags and restored on the way out, mirroring the
// secrets repoint pattern above.
const iniPath = resolve(CARDPUTER_DIR, 'platformio.ini');
let iniOriginal = null;
function appendBuildFlags() {
  if (skipFlash) return;
  const flags = [];
  if (pcm16Hello) flags.push('-DBOB_PCM16_HELLO');
  if (toneTest) flags.push('-DBOB_TONE_TEST');
  if (realServer) flags.push('-DBOB_AUTO_TURN');
  if (flags.length === 0) return;
  const current = readFileSync(iniPath, 'utf8');
  const addition = `  ${flags.join(' ')}\n`;
  if (!current.includes(flags[0])) {
    iniOriginal = current;
    writeFileSync(iniPath, current.replace(/(build_flags =\r?\n)/, `$1${addition}`));
    console.log(`[device-test] temporarily added build flags: ${flags.join(' ')}`);
  }
}
function restoreIni() {
  if (iniOriginal === null) return;
  writeFileSync(iniPath, iniOriginal);
  iniOriginal = null;
  console.log('[device-test] restored original platformio.ini build_flags');
}

const children = [];
let cleanedUp = false;

function killWindowsTree(pid) {
  if (process.platform === 'win32' && pid) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children) {
    if (child.pid && !child.killed) {
      killWindowsTree(child.pid);
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  restoreSecrets();
  restoreIni();
  rmSync(sentinelPath, { force: true });
  // --server=real flashed the AUTO_TURN test build; put the normal build back
  // (no BOB_AUTO_TURN, V2_PORT restored) unless the caller opted to keep it.
  // secrets.h and platformio.ini are already restored above, so this pio run
  // compiles the stock firmware. Runs after children are killed so the serial
  // port and server port are free for the flash.
  if (realServer && !skipFlash && !keepTestFirmware) {
    console.log('[device-test] re-flashing the NORMAL build (no AUTO_TURN)...');
    pio(['run', '-e', ENV]);
    pio(['run', '-e', ENV, '--target', 'upload', '--upload-port', PORT]);
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

function pio(pioArgs) {
  const [py, ...pyArgs] = PY.split(' ');
  const result = spawnSync(py, [...pyArgs, '-m', 'platformio', ...pioArgs], {
    cwd: CARDPUTER_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    console.error('[device-test] build/flash failed');
    process.exit(result.status ?? 1);
  }
}

recoverSentinel();
spawnSync('node', [resolve(CARDPUTER_DIR, 'scripts/free-serial-port.mjs')], { stdio: 'inherit' });

repointSecretsAtMock();
appendBuildFlags();

if (!skipFlash) {
  console.log('[device-test] compiling...');
  pio(['run', '-e', ENV]);
  console.log('[device-test] flashing...');
  pio(['run', '-e', ENV, '--target', 'upload', '--upload-port', PORT]);
} else {
  console.log('[device-test] --skip-flash: using firmware already on the device');
}

const logFd = openSync(logFile, 'w');

let mp3Bytes = 0;
let expectedFrames = 0;
let bitrateKbps = 64;
let estimatedPlayMs = 0;
if (!realServer) {
  mp3Bytes = statSync(mp3File).size;
  expectedFrames = Math.ceil(mp3Bytes / 1024);
  // Playback duration is scored against out_expected_ms in the device's own
  // playback_completed journal (frames actually decoded / the rate the decoder
  // reported), NOT against a bitrate guess. An earlier --bitrate-kbps=160
  // default assumed a 1.5 s clip for this 29,804 B file; the decoder reports
  // 177,409 frames @48 kHz = 3.70 s, so the harness was declaring a correct
  // 3.72 s playback "5.6x too slow" and sending us after a bug that wasn't
  // there. Derive the expectation from the device, and only fall back to the
  // bitrate estimate when the journal predates that field.
  bitrateKbps = Number(flag('bitrate-kbps', '64'));
  estimatedPlayMs = Math.round((mp3Bytes * 8) / bitrateKbps);
}
const deviceExpectedMs = () => {
  const hit = [...buffer.matchAll(/out_expected_ms=(\d+)/g)].at(-1);
  return hit ? Number(hit[1]) : estimatedPlayMs;
};

// --- Serial monitor (one continuous session; per-run scoring segments it) ---
console.log(`[device-test] watching serial (${PORT}) — reset the device now if it isn't already pointed at this mock server's host:port`);
const [py, ...pyArgs] = PY.split(' ');
const monitor = spawn(py, [...pyArgs, '-m', 'platformio', 'device', 'monitor', '--port', PORT, '--baud', '115200'], {
  cwd: CARDPUTER_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(monitor);

let buffer = '';
monitor.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  process.stdout.write(chunk);
  writeSync(logFd, chunk);
});
monitor.stderr.on('data', (chunk) => {
  buffer += chunk.toString();
  writeSync(logFd, chunk);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}
const countCompletions = () => [...buffer.matchAll(/playback_completed/g)].length;
const completionLines = () => buffer.split('\n').filter((l) => l.includes('playback_completed'));

// The playback_started that actually belongs to a given playback_completed:
// the last start appearing before it in the log. Indexing starts and
// completions independently desyncs permanently after a single orphan start —
// playback_started is journaled for any format and any stage, so a socket
// drop, a PCM turn or a device reset can produce a start with no completion,
// after which every pair spans two different playbacks.
function startFor(completionLine) {
  const lines = buffer.split('\n');
  const end = lines.indexOf(completionLine);
  if (end < 0) return undefined;
  for (let i = end - 1; i >= 0; i--) {
    if (lines[i].includes('playback_started')) return lines[i];
    // Do not search past the previous completion: anything earlier belongs to
    // a different playback.
    if (lines[i].includes('playback_completed')) return undefined;
  }
  return undefined;
}
const field = (line, name) => (line.match(new RegExp(`${name}=([^,]+)`)) ?? [])[1];
const uptimeOf = (line) => Number((line.match(/^(\d+)/) ?? [])[1]);

// Spawns a fresh mock server, teeing stdout/stderr into the console AND the
// log file (the send-completion evidence was console-only before, so past
// logs could not prove the mock actually finished its 30-frame send loop).
let lastMock = null;
function spawnMock(repeat) {
  if (lastMock && lastMock.pid) killWindowsTree(lastMock.pid);
  lastMock = spawn(
    'node',
    [
      resolve(REPO_ROOT, 'apps/api/scripts/mock-mp3-server.mjs'),
      String(mockPort),
      mp3File,
      `--repeat=${repeat}`,
      `--gap-ms=${gapMs}`,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(lastMock);
  lastMock.stdout.on('data', (d) => {
    process.stdout.write(`[mock] ${d}`);
    writeSync(logFd, `[mock] ${d}`);
  });
  lastMock.stderr.on('data', (d) => {
    process.stderr.write(`[mock] ${d}`);
    writeSync(logFd, `[mock] ${d}`);
  });
  lastMock.mockOutput = '';
  lastMock.stdout.on('data', (d) => { lastMock.mockOutput += d.toString(); });
  return lastMock;
}

// Spawns the real API server for --server=real: BOB_SYSTEM_TEST=1 stubs STT
// and the agent, BOB_SYSTEM_TEST_REAL_TTS=1 keeps TTS real (silent otherwise),
// V2_PORT repoints to the mock port, and a per-run journal file lets the harness
// cross-check the device's playback against the server's downlink. Tracked as a
// child so the normal cleanup path kills it.
const journalPath = resolve(REPO_ROOT, 'data', 'device-test-server-journal.log');
// Each invocation gets a fresh journal: truncate any left from an earlier run
// before the server starts, and record the start so scoring only considers
// events written after this harness spawned the server (stale turns from a
// prior invocation can otherwise shift the Nth turn_completed index).
let serverStartTs = 0;
function spawnRealServer() {
  writeFileSync(journalPath, '');
  serverStartTs = new Date().toISOString();
  const server = spawn(
    process.execPath,
    [
      resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      resolve(REPO_ROOT, 'apps/api/src/server.ts'),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BOB_V2_PORT: String(mockPort),
        BOB_SYSTEM_TEST: '1',
        ...(realTts
          ? { BOB_SYSTEM_TEST_REAL_TTS: '1' }
          : { BOB_SYSTEM_TEST_TTS_SECONDS: ttsSeconds }),
        BOB_SYSTEM_TEST_TRANSCRIPT: transcript,
        BOB_V2_JOURNAL: journalPath,
      },
    },
  );
  children.push(server);
  server.serverOutput = '';
  server.stdout.on('data', (d) => {
    process.stdout.write(`[api] ${d}`);
    writeSync(logFd, `[api] ${d}`);
    server.serverOutput += d.toString();
  });
  server.stderr.on('data', (d) => {
    process.stderr.write(`[api] ${d}`);
    writeSync(logFd, `[api] ${d}`);
    server.serverOutput += d.toString();
  });
  return server;
}

// Scores one stream/playback pair. `line` is the run's playback_completed
// serial line; `startedUptime` is the uptime of its playback_started; failures
// are collected as short reason strings.
function scoreRun(line, startedUptime, streamedFrames, previousRxDrops) {
  const failures = [];
  const downFrames = Number(field(line, 'down_frames') ?? -1);
  const ringAvail = Number(field(line, 'ring_avail') ?? -1);
  const overflow = field(line, 'overflow');
  const seqGaps = Number(field(line, 'seq_gaps') ?? -1);
  const rxDrops = Number(field(line, 'rx_drops') ?? -1);
  const exitReason = field(line, 'mp3_exit') ?? '?';
  const completedUptime = uptimeOf(line);
  const midStreamClose = [...buffer.matchAll(/^(\d+) INFO v2\.socket_closed/gm)]
    .some((m) => {
      const t = Number(m[1]);
      return t >= startedUptime && t <= completedUptime;
    });
  if (downFrames < (streamedFrames ?? expectedFrames)) failures.push(`down_frames_short(${downFrames}/${streamedFrames ?? expectedFrames})`);
  if (ringAvail > 0) failures.push(`ring_undrained(${ringAvail})`);
  if (overflow !== undefined && overflow !== '0' && overflow !== 'false') failures.push(`overflow(${overflow})`);
  if (seqGaps > 0) failures.push(`seq_gap(${seqGaps})`);
  // rx_drops is a SESSION counter, reset at welcome — not per playback. With
  // several cycles on one connection it only ever grows, so comparing it to
  // zero condemns every cycle after the first drop (runs 5, 6 and 7 all
  // reported the same 13 while run 7's transport was clean). Score the
  // increment attributable to this cycle instead.
  const rxDropsDelta = rxDrops - previousRxDrops;
  if (rxDropsDelta > 0) failures.push(`rx_drops(+${rxDropsDelta})`);
  // More frames than the mock sent means this playback absorbed the next
  // cycle's frames too — the cycles overlapped, so every other number on this
  // line describes two merged playbacks and cannot be trusted.
  if (downFrames > (streamedFrames ?? expectedFrames)) {
    failures.push(`cycle_overlap(${downFrames}>${streamedFrames ?? expectedFrames})`);
  }
  if (exitReason === 'loop_false_early') failures.push('decode_early_exit');
  if (midStreamClose) failures.push('mid_stream_close');
  const warnLines = [...buffer.matchAll(/^(\d+) INFO v2\.(mp3_drain_timeout|mp3_oom)/gm)]
    .filter((m) => {
      const t = Number(m[1]);
      return t >= startedUptime && t <= completedUptime;
    });
  if (warnLines.length) failures.push(...warnLines.map((m) => m[2]));

  // Full-length check: the playback_started -> playback_completed span must
  // match the audio the decoder says it produced. Short means the tail was cut
  // (the truncation bug); long means the speaker is being starved and the
  // reply comes out chopped. +/-25% absorbs the pre-roll before the first
  // chunk reaches the speaker and the teardown drain wait.
  // Read this run's own out_expected_ms off its completion line. Scanning the
  // whole buffer for the latest value would score run N against run N+1 when
  // two cycles complete inside one 250 ms poll interval.
  const expectedMs = Number(field(line, 'out_expected_ms')) || deviceExpectedMs();
  const actualMs = completedUptime - startedUptime;
  // Paired lines must belong to the same playback: playback_started is
  // journaled for any format and any stage, so one orphan start (socket drop,
  // PCM turn, device reset) would shift every later pairing by one and start
  // measuring across two different playbacks.
  if (startedUptime > 0 && actualMs < 0) failures.push('start_completion_desync');

  // Content loss: decoded samples vs the source file's own sample count.
  const outFrames = Number(field(line, 'out_frames') ?? -1);
  if (outFrames >= 0 && outFrames < sourceSamples - kSampleSlack) {
    failures.push(`audio_truncated(${outFrames}/${sourceSamples} samples)`);
  }
  if (expectedMs > 0 && startedUptime > 0) {
    if (actualMs < expectedMs * 0.75) failures.push(`play_short(${actualMs}/${expectedMs}ms)`);
    if (actualMs > expectedMs * 1.25) failures.push(`play_slow(${actualMs}/${expectedMs}ms)`);
  }
  return failures;
}

// --- Real-server mode scoring ---
// Reads the per-run API journal (JSON lines, one entry each) written under
// BOB_V2_JOURNAL and cross-checks the device's playback_completed against
// the server's own record of what it synthesized and streamed.
const journalEvents = () => {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => serverStartTs === 0 || (typeof e.ts === 'string' && e.ts >= serverStartTs));
};
function scoreRealRun(line, startedUptime, previousRxDrops, runIndex) {
  const failures = [];
  const downFrames = Number(field(line, 'down_frames') ?? -1);
  const ringAvail = Number(field(line, 'ring_avail') ?? -1);
  const overflow = field(line, 'overflow');
  const seqGaps = Number(field(line, 'seq_gaps') ?? -1);
  const rxDrops = Number(field(line, 'rx_drops') ?? -1);
  const outFrames = Number(field(line, 'out_frames') ?? -1);
  const expectedMs = Number(field(line, 'out_expected_ms') ?? -1);
  const completedUptime = uptimeOf(line);

  // The server's journal for this turn: the run's Nth turn_completed, plus the
  // turn_stage_tts_completed that precedes it (mp3_bytes) and any turn_failed.
  const turns = journalEvents().filter((e) => e.event === 'v2.turn_completed');
  const failed = journalEvents().some((e) => e.event === 'v2.turn_failed');
  const turn = turns[runIndex - 1];
  const tts = journalEvents()
    .filter((e) => e.event === 'v2.turn_stage_tts_completed')[runIndex - 1];
  const serverDownFrames = turn?.down_frames ?? -1;
  const serverMp3Bytes = tts?.mp3_bytes ?? -1;

  if (failed) failures.push('server_turn_failed');
  // Exact frame parity: every frame the server streamed must reach the device.
  if (serverDownFrames >= 0 && downFrames !== serverDownFrames) {
    failures.push(`down_frames_mismatch(device=${downFrames},server=${serverDownFrames})`);
  }
  if (ringAvail > 0) failures.push(`ring_undrained(${ringAvail})`);
  if (overflow !== undefined && overflow !== '0' && overflow !== 'false') failures.push(`overflow(${overflow})`);
  if (seqGaps > 0) failures.push(`seq_gap(${seqGaps})`);
  const rxDropsDelta = rxDrops - previousRxDrops;
  if (rxDropsDelta > 0) failures.push(`rx_drops(+${rxDropsDelta})`);
  // Truncation check anchored to the server's real synthesized bytes, not a
  // fixed source file: the device's decoded playback must cover at least 90%
  // of the audio implied by mp3_bytes at 32 kbps (4000 B/s). This is the real
  // mode's equivalent of audio_truncated in mock scoring.
  if (serverMp3Bytes > 0 && expectedMs > 0) {
    const impliedAudioMs = (serverMp3Bytes / 4000) * 1000;
    if (expectedMs < impliedAudioMs * 0.9) {
      failures.push(`audio_truncated(dev_ms=${expectedMs},server_ms=${Math.round(impliedAudioMs)})`);
    }
  }
  return failures;
}

// --- Soak: one long-lived server, one connection, `runs` cycles ---
// The server used to be killed and respawned per run, which dropped the socket
// and pushed the device into its reconnect backoff (kSocketReconnectMaxMs =
// 30 s, reset only on WStype_CONNECTED). Consecutive runs ended up minutes
// apart and the soak measured reconnect timing instead of downlink
// reliability. One long-lived server streaming N cycles keeps the device
// connected throughout.
const results = [];
// Session-cumulative counters are diffed per cycle; see scoreRun.
let prevRxDrops = 0;

if (realServer) {
  // Wait for the API to accept connections before counting auto-turn cycles.
  const server = spawnRealServer();
  console.log('[device-test] waiting for the real API server /health...');
  const healthOk = await waitFor(() => {
    try {
      const up = spawnSync('node', ['-e',
        `fetch('http://127.0.0.1:${mockPort}/health').then(r=>r.json()).then(()=>process.exit(0)).catch(()=>process.exit(1))`],
        { timeout: 5000 });
      return up.status === 0;
    } catch { return false; }
  }, 30000, 1000);
  if (!healthOk) {
    console.error('[device-test] real API server did not become healthy');
    cleanup();
    process.exit(1);
  }
  console.log('[device-test] real API server healthy; device auto-turns will drive cycles');

  for (let run = 1; run <= runs; run++) {
    console.log(`\n=== run ${run}/${runs} ===`);
    // In real mode the device starts each turn itself (BOB_AUTO_TURN), so a
    // cycle completes when its playback_completed line appears and the server
    // has journaled a matching turn_completed.
    const completed = await waitFor(() => countCompletions() >= run, runTimeoutMs, 250);
    if (!completed) {
      console.log(`run ${run}: TIMEOUT waiting for auto-turn playback_completed`);
      results.push({ run, pass: false, reasons: ['timeout_no_completion'] });
      continue;
    }
    const line = completionLines()[run - 1];
    const startLine = startFor(line);
    const startedUptime = startLine ? uptimeOf(startLine) : 0;
    const reasons = scoreRealRun(line, startedUptime, prevRxDrops, run);
    prevRxDrops = Number(field(line, 'rx_drops') ?? prevRxDrops);
    const pass = reasons.length === 0;
    const downFrames = Number(field(line, 'down_frames') ?? -1);
    console.log(`run ${run}: ${pass ? 'PASS' : 'FAIL'} — down_frames=${field(line, 'down_frames')} ring_avail=${field(line, 'ring_avail')} seq_gaps=${field(line, 'seq_gaps')} rx_drops=${field(line, 'rx_drops')}${pass ? '' : ` [${reasons.join(', ')}]`}`);
    results.push({ run, pass, reasons, downFrames });
  }
} else {
  const mock = spawnMock(runs);
  const cycleCount = () => [...mock.mockOutput.matchAll(/streamed (\d+) frames/g)].length;
  for (let run = 1; run <= runs; run++) {
    console.log(`\n=== run ${run}/${runs} ===`);

    const streamed = await waitFor(() => cycleCount() >= run, runTimeoutMs, 250);
    if (!streamed) {
      console.log(`run ${run}: TIMEOUT waiting for mock stream cycle ${run}`);
      results.push({ run, pass: false, reasons: ['timeout_no_stream'] });
      continue;
    }
    const streamedFrames = Number(
      [...mock.mockOutput.matchAll(/streamed (\d+) frames/g)][run - 1][1]);
    console.log(`run ${run}: mock streamed ${streamedFrames} frames`);

    const completed = await waitFor(() => countCompletions() >= run, runTimeoutMs, 250);
    if (!completed) {
      console.log(`run ${run}: TIMEOUT waiting for playback_completed (decode or transport wedged)`);
      results.push({ run, pass: false, reasons: ['timeout_no_completion'] });
      continue;
    }
    // Index by run, not .at(-1): with several cycles on one connection the last
    // completion is not necessarily the one this run just waited for.
    const line = completionLines()[run - 1];
    const startLine = startFor(line);
    const startedUptime = startLine ? uptimeOf(startLine) : 0;
    const reasons = scoreRun(line, startedUptime, streamedFrames, prevRxDrops);
    prevRxDrops = Number(field(line, 'rx_drops') ?? prevRxDrops);
    const pass = reasons.length === 0;
    console.log(`run ${run}: ${pass ? 'PASS' : 'FAIL'} — down_frames=${field(line, 'down_frames')} ring_avail=${field(line, 'ring_avail')} ring_peak=${field(line, 'ring_peak')} seq_gaps=${field(line, 'seq_gaps')} rx_drops=${field(line, 'rx_drops')} mp3_exit=${field(line, 'mp3_exit')}${pass ? '' : ` [${reasons.join(', ')}]`}`);
    results.push({ run, pass, reasons });
  }
}

// --- Report ---
console.log(`\nfull serial log: ${logFile}`);
console.log('=== device-test report ===');
if (realServer) {
  console.log(`mode: real API server (${mockPort}), transcript chars: ${transcript.length}`);
} else {
  console.log(`mp3 file: ${mp3File} (${mp3Bytes}B, ${expectedFrames} wire frames, ${sourceSamples} samples / ${sourceDurationMs}ms of audio)`);
}
console.log(`runs: ${runs}, per-run budget: ${runTimeoutMs}ms`);
for (const r of results) {
  console.log(`run ${r.run}: ${r.pass ? 'PASS' : `FAIL [${r.reasons.join(', ')}]`}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`result: ${passed}/${results.length} runs passed`);
let overallPass = results.every((r) => r.pass);
// Deterministic TTS must produce identical audio every run: the device's
// down_frames should be identical across all cycles. A differing frame count
// means synthesis output (or delivery) varied, so fail the run set.
if (realServer && !realTts) {
  const frameSet = new Set(results.map((r) => r.downFrames));
  if (frameSet.size !== 1) {
    console.log(`determinism: FAIL — device down_frames varied across runs (${[...frameSet].join(', ')})`);
    overallPass = false;
  } else {
    console.log(`determinism: PASS — every run reported down_frames=${results[0].downFrames}`);
  }
}
console.log(overallPass ? 'RESULT: PASS' : 'RESULT: FAIL');

// Exit explicitly. Setting exitCode alone is not enough: the serial monitor
// child keeps piping into our stdout, so the event loop never drains and the
// script sits there after printing its verdict — still holding COM3, still
// running its mock on 7445, with secrets.h still repointed. That is where
// every "stale device-test tree" in this repo's history came from; the next
// run then failed with EADDRINUSE or a serial PermissionError and the blame
// landed on the device. cleanup() kills the children and restores the files.
cleanup();
process.exit(overallPass ? 0 : 1);