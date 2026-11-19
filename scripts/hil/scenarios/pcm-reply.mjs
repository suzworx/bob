import { pttCapture, replyPlayed, TURN_TIMEOUT_MS } from './steps.mjs';

// Epic #611: a reply in PCM plays to the end, and MP3 still does after it.
// The mechanism is the device's: hello names format_id, the server keeps it
// for the session (session/handlers/hello.ts) and echoes it in welcome, and
// the device plays in the welcome's format (state_core.cpp negotiatedFormat). The
// product build always asks for MP3 (PCM16 only with -DBOB_PCM16_HELLO), so
// the HIL build has a test-console command for the next hello:
//   T hello pcm|mp3   RAM only (a reboot is MP3 again); journals
//                     hello_format_forced format=<pcm16_16k_mono|mp3_16k_mono>
//                     and reconnects the socket so the next hello uses it.
// The hook is testSetHelloFormat in state_connection.cpp (the hello is built there),
// compiled only with BOB_TEST_CONSOLE. A firmware without it SKIPs.
//
// Each reply must play to its end: replyPlayed(format) (steps.mjs), the same
// wait every turn uses. For PCM16 (streamed since PCM-BUFFER-674) that is
// `playback_completed … format=pcm16` with samples > 0, dropped_bytes=0 and
// seq_gaps=0; for MP3, mp3_exit=eof. `playback_end_received` and READY are no
// proof: they come even when nothing played. On run 20260929-110910-342e the
// old whole-reply PCM buffer (320 KB, then 160 KB of internal RAM) did not fit
// the largest free block (~156 KB): `playback_buffer_failed`, the frames were
// dropped and the reply was silent. That line still fails the scenario at
// once, with itself as the reason.
//
// The forced format outlives the scenario (RAM, not reboot), and the next
// scenario must not run in PCM, so `finally` puts MP3 back even when a step
// failed (engine.mjs runFinally).
const helloIn = (format, id) => [
  { send: `T hello ${format === 'pcm16_16k_mono' ? 'pcm' : 'mp3'}`, expect: /^ok$/ },
  { waitDevice: new RegExp(`INFO v2\\.hello_format_forced .*format=${format}`), timeoutMs: 5000 },
  { waitDevice: new RegExp(`INFO v2\\.hello_sent .*format=${format},`), timeoutMs: 30_000 },
  { waitServer: new RegExp(`"event":"v2\\.welcome".*"format_id":${id}`), timeoutMs: 30_000 },
  { waitDevice: new RegExp(`INFO v2\\.welcome_accepted .*format=${id}`), timeoutMs: 30_000 },
  { assertState: { state: 'READY' }, timeoutMs: 15_000 },
];

/** One push-to-talk turn whose reply must play to the end in `format`. */
const turnIn = (format) => {
  const [id, bytes] = format === 'pcm16' ? [1, 'pcm_bytes'] : [2, 'mp3_bytes'];
  return [
    ...pttCapture(),
    { waitServer: new RegExp(`"event":"v2\\.downlink_started".*"${bytes}":\\d+`), timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: new RegExp(`INFO v2\\.playback_started .*format=${id}`), timeoutMs: TURN_TIMEOUT_MS },
    // Journaled just before playback_started when the buffer does not fit.
    { noDevice: /INFO v2\.playback_buffer_failed /, timeoutMs: 1 },
    { waitServer: /"event":"v2\.turn_completed"/, timeoutMs: TURN_TIMEOUT_MS },
    { waitDevice: replyPlayed(format), timeoutMs: TURN_TIMEOUT_MS },
    { assertState: { state: 'READY' }, timeoutMs: 5000 },
  ];
};

export default {
  name: 'pcm-reply',
  issue: '#611',
  title: 'hello asks for PCM16 → reply plays as PCM to the end → MP3 again → reply plays as MP3',
  expectsReconnect: true,
  requires: [{ event: 'hello_format_forced', feature: 'T hello pcm|mp3 (test console)' }],
  steps: [
    ...helloIn('pcm16_16k_mono', 1),
    ...turnIn('pcm16'),
    ...helloIn('mp3_16k_mono', 2),
    ...turnIn('mp3'),
  ],
  finally: [
    { send: 'T hello mp3', expect: /^ok$/ },
    { waitDevice: /INFO v2\.welcome_accepted .*format=2/, timeoutMs: 30_000 },
    { assertState: { state: 'READY' }, timeoutMs: 15_000 },
  ],
};
