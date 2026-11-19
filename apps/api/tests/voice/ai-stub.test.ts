/**
 * AI-stub flag (BOB_AI_STUB): BOB_AI_STUB=1 enables exactly the AI stubs
 * (canned transcript, deterministic TTS tone, "System test response: <input>"
 * agent reply) WITHOUT the loopback test issuer that BOB_SYSTEM_TEST=1 also
 * turns on. BOB_SYSTEM_TEST=1 keeps its exact prior behaviour. The speech stubs live in the SpeechPort stub adapter (ADR 0002), not in @bob/ai. Runs against
 * the REAL @bob/ai module (no vi.mock), reloading it per test so config.ts
 * re-reads the environment, exactly as provider.test.ts does.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStubSpeech } from '../../src/voice/speech-adapters.ts';

const ENV_KEYS = [
  'BOB_DATABASE_URL',
  'BOB_AI_STUB',
  'BOB_SYSTEM_TEST',
  'BOB_SYSTEM_TEST_TRANSCRIPT',
  'BOB_SYSTEM_TEST_TTS_SECONDS',
  'BOB_SYSTEM_TEST_TTS_WAV',
  'BOB_SYSTEM_TEST_REAL_TTS',
  'SUPABASE_URL',
  'BOB_PRODUCTION',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('BOB_AI_STUB flag', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('BOB_AI_STUB=1 alone stubs STT, agent and TTS', async () => {
    const saved = snapshotEnv();
    try {
      process.env.BOB_AI_STUB = '1';
      delete process.env.BOB_SYSTEM_TEST;
      vi.resetModules();
      const ai = await import('@bob/ai');
      expect(ai.AI_STUB_MODE).toBe(true);
      expect(ai.BOB_SYSTEM_TEST_MODE).toBe(false);

      const stt = await createStubSpeech().transcribeEncoded({ audio: 'aGVsbG8=', format: 'wav' });
      expect(stt.text).toBe('system test transcript');

      const tts = await createStubSpeech().synthesizeEncoded({ text: 'hello', format: 'wav' });
      const audio = Buffer.from(tts.audio, 'base64');
      expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audio.readUInt32LE(24)).toBe(24000);

      const { runAgent } = await import('../../src/voice/turn/agent.ts');
      const result = await runAgent([{ role: 'user', content: 'what time is it?' }] as never);
      expect(result.text).toBe('System test response: what time is it?');
      expect(result.toolCalls).toEqual([]);
    } finally {
      restoreEnv(saved);
    }
  });

  it('BOB_AI_STUB=1 with SUPABASE_URL still resolves the Supabase verifier, not the test issuer', async () => {
    const saved = snapshotEnv();
    try {
      process.env.BOB_AI_STUB = '1';
      delete process.env.BOB_SYSTEM_TEST;
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      vi.resetModules();
      const lines: string[] = [];
      const { setJournalSink } = await import('../../src/platform/logger.ts');
      setJournalSink((line) => lines.push(line));
      try {
        const { resolveWebAuth } = await import('../../src/account/auth.ts');
        const resolved = await resolveWebAuth();
        expect(resolved.testIssuer).toBeNull();
        // The rejecting verifier is only chosen when no issuer is configured;
        // the Supabase branch never journals web_auth_unconfigured.
        expect(lines.some((entry) => entry.includes('v2.web_auth_unconfigured'))).toBe(false);
      } finally {
        setJournalSink(null);
      }
    } finally {
      restoreEnv(saved);
    }
  });

  it('BOB_SYSTEM_TEST=1 still stubs as before and still builds the test issuer', async () => {
    const saved = snapshotEnv();
    try {
      process.env.BOB_SYSTEM_TEST = '1';
      delete process.env.BOB_AI_STUB;
      vi.resetModules();
      const ai = await import('@bob/ai');
      expect(ai.BOB_SYSTEM_TEST_MODE).toBe(true);
      expect(ai.AI_STUB_MODE).toBe(true);

      const stt = await createStubSpeech().transcribeEncoded({ audio: 'aGVsbG8=', format: 'wav' });
      expect(stt.text).toBe('system test transcript');

      const { runAgent } = await import('../../src/voice/turn/agent.ts');
      const result = await runAgent([{ role: 'user', content: 'hi' }] as never);
      expect(result.text).toBe('System test response: hi');

      // The test issuer needs a local database; this test never dials it.
      process.env.BOB_DATABASE_URL = 'postgresql://bob_server@127.0.0.1:1/bob_no_shared_db';
      const { resolveWebAuth } = await import('../../src/account/auth.ts');
      const resolved = await resolveWebAuth();
      expect(resolved.testIssuer).not.toBeNull();
    } finally {
      restoreEnv(saved);
    }
  });
});

/** A RIFF/WAVE PCM16 mono 16 kHz file around `pcm`. */
function wav16k(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('BOB_SYSTEM_TEST_TTS_WAV stub clip', () => {
  it('voices the named 16 kHz WAV, looped to BOB_SYSTEM_TEST_TTS_SECONDS', async () => {
    const saved = snapshotEnv();
    const dir = mkdtempSync(join(process.cwd(), 'ai-stub-wav-'));
    try {
      const clip = Buffer.alloc(3_200); // 0.1 s of 16 kHz mono PCM16
      for (let i = 0; i < clip.length / 2; i += 1) clip.writeInt16LE(((i * 37) % 2000) - 1000, i * 2);
      const wavPath = join(dir, 'hey_bob.wav');
      writeFileSync(wavPath, wav16k(clip));
      process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '1';
      process.env.BOB_SYSTEM_TEST_TTS_WAV = relative(process.cwd(), wavPath).split('\\').join('/');

      const tts = await createStubSpeech().synthesizeEncoded({ text: 'hey bob', format: 'wav' });
      const audio = Buffer.from(tts.audio, 'base64');
      expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(audio.length).toBe(44 + 24_000 * 2);
      // Resampled 16 kHz -> 24 kHz (pitch and speed kept); the second loop starts after one period of 4800 + 14400 bytes.
      const interpolated = (j: number): number => {
        const num = j * 16_000;
        const i = Math.floor(num / 24_000);
        const frac = (num % 24_000) / 24_000;
        const a = clip.readInt16LE(i * 2);
        const b = clip.readInt16LE((i + 1) * 2);
        return Math.round(a + (b - a) * frac);
      };
      const head = Array.from({ length: 8 }, (_, j) => audio.readInt16LE(44 + j * 2));
      expect(head).toEqual(Array.from({ length: 8 }, (_, j) => interpolated(j)));
      expect(audio.readInt16LE(44 + 19_200)).toBe(head[0]);

      // One clip period is round(clipSamples * 1.5) + 7200 samples: 0.4 s holds exactly one period, then silence.
      process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '0.4';
      const period = await createStubSpeech().synthesizeEncoded({ text: 'hey bob', format: 'wav' });
      const one = Buffer.from(period.audio, 'base64');
      expect(one.length).toBe(44 + 2 * (Math.round((clip.length / 2) * 1.5) + 7_200));
      expect(one.subarray(44 + 4_800).every((byte) => byte === 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv(saved);
    }
  });

  it('falls back to the sine when the named WAV does not exist', async () => {
    const saved = snapshotEnv();
    try {
      process.env.BOB_SYSTEM_TEST_TTS_SECONDS = '1';
      delete process.env.BOB_SYSTEM_TEST_TTS_WAV;
      const sine = await createStubSpeech().synthesizeEncoded({ text: 'hey bob', format: 'wav' });
      process.env.BOB_SYSTEM_TEST_TTS_WAV = 'no/such/clip.wav';
      const missing = await createStubSpeech().synthesizeEncoded({ text: 'hey bob', format: 'wav' });
      expect(missing.audio).toBe(sine.audio);
    } finally {
      restoreEnv(saved);
    }
  });
});