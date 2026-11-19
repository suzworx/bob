import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttsVoiceFor } from '@bob/ai';
import { createSpeechAssetCatalogue, speechAssetsOptionsFromEnv, withSpeechAssets, withSpeechAssetsFromEnv, type SpeechAssetIdentity } from '../../src/voice/speech-assets.ts';
import type { SpeechAssetManifest } from '../../src/voice/speech-assets-manifest.ts';
import type { SpeechPort } from '../../src/voice/speech-port.ts';
import { audioStartOffset, parseMp3Frame } from '../../src/voice/audio/mp3.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

const identity: SpeechAssetIdentity = { buildVersion: 'reviewed-1', model: 'model-1', voice: 'voice-1', locale: 'en-US' };
const lead = Buffer.alloc(3_200, 3);
const five = Buffer.alloc(6_400, 5);
const ten = Buffer.alloc(6_400, 10);
const dirs: string[] = [];

function clip(id: string, bytes: Buffer, path = `${id}.pcm`): SpeechAssetManifest['clips'][number] {
  return { id, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    durationMs: Math.round(bytes.length / 32), sampleRateHz: 16_000 };
}

const template: SpeechAssetManifest['templates'][number] = {
  id: 'timer',
  segments: [
    { type: 'literal', text: 'Timer set for ', clipId: 'lead' },
    { type: 'slot', values: [{ text: 'five minutes.', clipId: 'five' }, { text: 'ten minutes.', clipId: 'ten' }] },
  ],
};

async function pack(changes: Partial<SpeechAssetManifest> = {}, files: Record<string, Buffer> = {
  'lead.pcm': lead, 'five.pcm': five, 'ten.pcm': ten,
}): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bob-templates-'));
  dirs.push(dir);
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(join(dir, name), bytes);
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, ...identity, clips: [clip('lead', lead), clip('five', five), clip('ten', ten)],
    templates: [template], ...changes,
  }));
  return dir;
}

function fake(calls: string[]): SpeechPort {
  return {
    transcribe: async () => ({ text: 'heard' }),
    transcribeEncoded: async () => ({ text: 'heard', model: 'fake' }),
    synthesizeEncoded: async () => ({ audio: 'AA==', format: 'mp3', contentType: 'audio/mpeg' }),
    synthesizePcm: async (text) => { calls.push(`pcm:${text}`); return { pcm: Buffer.from([8, 8]), sourceRateHz: 16_000 }; },
    synthesizeMp3: async (text) => { calls.push(`mp3:${text}`); return { mp3: Buffer.from([1, 2, 3]) }; },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setJournalSink(null);
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('speech templates', () => {
  it('reads a nested clip inside the pack and refuses a directory link outside it', async () => {
    const dir = await pack({ clips: [clip('lead', lead), clip('five', five, 'nested/five.pcm'), clip('ten', ten)] }, {
      'lead.pcm': lead, 'ten.pcm': ten,
    });
    await fs.mkdir(join(dir, 'nested'));
    await fs.writeFile(join(dir, 'nested', 'five.pcm'), five);
    const catalogue = await createSpeechAssetCatalogue({ directory: dir, identity });
    expect(await catalogue.resolve('Timer set for five minutes.')).toEqual(Buffer.concat([lead, five]));

    const outside = await fs.mkdtemp(join(tmpdir(), 'bob-outside-'));
    dirs.push(outside);
    await fs.writeFile(join(outside, 'five.pcm'), five);
    await fs.rm(join(dir, 'nested'), { recursive: true });
    await fs.symlink(outside, join(dir, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    const fresh = await createSpeechAssetCatalogue({ directory: dir, identity });
    expect(await fresh.resolve('Timer set for five minutes.')).toBeUndefined();
  });

  it('assembles exactly matched phrase and slot clips, then encodes one valid MP3 stream', async () => {
    const catalogue = await createSpeechAssetCatalogue({ directory: await pack(), identity });
    const calls: string[] = [];
    const port = withSpeechAssets(fake(calls), catalogue);
    expect(catalogue.status()).toMatchObject({ ready: true, responses: 2 });
    expect((await port.synthesizePcm('Timer set for five minutes.')).pcm).toEqual(Buffer.concat([lead, five]));
    expect((await port.synthesizePcm('Timer set for ten minutes.')).pcm).toEqual(Buffer.concat([lead, ten]));
    const mp3 = (await port.synthesizeMp3('Timer set for five minutes.')).mp3;
    let offset = audioStartOffset(mp3);
    let frames = 0;
    while (offset < mp3.length) {
      const frame = parseMp3Frame(mp3, offset);
      expect(frame).not.toBeNull();
      if (frame === null) break;
      expect(frame.sampleRateHz).toBe(16_000);
      expect(frame.bitrateKbps).toBe(32);
      offset += frame.frameLengthBytes;
      frames += 1;
    }
    expect(offset).toBe(mp3.length);
    expect(frames).toBeGreaterThan(1);
    expect(calls).toEqual([]);
  });

  it('serves a pack only in its own voice: another voice falls back to ordinary TTS in that voice', async () => {
    const calls: string[] = [];
    const inner = fake(calls);
    const port = withSpeechAssets({
      ...inner,
      synthesizePcm: async (text, voice) => { calls.push(`pcm:${text}:${voice}`); return { pcm: Buffer.from([8, 8]), sourceRateHz: 16_000 }; },
      synthesizeMp3: async (text, voice) => { calls.push(`mp3:${text}:${voice}`); return { mp3: Buffer.from([1, 2, 3]) }; },
    }, await createSpeechAssetCatalogue({ directory: await pack(), identity }));
    expect((await port.synthesizePcm('Timer set for five minutes.', identity.voice)).pcm).toEqual(Buffer.concat([lead, five]));
    expect((await port.synthesizePcm('Timer set for five minutes.')).pcm).toEqual(Buffer.concat([lead, five]));
    await port.synthesizePcm('Timer set for five minutes.', 'en-US-Sage');
    await port.synthesizeMp3('Timer set for five minutes.', 'en-US-Sage');
    expect(calls).toEqual(['pcm:Timer set for five minutes.:en-US-Sage', 'mp3:Timer set for five minutes.:en-US-Sage']);
  });

  it('a Bob turn against a Harper pack never plays a Harper clip: it falls back to provider TTS in Bob\'s voice', async () => {
    const harper = { ...identity, voice: 'en-US-Harper' };
    const calls: string[] = [];
    const inner = fake(calls);
    const port = withSpeechAssets({
      ...inner,
      synthesizeMp3: async (text, voice) => { calls.push(`mp3:${text}:${voice}`); return { mp3: Buffer.from([1, 2, 3]) }; },
    }, await createSpeechAssetCatalogue({ directory: await pack({ voice: 'en-US-Harper' }), identity: harper }));
    const bob = ttsVoiceFor('Bob');
    expect(bob).not.toBe('en-US-Harper');
    expect((await port.synthesizeMp3('Timer set for five minutes.', bob)).mp3).toEqual(Buffer.from([1, 2, 3]));
    expect(calls).toEqual([`mp3:Timer set for five minutes.:${bob}`]);
    await port.synthesizeMp3('Timer set for five minutes.', 'en-US-Harper');
    expect(calls).toHaveLength(1);
  });

  it('loads a Bob-voice pack beside a different default voice: Bob turns hit, default-voice turns fall back (#1006)', async () => {
    const bob = ttsVoiceFor('Bob');
    expect(bob).not.toBe(identity.voice);
    const env = (dir: string): NodeJS.ProcessEnv => ({ BOB_SPEECH_ASSETS_DIR: dir, BOB_SPEECH_ASSETS_BUILD: identity.buildVersion,
      BOB_TTS_MODEL: identity.model, BOB_TTS_VOICE: identity.voice, BOB_SPEECH_ASSETS_LOCALE: identity.locale });
    const calls: string[] = [];
    const port = withSpeechAssetsFromEnv(fake(calls), env(await pack({ voice: bob })));
    expect((await port.synthesizePcm('Timer set for five minutes.', bob)).pcm).toEqual(Buffer.concat([lead, five]));
    expect(calls).toEqual([]);
    await port.synthesizePcm('Timer set for five minutes.');
    await port.synthesizePcm('Timer set for five minutes.', identity.voice);
    expect(calls).toHaveLength(2);

    const unknown = speechAssetsOptionsFromEnv(env(await pack({ voice: 'en-US-Unknown' })));
    expect(unknown).toBeDefined();
    if (unknown !== undefined) expect((await createSpeechAssetCatalogue(unknown)).ready).toBe(false);
  });

  it('uses ordinary TTS for all unmatched text and passes STT and browser speech through', async () => {
    const calls: string[] = [];
    const port = withSpeechAssets(fake(calls), await createSpeechAssetCatalogue({ directory: await pack(), identity }));
    await port.synthesizePcm('timer set for five minutes.');
    await port.synthesizeMp3('Timer set for five minutes');
    expect(calls).toEqual(['pcm:timer set for five minutes.', 'mp3:Timer set for five minutes']);
    expect((await port.transcribe(Buffer.from([1]))).text).toBe('heard');
    expect((await port.synthesizeEncoded({ text: 'Timer set for five minutes.' })).format).toBe('mp3');
  });

  it('rejects an identity mismatch or ambiguous template without blocking fallback', async () => {
    const dir = await pack();
    const mismatched = await createSpeechAssetCatalogue({ directory: dir, identity: { ...identity, voice: 'other-voice' } });
    expect(mismatched.ready).toBe(false);
    expect(await mismatched.resolve('Timer set for five minutes.')).toBeUndefined();
    const duplicate = await pack({ templates: [template, { ...template, id: 'duplicate' }] });
    const ambiguous = await createSpeechAssetCatalogue({ directory: duplicate, identity });
    expect(ambiguous.ready).toBe(false);
  });

  it('falls back for missing, corrupt, oversized, and escaped clips with no partial audio', async () => {
    const variants: Array<{ changes?: Partial<SpeechAssetManifest>; files?: Record<string, Buffer> }> = [
      { files: { 'lead.pcm': lead, 'ten.pcm': ten } },
      { files: { 'lead.pcm': lead, 'five.pcm': Buffer.alloc(five.length, 1), 'ten.pcm': ten } },
      { changes: { clips: [clip('lead', lead), { ...clip('five', five), bytes: 330_000 }, clip('ten', ten)] } },
      { changes: { clips: [clip('lead', lead), { ...clip('five', five), path: '../outside.pcm' }, clip('ten', ten)] } },
    ];
    for (const variant of variants) {
      const dir = await pack(variant.changes, variant.files);
      const calls: string[] = [];
      const port = withSpeechAssets(fake(calls), await createSpeechAssetCatalogue({ directory: dir, identity }));
      expect((await port.synthesizePcm('Timer set for five minutes.')).pcm).toEqual(Buffer.from([8, 8]));
      expect(calls).toEqual(['pcm:Timer set for five minutes.']);
    }
  });

  it('returns private buffers and evicts verified clips by byte limit', async () => {
    const catalogue = await createSpeechAssetCatalogue({ directory: await pack(), identity, cacheMaxBytes: 10_000 });
    const first = await catalogue.resolve('Timer set for five minutes.');
    first?.fill(9);
    expect(await catalogue.resolve('Timer set for five minutes.')).toEqual(Buffer.concat([lead, five]));
    expect(catalogue.status().cachedBytes).toBeLessThanOrEqual(10_000);
  });

  it('rejects packs with too many exact response combinations', async () => {
    const values = Array.from({ length: 17 }, (_, n) => ({ text: ` ${n}`, clipId: 'five' }));
    const oversized: SpeechAssetManifest['templates'][number] = {
      id: 'explosion', segments: [{ type: 'slot', values }, { type: 'slot', values }],
    };
    const catalogue = await createSpeechAssetCatalogue({ directory: await pack({ templates: [oversized] }), identity });
    expect(catalogue.ready).toBe(false);
  });

  it('stays disabled without a directory and falls back on a bad pack', async () => {
    expect(speechAssetsOptionsFromEnv({})).toBeUndefined();
    const calls: string[] = [];
    const base = fake(calls);
    expect(withSpeechAssetsFromEnv(base, {})).toBe(base);
    const dir = await pack();
    const enabled = withSpeechAssetsFromEnv(base, { BOB_SPEECH_ASSETS_DIR: dir, BOB_SPEECH_ASSETS_BUILD: identity.buildVersion });
    expect(await enabled.synthesizePcm('unmatched text')).toEqual({ pcm: Buffer.from([8, 8]), sourceRateHz: 16_000 });
    expect(calls).toEqual(['pcm:unmatched text']);
    const hitCalls: string[] = [];
    const hitPort = withSpeechAssetsFromEnv(fake(hitCalls), {
      BOB_SPEECH_ASSETS_DIR: await pack(),
      BOB_SPEECH_ASSETS_BUILD: identity.buildVersion,
      BOB_TTS_MODEL: identity.model,
      BOB_TTS_VOICE: identity.voice,
      BOB_SPEECH_ASSETS_LOCALE: identity.locale,
    });
    expect((await hitPort.synthesizePcm('Timer set for five minutes.')).pcm).toEqual(Buffer.concat([lead, five]));
    expect(hitCalls).toEqual([]);
  });

  it('journals the loaded response and cache counts for an env-enabled hit', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    const port = withSpeechAssetsFromEnv(fake([]), {
      BOB_SPEECH_ASSETS_DIR: await pack(),
      BOB_SPEECH_ASSETS_BUILD: identity.buildVersion,
      BOB_TTS_MODEL: identity.model,
      BOB_TTS_VOICE: identity.voice,
      BOB_SPEECH_ASSETS_LOCALE: identity.locale,
    });
    await port.synthesizePcm('Timer set for five minutes.');
    const hits = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'v2.speech_asset_hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'pcm', responses: 2, cached_entries: 2 });
  });

  it('matches typographic apostrophes and spacing the agent varies but never speaks differently', async () => {
    const curly: SpeechAssetManifest['templates'][number] = {
      id: 'set', segments: [{ type: 'literal', text: "I've set it.", clipId: 'lead' }],
    };
    const catalogue = await createSpeechAssetCatalogue({ directory: await pack({ templates: [curly] }), identity });
    expect(await catalogue.resolve('I’ve set it.')).toEqual(lead);
    expect(await catalogue.resolve(" I've  set it. ")).toEqual(lead);
    expect(await catalogue.resolve("I've set it")).toBeUndefined();
  });

  it('refuses a pack whose responses differ only by apostrophe style', async () => {
    const twins: SpeechAssetManifest['templates'][number] = {
      id: 'twins', segments: [{ type: 'slot', values: [
        { text: "I've set it.", clipId: 'lead' }, { text: 'I’ve set it.', clipId: 'five' },
      ] }],
    };
    const catalogue = await createSpeechAssetCatalogue({ directory: await pack({ templates: [twins] }), identity });
    expect(catalogue.ready).toBe(false);
  });
});
