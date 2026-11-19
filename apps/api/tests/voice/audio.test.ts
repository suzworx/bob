/**
 * Vitest suite for audio.ts: PCM16 uplink assembly, turn emptiness checks,
 * STT/TTS orchestration through the @bob/ai adapters, and downlink OLX2
 * frame generation. Runs through the root vitest.config.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { synthesizeSpeech, transcribeAudio } from '@bob/ai';
import {
  MAX_REPLY_PIECE_CHARS,
  assemblePcm16,
  createReplySplitter,
  downlinkFrames,
  downlinkMp3Frames,
  isEmptyTurn,
  synthesizeMp3,
  synthesizePcm,
  transcribePcm,
} from '../../src/voice/audio/stt-tts.ts';
import { audioStartOffset, mp3DrainBytesPerSecond, parseMp3Frame } from '../../src/voice/audio/mp3.ts';
import { createPcm16Wav } from '../../src/voice/audio/wav.ts';
import { AUDIO_HEADER_BYTES, DOWNLINK_FRAME_BYTES, DOWNLINK_MP3_CHUNK_BYTES, MAX_DOWNLINK_MP3_BYTES, MP3_16K_MONO_FORMAT, PCM16_16K_MONO_RATE_HZ } from '../../src/voice/protocol.ts';

vi.mock('@bob/ai', async (importOriginal) => {
  // One factory per specifier: vitest keeps only the last vi.mock, so the overrides layer in order over the real barrel.
  type Factory = (orig: typeof importOriginal) => unknown;
  const original = await importOriginal<typeof import('@bob/ai')>();
  const factories: Factory[] = [
    ((() => ({
  // audio.ts records conversion metadata through the debug channel.
  debugLog: vi.fn(),
  // Pinned STT language; 'auto' would restore provider auto-detection.
  BOB_STT_LANGUAGE: 'en',
  transcribeAudio: vi.fn(async () => ({
    text: 'hello',
    model: 'm',
    generationId: 'test-transcription',
    usage: { seconds: 1 },
  })),
  synthesizeSpeech: vi.fn(),
}) ) as Factory),
  ];
  let current: object = { ...original };
  const accumulated = (async () => current) as unknown as typeof importOriginal;
  for (const factory of factories) current = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(current), ...Object.getOwnPropertyDescriptors((await factory(accumulated)) as object) }); // keeps getters live
  return current;
});

/** Feeds `deltas` through a fresh splitter; returns every piece, flush included. */
function splitAll(deltas: string[]): string[] {
  const splitter = createReplySplitter();
  return [...deltas.flatMap((delta) => splitter.push(delta)), ...splitter.flush()];
}

describe('createReplySplitter (#317)', () => {
  it('emits each sentence once its trailing space arrives, in order', () => {
    const splitter = createReplySplitter();
    expect(splitter.push('It is noon')).toEqual([]);
    expect(splitter.push('.')).toEqual([]);
    expect(splitter.push(' Lunch is at one! Any')).toEqual(['It is noon. ', 'Lunch is at one! ']);
    expect(splitter.push('thing else?')).toEqual([]);
    expect(splitter.flush()).toEqual(['Anything else?']);
    expect(splitter.flush()).toEqual([]);
  });

  it('joins back to exactly the reply text, however the deltas fall', () => {
    const reply = 'Sure. It costs $3.50, about 2.5 km away.\nDr. Lee said "yes." Then we left!';
    const oneByOne = splitAll([...reply]);
    expect(oneByOne.join('')).toBe(reply);
    expect(splitAll([reply]).join('')).toBe(reply);
    expect(oneByOne).toEqual(splitAll([reply]));
  });

  it('does not end a sentence at a decimal, an abbreviation or a bare trailing period', () => {
    expect(splitAll(['Pi is 3.14 today. Mr. Smith e.g. agrees. ', 'Done.'])).toEqual([
      'Pi is 3.14 today. ', 'Mr. Smith e.g. agrees. ', 'Done.',
    ]);
    const splitter = createReplySplitter();
    expect(splitter.push('It is 3.')).toEqual([]);
    expect(splitter.push('5 degrees. ')).toEqual(['It is 3.5 degrees. ']);
  });

  it('ends a sentence after closing quotes and brackets, and at a newline', () => {
    expect(splitAll(['He said "go." (Really!) Next\nline'])).toEqual(['He said "go." ', '(Really!) ', 'Next\n', 'line']);
  });

  it('cuts a long piece with no sentence end at a clause, then at a word', () => {
    const clause = `${'word '.repeat(30)}and so, ${'more '.repeat(40)}`;
    const pieces = splitAll([clause]);
    expect(pieces[0]!.endsWith('so, ')).toBe(true);
    expect(pieces.join('')).toBe(clause);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(MAX_REPLY_PIECE_CHARS);
    const words = 'abcdefghi '.repeat(60);
    const wordPieces = splitAll([words]);
    expect(wordPieces.length).toBeGreaterThan(2);
    expect(wordPieces.join('')).toBe(words);
    for (const piece of wordPieces.slice(0, -1)) expect(piece.endsWith(' ')).toBe(true);
  });

  it('returns nothing for an empty reply', () => {
    expect(splitAll([''])).toEqual([]);
  });
});

describe('downlinkMp3Frames firstSequence (#317)', () => {
  it('continues the OLX2 sequence numbers from firstSequence', () => {
    const frames = downlinkMp3Frames(Buffer.alloc(DOWNLINK_MP3_CHUNK_BYTES * 2 + 1), 1, 7);
    expect(frames.map((frame) => frame.readUInt32BE(12))).toEqual([7, 8, 9]);
    expect(downlinkMp3Frames(Buffer.alloc(10)).map((frame) => frame.readUInt32BE(12))).toEqual([0]);
  });
});

describe('assemblePcm16', () => {
  it('concatenates uplink chunks in order, ignoring zero-length chunks', () => {
    const chunks = [Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(0), Buffer.from([0x04])];
    expect(assemblePcm16(chunks)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
  });

  it('returns an empty buffer for no chunks', () => {
    expect(assemblePcm16([])).toEqual(Buffer.alloc(0));
  });
});

describe('isEmptyTurn', () => {
  it('is true only when the accumulated PCM byte count is zero', () => {
    expect(isEmptyTurn([])).toBe(true);
    expect(isEmptyTurn([Buffer.alloc(0)])).toBe(true);
    expect(isEmptyTurn([Buffer.alloc(0), Buffer.alloc(0)])).toBe(true);
    expect(isEmptyTurn([Buffer.alloc(2)])).toBe(false);
    expect(isEmptyTurn([Buffer.alloc(0), Buffer.alloc(4)])).toBe(false);
  });
});

describe('downlinkFrames', () => {
  it('splits downlink PCM into 10 ms audio_down frames with sequential headers', () => {
    const pcm = Buffer.alloc(DOWNLINK_FRAME_BYTES * 2 + 40);
    const frames = downlinkFrames(pcm);
    expect(frames).toHaveLength(3);
    frames.forEach((frame, index) => {
      expect(frame.subarray(0, 4).toString('ascii')).toBe('OLX2');
      expect(frame.readUInt8(4)).toBe(1); // version
      expect(frame.readUInt8(5)).toBe(2); // kind audio_down
      expect(frame.readUInt8(6)).toBe(1); // PCM16 16 kHz mono
      expect(frame.readUInt8(7)).toBe(1); // channels
      expect(frame.readUInt32BE(8)).toBe(1); // default turn handle
      expect(frame.readUInt32BE(12)).toBe(index); // sequence
      const payloadBytes = frame.length - AUDIO_HEADER_BYTES;
      expect(payloadBytes).toBe(index < 2 ? DOWNLINK_FRAME_BYTES : 40);
      expect(frame.readUInt32BE(16)).toBe(payloadBytes);
    });
  });

  it('honors an explicit turn handle', () => {
    const frames = downlinkFrames(Buffer.alloc(DOWNLINK_FRAME_BYTES), 7);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.readUInt32BE(8)).toBe(7);
  });

  it('produces no frames for empty downlink audio', () => {
    expect(downlinkFrames(Buffer.alloc(0))).toEqual([]);
  });
});

describe('transcribePcm', () => {
  it('sends a 44-byte-headered base64 WAV and maps transcript usage fields', async () => {
    const pcm = Buffer.alloc(3200); // 1600 samples of PCM16 at 16 kHz.
    const result = await transcribePcm(pcm);

    expect(vi.mocked(transcribeAudio)).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(transcribeAudio).mock.calls[0]![0]!;
    const wav = Buffer.from(sent.audio, 'base64');
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav).toEqual(createPcm16Wav(pcm, { sampleRateHz: PCM16_16K_MONO_RATE_HZ, channels: 1 }));
    expect(sent.format).toBe('wav');
    // Defect C: with no language the provider auto-detects, and short noisy
    // mic input is misdetected often enough to answer in the wrong language.
    expect(sent.language).toBe('en');

    expect(result).toEqual({ text: 'hello', model: 'm', seconds: 1 });
    expect(result.text).toBe('hello');
    expect(result.model).toBe('m');
    expect(result.seconds).toBe(1);
  });
});

describe('synthesizePcm', () => {
  it('requests wav and resamples from the sample rate in the returned header', async () => {
    const inputSamples = 24_000;
    const wav = createPcm16Wav(Buffer.alloc(inputSamples * 2), { sampleRateHz: 24_000, channels: 1 });
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audio: wav.toString('base64'),
      format: 'wav',
      contentType: 'audio/wav',
      generationId: 'test-speech',
    });

    const result = await synthesizePcm('hello');
    expect(vi.mocked(synthesizeSpeech)).toHaveBeenCalledWith({ text: 'hello', format: 'wav' });
    // The header says 24 kHz, not any configured guess.
    expect(result.sourceRateHz).toBe(24_000);
    expect(result.pcm.length).toBe(Math.floor((inputSamples * PCM16_16K_MONO_RATE_HZ) / 24_000) * 2);
  });

  it('derives a different rate from the returned WAV header', async () => {
    const inputSamples = 8_000;
    const wav = createPcm16Wav(Buffer.alloc(inputSamples * 2), { sampleRateHz: 8_000, channels: 1 });
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audio: wav.toString('base64'),
      format: 'wav',
      contentType: 'audio/wav',
    });

    const result = await synthesizePcm('hello');
    expect(result.sourceRateHz).toBe(8_000);
    expect(result.pcm.length).toBe(Math.floor((inputSamples * PCM16_16K_MONO_RATE_HZ) / 8_000) * 2);
  });
});

function mp3DurationSeconds(buffer: Buffer): number {
  let offset = audioStartOffset(buffer);
  let duration = 0;
  while (offset + 4 <= buffer.length) {
    const frame = parseMp3Frame(buffer, offset);
    if (frame === null || offset + frame.frameLengthBytes > buffer.length) break;
    duration += frame.samplesPerFrame / frame.sampleRateHz;
    offset += frame.frameLengthBytes;
  }
  return duration;
}

describe('synthesizeMp3 timing (#1387)', () => {
  const wav = createPcm16Wav(Buffer.alloc(4_800), { sampleRateHz: 24_000, channels: 1 });
  const speech = { audio: wav.toString('base64'), format: 'wav', contentType: 'audio/wav' };

  it('reports decode_ms and encode_ms, and passes the provider timing through', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({ ...speech, timing: { headers_ms: 410, last_byte_ms: 520, done_ms: 530 } });
    const result = await synthesizeMp3('hello');
    expect(result.timing?.headers_ms).toBe(410);
    expect(result.timing?.last_byte_ms).toBe(520);
    expect(result.timing?.done_ms).toBe(530);
    expect(result.timing?.decode_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing?.encode_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports only decode_ms and encode_ms when the provider gave no timing', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue(speech);
    const result = await synthesizeMp3('hello');
    expect(Object.keys(result.timing ?? {}).sort()).toEqual(['decode_ms', 'encode_ms']);
  });
});

describe('synthesizeMp3', () => {
  it('requests wav and re-encodes 16 kHz mono 32 kbps MPEG-2 Layer III', async () => {
    const inputSamples = 24_000; // 1 s at 24 kHz.
    const sine = new Int16Array(inputSamples);
    for (let index = 0; index < inputSamples; index += 1) {
      sine[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / 24_000) * 10_000);
    }
    const wav = createPcm16Wav(Buffer.from(sine.buffer), { sampleRateHz: 24_000, channels: 1 });
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audio: wav.toString('base64'),
      format: 'wav',
      contentType: 'audio/wav',
      generationId: 'test-speech-mp3',
    });

    const result = await synthesizeMp3('hello');
    expect(vi.mocked(synthesizeSpeech)).toHaveBeenCalledWith({ text: 'hello', format: 'wav' });

    const frame = parseMp3Frame(result.mp3, audioStartOffset(result.mp3));
    expect(frame).not.toBeNull();
    expect(frame!.sampleRateHz).toBe(16_000);
    expect(frame!.bitrateKbps).toBe(32);

    const duration = mp3DurationSeconds(result.mp3);
    expect(duration).toBeGreaterThan(0.9);
    expect(duration).toBeLessThan(1.1);

    expect(mp3DrainBytesPerSecond(result.mp3)).toBe(4000);
  });
});

describe('downlinkMp3Frames', () => {
  it('splits downlink MP3 into audio_down frames with format_id 2', () => {
    const mp3 = Buffer.alloc(DOWNLINK_MP3_CHUNK_BYTES * 2 + 100);
    const frames = downlinkMp3Frames(mp3);
    expect(frames).toHaveLength(3);
    frames.forEach((frame, index) => {
      expect(frame.subarray(0, 4).toString('ascii')).toBe('OLX2');
      expect(frame.readUInt8(4)).toBe(1); // version
      expect(frame.readUInt8(5)).toBe(2); // kind audio_down
      expect(frame.readUInt8(6)).toBe(MP3_16K_MONO_FORMAT); // MP3
      expect(frame.readUInt8(7)).toBe(1); // channels
      expect(frame.readUInt32BE(8)).toBe(1); // default turn handle
      expect(frame.readUInt32BE(12)).toBe(index); // sequence
      const payloadBytes = frame.length - AUDIO_HEADER_BYTES;
      expect(payloadBytes).toBe(index < 2 ? DOWNLINK_MP3_CHUNK_BYTES : 100);
      expect(frame.readUInt32BE(16)).toBe(payloadBytes);
    });
  });

  it('caps MP3 replies at MAX_DOWNLINK_MP3_BYTES', () => {
    const mp3 = Buffer.alloc(MAX_DOWNLINK_MP3_BYTES + 100);
    const frames = downlinkMp3Frames(mp3);
    const totalPayload = frames.reduce((sum, frame) => sum + frame.length - AUDIO_HEADER_BYTES, 0);
    expect(totalPayload).toBe(MAX_DOWNLINK_MP3_BYTES);
  });

  it('produces no frames for empty MP3', () => {
    expect(downlinkMp3Frames(Buffer.alloc(0))).toEqual([]);
  });
});