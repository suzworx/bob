/**
 * SpeechPort (ADR 0002, #627): the provider adapter, the stub adapter and the
 * adapter selection that replaced the stub checks in the call path. Plain
 * fakes only; nothing here reaches a provider.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PCM16_16K_MONO_RATE_HZ } from '../../src/voice/protocol.ts';
import { createProviderSpeech, createStubSpeech, selectSpeech, speechConfigFromEnv, speechTurnFns } from '../../src/voice/speech-adapters.ts';
import type { SpeechPort, SpeechProviderFns } from '../../src/voice/speech-port.ts';
import { createPcm16Wav } from '../../src/voice/audio/wav.ts';

const ENV_KEYS = ['BOB_SYSTEM_TEST_TRANSCRIPT', 'BOB_SYSTEM_TEST_TTS_SECONDS'] as const;
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

/** A speech port that records which method was called and returns marker values. */
function markerPort(name: string, calls: string[]): SpeechPort {
  return {
    transcribe: () => { calls.push(`${name}.transcribe`); return Promise.resolve({ text: name }); },
    synthesizePcm: () => { calls.push(`${name}.pcm`); return Promise.resolve({ pcm: Buffer.alloc(2), sourceRateHz: 16_000 }); },
    synthesizeMp3: () => { calls.push(`${name}.mp3`); return Promise.resolve({ mp3: Buffer.alloc(1) }); },
    transcribeEncoded: () => { calls.push(`${name}.stt-web`); return Promise.resolve({ text: name, model: name }); },
    synthesizeEncoded: () => { calls.push(`${name}.tts-web`); return Promise.resolve({ audio: '', format: 'mp3', contentType: 'audio/mpeg' }); },
  };
}

describe('speechConfigFromEnv', () => {
  it('stubs nothing when AI stub mode is off', () => {
    expect(speechConfigFromEnv(false, {})).toEqual({ stubStt: false, stubTts: false });
  });

  it('stubs STT and TTS in AI stub mode', () => {
    expect(speechConfigFromEnv(true, {})).toEqual({ stubStt: true, stubTts: true });
  });

  it('keeps TTS real under BOB_SYSTEM_TEST_REAL_TTS=1 while STT stays stubbed', () => {
    expect(speechConfigFromEnv(true, { BOB_SYSTEM_TEST_REAL_TTS: '1' })).toEqual({ stubStt: true, stubTts: false });
  });
});

describe('selectSpeech', () => {
  it('routes every call to the real adapter when nothing is stubbed', async () => {
    const calls: string[] = [];
    const speech = selectSpeech({ stubStt: false, stubTts: false }, markerPort('real', calls));
    await speech.transcribe(Buffer.alloc(2));
    await speech.synthesizePcm('hi');
    await speech.synthesizeMp3('hi');
    expect(calls).toEqual(['real.transcribe', 'real.pcm', 'real.mp3']);
  });

  it('never touches the real adapter when everything is stubbed', async () => {
    const calls: string[] = [];
    const speech = selectSpeech({ stubStt: true, stubTts: true }, markerPort('real', calls));
    expect((await speech.transcribe(Buffer.alloc(2))).text).toBe('system test transcript');
    expect((await speech.synthesizePcm('hi')).pcm.length).toBeGreaterThan(0);
    expect((await speech.synthesizeMp3('hi')).mp3.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('mixes: stub STT with real TTS', async () => {
    const calls: string[] = [];
    const speech = selectSpeech({ stubStt: true, stubTts: false }, markerPort('real', calls));
    expect((await speech.transcribe(Buffer.alloc(2))).model).toBe('system-test-transcriber');
    await speech.synthesizePcm('hi');
    await speech.synthesizeMp3('hi');
    expect(calls).toEqual(['real.pcm', 'real.mp3']);
  });
});

describe('browser voice calls (encoded audio)', () => {
  it('follow the same selection as the device calls', async () => {
    const calls: string[] = [];
    const speech = selectSpeech({ stubStt: true, stubTts: false }, markerPort('real', calls));
    expect((await speech.transcribeEncoded({ audio: 'YQ==', format: 'webm' })).model).toBe('system-test-transcriber');
    await speech.synthesizeEncoded({ text: 'hi', format: 'mp3' });
    expect(calls).toEqual(['real.tts-web']);
  });

  it('stub speech keeps the bytes the @bob/ai stub produced: a tone for WAV, silence for MP3', async () => {
    const speech = createStubSpeech();
    const wav = await speech.synthesizeEncoded({ text: 'hi', format: 'wav' });
    expect(wav).toMatchObject({ format: 'wav', contentType: 'audio/wav', generationId: 'system-test-speech' });
    expect(Buffer.from(wav.audio, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF');
    const mp3 = await speech.synthesizeEncoded({ text: 'hi', format: 'mp3' });
    expect(mp3).toEqual({ audio: Buffer.alloc(44_100).toString('base64'), format: 'mp3', contentType: 'audio/mpeg', generationId: 'system-test-speech' });
  });

  it('the provider adapter passes the input through untouched', async () => {
    const seen: unknown[] = [];
    const speech = createProviderSpeech({
      transcribeAudio: (input) => { seen.push(input); return Promise.resolve({ text: 'x', model: 'm' }); },
      synthesizeSpeech: (input) => { seen.push(input); return Promise.resolve({ audio: '', format: 'mp3', contentType: 'audio/mpeg' }); },
    });
    await speech.transcribeEncoded({ audio: 'YQ==', format: 'webm' });
    await speech.synthesizeEncoded({ text: 'hi', format: 'mp3' });
    expect(seen).toEqual([{ audio: 'YQ==', format: 'webm' }, { text: 'hi', format: 'mp3' }]);
  });
});

describe('stub WAV (moved here from the @bob/ai provider tests)', () => {
  it('is a valid deterministic RIFF/WAVE PCM16 mono 24 kHz file of BOB_SYSTEM_TEST_TTS_SECONDS', async () => {
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '2';
    const speech = createStubSpeech();
    const result = await speech.synthesizeEncoded({ text: 'hello', format: 'wav' });
    const audio = Buffer.from(result.audio, 'base64');
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(audio.readUInt32LE(24)).toBe(24000);
    expect(audio.readUInt16LE(22)).toBe(1);
    expect(audio.readUInt16LE(34)).toBe(16);
    expect(audio.subarray(36, 40).toString('ascii')).toBe('data');
    expect(audio.readUInt32LE(40)).toBe(2 * 24000 * 2);
    expect((await speech.synthesizeEncoded({ text: 'hello', format: 'wav' })).audio).toBe(result.audio);
  });
});

describe('stub adapter', () => {
  it('returns BOB_SYSTEM_TEST_TRANSCRIPT per call, with the stub model name', async () => {
    const speech = createStubSpeech();
    process.env.BOB_SYSTEM_TEST_TRANSCRIPT = 'turn on the lights';
    expect(await speech.transcribe(Buffer.alloc(640))).toEqual({ text: 'turn on the lights', model: 'system-test-transcriber', seconds: undefined });
  });

  it('speaks a 440 Hz tone of BOB_SYSTEM_TEST_TTS_SECONDS, resampled from 24 kHz to 16 kHz', async () => {
    const speech = createStubSpeech();
    process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '2';
    const { pcm, sourceRateHz } = await speech.synthesizePcm('anything');
    expect(sourceRateHz).toBe(24_000);
    expect(pcm.length).toBe(2 * PCM16_16K_MONO_RATE_HZ * 2);
    expect(pcm.some((byte) => byte !== 0)).toBe(true);
  });

  it('defaults to one second and encodes MP3 from the same tone', async () => {
    const speech = createStubSpeech();
    const { pcm } = await speech.synthesizePcm('x');
    expect(pcm.length).toBe(PCM16_16K_MONO_RATE_HZ * 2);
    const { mp3 } = await speech.synthesizeMp3('x');
    // 32 kbps CBR is 4000 B/s, so one second is about 4 kB.
    expect(mp3.length).toBeGreaterThan(3000);
    expect(mp3.length).toBeLessThan(5000);
  });

  it('is deterministic', async () => {
    const speech = createStubSpeech();
    expect((await speech.synthesizePcm('a')).pcm.equals((await speech.synthesizePcm('b')).pcm)).toBe(true);
  });
});

describe('provider adapter', () => {
  it('runs the audio pipeline over the injected provider calls and wraps uplink PCM as WAV', async () => {
    const seen: { format?: string; wavBytes: number }[] = [];
    const tone = createPcm16Wav(Buffer.alloc(PCM16_16K_MONO_RATE_HZ * 2), { sampleRateHz: PCM16_16K_MONO_RATE_HZ, channels: 1 });
    const provider: SpeechProviderFns = {
      transcribeAudio: (input) => {
        seen.push({ format: input.format, wavBytes: Buffer.from(input.audio, 'base64').length });
        return Promise.resolve({ text: 'heard', model: 'fake-stt', generationId: 'g', usage: { seconds: 3 } });
      },
      synthesizeSpeech: () => Promise.resolve({ audio: tone.toString('base64'), format: 'wav', contentType: 'audio/wav' }),
    };
    const speech = createProviderSpeech(provider);
    expect(await speech.transcribe(Buffer.alloc(640))).toEqual({ text: 'heard', model: 'fake-stt', seconds: 3 });
    expect(seen[0]?.format).toBe('wav');
    expect(seen[0]?.wavBytes).toBe(44 + 640);
    const spoken = await speech.synthesizePcm('hello');
    expect(spoken.sourceRateHz).toBe(PCM16_16K_MONO_RATE_HZ);
    expect(spoken.pcm.length).toBe(PCM16_16K_MONO_RATE_HZ * 2);
    expect((await speech.synthesizeMp3('hello')).mp3.length).toBeGreaterThan(0);
  });
});

describe('speechTurnFns', () => {
  it('exposes the adapter as stt / ttsPcm / ttsMp3', async () => {
    const calls: string[] = [];
    const deps = speechTurnFns(markerPort('fake', calls));
    expect((await deps.stt(Buffer.alloc(2))).text).toBe('fake');
    await deps.ttsPcm('a');
    await deps.ttsMp3('a');
    expect(calls).toEqual(['fake.transcribe', 'fake.pcm', 'fake.mp3']);
  });
});
