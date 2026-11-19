/**
 * Records a speech-asset pack (#1000) from a committed source spec of public
 * phrases, with the effective production TTS model and voice:
 *
 *   npx tsx apps/api/scripts/record-speech-pack.ts \
 *     --spec apps/api/scripts/speech-packs/core-en-us.json [--out data/voice-assets]
 *
 * Each clip is one provider call (`synthesizePcm`, already 16 kHz mono), then
 * conditionSpeechClip trims the provider's silence padding and levels it. The
 * build id is the spec name plus a hash of the spec and every clip, so a pack
 * is immutable: re-recording yields a new id and never overwrites one. The
 * manifest comes from scripts/generate-speech-assets.mjs. `audition.wav` holds
 * every clip with a gap, for listening. Audio stays in data/, out of Git.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOB_TTS_MODEL, BOB_TTS_VOICE, refuseProductionKey } from '@bob/ai';
import { conditionSpeechClip, longestPauseMs, SENTENCE_CLIP } from '../src/voice/audio/speech-clip.ts';
import { synthesizePcm } from '../src/voice/audio/stt-tts.ts';
import { createPcm16Wav } from '../src/voice/audio/wav.ts';

interface SourceSpec {
  name: string;
  model: string;
  voice: string;
  locale: string;
  clips: { id: string; say: string }[];
  templates: unknown[];
}

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? fallback : process.argv[at + 1];
  if (value === undefined) throw new Error(`usage: record-speech-pack.ts --spec <spec.json> [--out <dir>]; missing --${name}`);
  return value;
}

function refuseUnrealProvider(spec: SourceSpec): void {
  if ((process.env.AI_GATEWAY_API_KEY ?? '') === '') throw new Error('AI_GATEWAY_API_KEY is required: a pack is recorded with the real voice');
  if (process.env.BOB_SYSTEM_TEST === '1' || process.env.BOB_AI_STUB === '1') throw new Error('Stub speech must never be recorded into a pack');
  refuseProductionKey();
  if (spec.model !== BOB_TTS_MODEL || spec.voice !== BOB_TTS_VOICE) {
    throw new Error(`Spec voice ${spec.model}/${spec.voice} is not the effective ${BOB_TTS_MODEL}/${BOB_TTS_VOICE}`);
  }
}

/** A provider take pausing longer than this inside one clip (or trailing a stray sound) is retaken. */
const MAX_PAUSE_MS = 700;
const MAX_TAKES = 5;

async function recordClip(say: string): Promise<Buffer> {
  let longest = 0;
  for (let take = 1; take <= MAX_TAKES; take++) {
    try {
      const pcm = conditionSpeechClip((await synthesizePcm(say)).pcm, SENTENCE_CLIP);
      longest = longestPauseMs(pcm);
      if (longest <= MAX_PAUSE_MS) return pcm;
    } catch (error) {
      if (take >= MAX_TAKES) throw error;
    }
  }
  throw new Error(`No take of "${say}" kept its pauses under ${MAX_PAUSE_MS} ms (last ${longest} ms)`);
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function main(): Promise<void> {
  const specPath = resolve(arg('spec'));
  const outRoot = resolve(repoRoot, arg('out', 'data/voice-assets'));
  const specText = await fs.readFile(specPath, 'utf8');
  const spec = JSON.parse(specText) as SourceSpec;
  // Hash the parsed spec, so line endings or formatting never change a build id.
  const specHash = sha256(JSON.stringify(spec));
  refuseUnrealProvider(spec);
  for (const clip of spec.clips) if (!CLIP_ID.test(clip.id)) throw new Error(`clip id is not valid: ${clip.id}`);
  const staging = join(outRoot, `.recording-${process.pid}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    await recordInto(spec, specHash, staging, outRoot);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function recordInto(spec: SourceSpec, specHash: string, staging: string, outRoot: string): Promise<void> {
  const hashes: { id: string; sha256: string }[] = [];
  const audition: Buffer[] = [];
  const gap = Buffer.alloc(16_000); // 500 ms
  for (const clip of spec.clips) {
    const pcm = await recordClip(clip.say);
    await fs.writeFile(join(staging, `${clip.id}.pcm`), pcm);
    hashes.push({ id: clip.id, sha256: sha256(pcm) });
    audition.push(pcm, gap);
    console.log(`recorded ${clip.id} ${Math.round(pcm.length / 32)} ms`);
  }
  const buildVersion = `${spec.name}-${sha256(JSON.stringify({ spec: specHash, hashes })).slice(0, 12)}`;
  const packDir = join(outRoot, buildVersion);
  if (await fs.stat(packDir).then(() => true, () => false)) throw new Error(`${buildVersion} already exists; packs are immutable`);
  // Everything is finished in staging, so a failure never leaves a half pack under a build id.
  await fs.writeFile(join(staging, 'audition.wav'), createPcm16Wav(Buffer.concat(audition), { sampleRateHz: 16_000, channels: 1 }));
  const generatorSpec = {
    buildVersion, model: spec.model, voice: spec.voice, locale: spec.locale,
    clips: spec.clips.map((clip) => ({ id: clip.id, file: `${clip.id}.pcm` })), templates: spec.templates,
  };
  await fs.writeFile(join(staging, 'spec.json'), `${JSON.stringify(generatorSpec, null, 2)}\n`);
  const generated = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'generate-speech-assets.mjs'), '--dir', staging, '--spec', join(staging, 'spec.json'), '--write'], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`manifest generation failed: ${generated.stderr}`);
  const manifest = await fs.readFile(join(staging, 'manifest.json'));
  const record = {
    buildVersion, model: spec.model, voice: spec.voice, locale: spec.locale, sourceSpecSha256: specHash,
    manifestSha256: sha256(manifest), clips: hashes.length, recordedAt: new Date().toISOString(), shape: SENTENCE_CLIP,
  };
  await fs.writeFile(join(staging, 'pack.json'), `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(staging, packDir);
  console.log(generated.stdout.trim());
  console.log(`BOB_SPEECH_ASSETS_DIR=${packDir}\nBOB_SPEECH_ASSETS_BUILD=${buildVersion}\nmanifest sha256 ${record.manifestSha256}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
