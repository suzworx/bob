// End of turn from the streaming STT hypothesis and trailing silence (#1365, PR3-EOT).
// Synthetic PCM16LE 16 kHz mono: a 300 Hz sine is voiced, zeros are silence.
import { describe, expect, it } from 'vitest';
import {
  EOT_STABLE_MS,
  EOT_TRAILING_SILENCE_MS,
  createEndOfTurnDetector,
  endOfTurnSource,
  endsUtterance,
  normaliseTranscript,
  type EndOfTurnDetector,
} from '../../src/voice/turn/end-of-turn.ts';

const FRAME_BYTES = 320; // 10 ms of PCM16LE at 16 kHz
const QUESTION = 'What time is it?';
const CHANGED = 'What time is it? Tell me.';

type Fired = 'end' | 'resume' | null;

/** `ms` of a 300 Hz sine at `amp` (0 = silence), as PCM16LE bytes. */
function pcm(ms: number, amp: number): Buffer {
  const samples = (ms * 16_000) / 1000;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = amp === 0 ? 0 : Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / 16_000));
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

/** Feeds `bytes` one 10 ms frame per call and returns each call's event. */
function feedFrames(d: EndOfTurnDetector, bytes: Buffer, hypothesis: string): Fired[] {
  const events: Fired[] = [];
  for (let at = 0; at < bytes.length; at += FRAME_BYTES) {
    events.push(d.observe(bytes.subarray(at, at + FRAME_BYTES), hypothesis));
  }
  return events;
}

describe('end of turn: the server decides the user has finished', () => {
  it('fires end on the frame where silence reaches 300 ms with a stable question', () => {
    const d = createEndOfTurnDetector();
    expect(feedFrames(d, pcm(500, 3000), QUESTION).every((e) => e === null)).toBe(true);
    const silent = feedFrames(d, pcm(400, 0), QUESTION);
    expect(silent.indexOf('end')).toBe(EOT_TRAILING_SILENCE_MS / 10 - 1);
    expect(silent.filter((e) => e === 'end')).toHaveLength(1);
    expect(d.silenceMs).toBe(400);
    expect(d.audioMs).toBe(900);
  });

  it('never ends on a hypothesis without terminal punctuation', () => {
    const d = createEndOfTurnDetector();
    const events = [
      ...feedFrames(d, pcm(500, 3000), 'What time is it'),
      ...feedFrames(d, pcm(1000, 0), 'What time is it'),
    ];
    expect(events.every((e) => e === null)).toBe(true);
  });

  it('does not end after 250 ms of silence', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    expect(feedFrames(d, pcm(250, 0), QUESTION).every((e) => e === null)).toBe(true);
  });

  it('waits for the hypothesis to be stable for 200 ms of audio after a change', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    feedFrames(d, pcm(200, 0), QUESTION);
    // The text changes while silence is at 200 ms: by 300 ms of silence only 100 ms are stable.
    expect(feedFrames(d, pcm(100, 0), CHANGED).every((e) => e === null)).toBe(true);
    // The first 100 ms banked 100 ms of stability; the next 100 ms reach EOT_STABLE_MS (frame 10 of the block).
    expect(feedFrames(d, pcm(100, 0), CHANGED).indexOf('end')).toBe(9);
  });

  it('resumes when the hypothesis changes after an end, then ends again', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    expect(feedFrames(d, pcm(300, 0), QUESTION).filter((e) => e === 'end')).toHaveLength(1);
    const after = feedFrames(d, pcm(300, 0), CHANGED);
    expect(after[0]).toBe('resume');
    expect(after.indexOf('end')).toBe(EOT_STABLE_MS / 10 - 1);
    expect(after.filter((e) => e === 'end')).toHaveLength(1);
  });

  it('a cosmetic revision after an end (case, punctuation) does not resume', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    expect(feedFrames(d, pcm(300, 0), QUESTION).filter((e) => e === 'end')).toHaveLength(1);
    expect(feedFrames(d, pcm(10, 0), 'what time is it.')).toEqual([null]);
    // Still ended: the same words never end the turn a second time.
    expect(feedFrames(d, pcm(300, 0), 'what time is it.').every((e) => e === null)).toBe(true);
  });

  it('a revision that adds words after an end resumes', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    feedFrames(d, pcm(300, 0), QUESTION);
    expect(feedFrames(d, pcm(10, 0), 'What time is it in Paris?')).toEqual(['resume']);
  });

  it('a loud click does not hide normal speech for the rest of the turn', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(10, 30000), QUESTION);
    expect(feedFrames(d, pcm(500, 1500), QUESTION).filter((e) => e === 'end')).toHaveLength(0);
    expect(feedFrames(d, pcm(300, 0), QUESTION).filter((e) => e === 'end')).toHaveLength(1);
  });

  it('resumes on three voiced frames after an end, not on one', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 3000), QUESTION);
    feedFrames(d, pcm(300, 0), QUESTION);
    expect(feedFrames(d, pcm(10, 3000), QUESTION)).toEqual([null]);
    expect(feedFrames(d, pcm(10, 0), QUESTION)).toEqual([null]);
    expect(feedFrames(d, pcm(30, 3000), QUESTION)).toEqual([null, null, 'resume']);
  });

  it('still ends for a quiet mic at amplitude 300', () => {
    const d = createEndOfTurnDetector();
    feedFrames(d, pcm(500, 300), QUESTION);
    expect(feedFrames(d, pcm(300, 0), QUESTION).filter((e) => e === 'end')).toHaveLength(1);
  });

  it('gives the same result when the payload is split mid-frame', () => {
    const all = Buffer.concat([pcm(500, 3000), pcm(300, 0)]);
    const whole = createEndOfTurnDetector();
    const split = createEndOfTurnDetector();
    const wholeEvents = feedFrames(whole, all, QUESTION);
    const splitEvents: Fired[] = [];
    for (let at = 0; at < all.length; at += 500) splitEvents.push(split.observe(all.subarray(at, at + 500), QUESTION));
    expect(splitEvents.filter(Boolean)).toEqual(wholeEvents.filter(Boolean));
    expect([split.audioMs, split.silenceMs]).toEqual([whole.audioMs, whole.silenceMs]);
  });
});

describe('endsUtterance and normaliseTranscript', () => {
  it('reads terminal punctuation, ignoring closing quotes and brackets', () => {
    for (const text of ['ok.', 'really?', '"yes!"', '你好。']) expect(endsUtterance(text)).toBe(true);
    expect(endsUtterance('no')).toBe(false);
  });

  it('compares transcripts case, punctuation and spacing insensitively', () => {
    expect(normaliseTranscript('What time is it?')).toBe(normaliseTranscript('what time  is it'));
  });
});

describe('endOfTurnSource: which side closed capture', () => {
  const SENT = 1_000;
  const SILENT_AFTER_SPEECH = { source: 'wake', endReason: 'silence', speechEndMs: 500, captureEndMs: 935 };
  const LONG_SILENCE = { ...SILENT_AFTER_SPEECH, captureEndMs: 1510 };
  const cases: Array<[string, Parameters<typeof endOfTurnSource>[0], ReturnType<typeof endOfTurnSource>]> = [
    ['a push-to-talk turn is the device, even with a short gap',
      { sentAt: SENT, turnEndAt: SENT + 135, timing: { ...SILENT_AFTER_SPEECH, source: 'ptt' } }, { eot_source: 'device', eot_basis: 'device' }],
    ['silence 435 ms after speech, sent before turn_end: server (device basis)',
      { sentAt: SENT, turnEndAt: SENT + 135, timing: SILENT_AFTER_SPEECH }, { eot_source: 'server', eot_basis: 'device' }],
    ['silence 1010 ms after speech: the device endpointer (device basis)',
      { sentAt: SENT, turnEndAt: SENT + 135, timing: LONG_SILENCE }, { eot_source: 'device', eot_basis: 'device' }],
    ['not sent: device (device basis)',
      { turnEndAt: SENT + 135, timing: SILENT_AFTER_SPEECH }, { eot_source: 'device', eot_basis: 'device' }],
    ['turn_end 150 ms after the send: server (order basis)',
      { sentAt: SENT, turnEndAt: SENT + 150 }, { eot_source: 'server', eot_basis: 'order' }],
    ['turn_end 700 ms after the send: device (order basis)',
      { sentAt: SENT, turnEndAt: SENT + 700 }, { eot_source: 'device', eot_basis: 'order' }],
    ['turn_end before the send: device (order basis)',
      { sentAt: SENT, turnEndAt: SENT - 50 }, { eot_source: 'device', eot_basis: 'order' }],
    ['no evidence: device (order basis)', {}, { eot_source: 'device', eot_basis: 'order' }],
  ];
  it.each(cases)('%s', (_name, evidence, expected) => {
    expect(endOfTurnSource(evidence)).toEqual(expected);
  });
});
