import { journalMatch } from '../journal-match.mjs';
import { REPLY_PLAYED, TURN_TIMEOUT_MS, loopHealthy, pttCapture } from './steps.mjs';

// MP3-BEGIN-RACE: a reply that is fully buffered before the decoder starts
// must still play. HIL run 20260929-064635-40fc (wake-followup step 22):
//   playback_started -> playback_end_received -> playback_ending frames=17
//   -> mp3_ring_ready avail=16416,eof=1 -> mp3_began ok=0 -> mp3_begin_failed
// finishStream() closed the MP3 source and the decoder's begin() refuses a
// closed source, so the whole reply was dropped. `T server burst_next_reply`
// (server-harness.ts) sends the next reply, the stub agent's one-clause line
// (one TTS clip), and holds every write from playback_start to
// playback_end, then writes them back to back: the device holds the whole
// reply, usually with playback_end, before its decode task reaches begin().
// Three turns, since the device side of the order is a race; mp3_ring_ready's
// avail/eof in the evidence shows which order each turn hit.
const burstTurn = () => [
  { send: 'T server burst_next_reply', expect: /^ok server$/ },
  { waitServer: journalMatch({ event: 'v2.hil_command', command: 'burst_next_reply', outcome: 'armed' }), timeoutMs: 5000 },
  ...pttCapture(),
  { waitServer: journalMatch({ event: 'v2.hil_reply_burst', writes: /^\d+$/ }), timeoutMs: TURN_TIMEOUT_MS },
  { waitDevice: /INFO v2\.playback_started .*format=2/, timeoutMs: TURN_TIMEOUT_MS },
  { waitDevice: /INFO v2\.mp3_ring_ready .*avail=\d+,eof=[01]/, timeoutMs: TURN_TIMEOUT_MS },
  { waitDevice: REPLY_PLAYED, timeoutMs: TURN_TIMEOUT_MS },
  // Since GO was released: the decoder never refused the buffered reply.
  { noDevice: /INFO v2\.mp3_begin_failed /, timeoutMs: 500 },
  { assertState: { state: 'READY' }, timeoutMs: 5000 },
];

export default {
  name: 'reply-burst',
  // Found by #313's wake-followup scenario; unit MP3-BEGIN-RACE.
  issue: '#313',
  title: 'a reply sent in one burst (playback_end before decode starts) plays to mp3_exit=eof',
  steps: [
    { assertState: { state: 'READY', mode: 'ptt' } },
    ...burstTurn(),
    ...burstTurn(),
    ...burstTurn(),
    loopHealthy(),
  ],
};
