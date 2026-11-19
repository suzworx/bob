/** Verified PCM phrase-and-slot assembly in front of ordinary Core speech. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BOB_TTS_MODEL, BOB_TTS_VOICE, recordObservationMetrics, traceSpan, ttsVoiceFor } from '@bob/ai';
import { moduleJournal } from '../platform/logger.ts';
import { encodePcmMp3 } from './audio/stt-tts.ts';
import { SpeechAssetManifestSchema, type SpeechAssetClip } from './speech-assets-manifest.ts';
import { fetchSpeechPack, SpeechPackFetchError } from './speech-assets-remote.ts';
import type { SpeechPort } from './speech-port.ts';

const journal = moduleJournal('voice');

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ASSEMBLED_BYTES = 320 * 1024;
const MAX_RESPONSES = 256;
const DEFAULT_CACHE_BYTES = 4 * 1024 * 1024;

export interface SpeechAssetIdentity {
  buildVersion: string;
  model: string;
  /** The default voice: what a request without a voice speaks in. */
  voice: string;
  locale: string;
  /** Every voice the server can request (the default and each persona's); a pack in any of them loads. Default [voice]. */
  voices?: readonly string[];
}

export interface SpeechAssetCatalogueOptions {
  directory: string;
  identity: SpeechAssetIdentity;
  cacheMaxBytes?: number;
}

export interface SpeechAssetCatalogue {
  readonly ready: boolean;
  /** An exact response match returns a private PCM copy; any bad clip is a miss. A pack is
   *  single-voice: a `voice` other than the pack's misses (omitted means the identity's default voice). */
  resolve(text: string, voice?: string): Promise<Buffer | undefined>;
  status(): SpeechAssetStatus;
}

interface SpeechAssetStatus {
  ready: boolean;
  responses: number;
  clips: number;
  packBytes: number;
  cachedBytes: number;
  cachedEntries: number;
}

const EMPTY_STATUS: SpeechAssetStatus = { ready: false, responses: 0, clips: 0, packBytes: 0, cachedBytes: 0, cachedEntries: 0 };

interface Response { clipIds: string[] }

/**
 * The lookup key for a spoken response: typographic apostrophes and quotes as
 * ASCII, whitespace runs collapsed and the ends trimmed. The agent varies
 * these freely and none of them changes what is heard; words, case and other
 * punctuation still have to match exactly.
 */
function speechAssetKey(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

type PackManifest = ReturnType<typeof SpeechAssetManifestSchema.parse>;

interface LoadedPack {
  root: string;
  voice: string;
  clips: Map<string, SpeechAssetClip>;
  responses: Map<string, Response>;
}

interface SegmentChoice { text: string; clipId: string }

type TemplateSegment = PackManifest['templates'][number]['segments'][number];

function segmentChoices(segment: TemplateSegment): SegmentChoice[] {
  if (segment.type === 'literal') return [{ text: segment.text, clipId: segment.clipId }];
  return segment.values;
}

function combineSegment(
  variants: Map<string, Response>,
  choices: SegmentChoice[],
  clips: Map<string, SpeechAssetClip>,
  existingResponses: number,
): Map<string, Response> {
  const next = new Map<string, Response>();
  for (const [prefix, response] of variants) {
    for (const choice of choices) {
      if (!clips.has(choice.clipId)) throw new Error('Unknown clip');
      const phrase = prefix + choice.text;
      if (phrase.length > 700 || next.has(phrase)) throw new Error('Ambiguous or long response');
      next.set(phrase, { clipIds: [...response.clipIds, choice.clipId] });
      if (next.size + existingResponses > MAX_RESPONSES) throw new Error('Too many responses');
    }
  }
  return next;
}

function expandPackTemplates(manifest: PackManifest, clips: Map<string, SpeechAssetClip>): Map<string, Response> {
  const responses = new Map<string, Response>();
  const templateIds = new Set<string>();
  for (const template of manifest.templates) {
    if (templateIds.has(template.id)) throw new Error('Duplicate template');
    templateIds.add(template.id);
    let variants = new Map<string, Response>([['', { clipIds: [] }]]);
    for (const segment of template.segments) {
      variants = combineSegment(variants, segmentChoices(segment), clips, responses.size);
    }
    for (const [phrase, response] of variants) {
      const key = speechAssetKey(phrase);
      if (responses.has(key)) throw new Error('Duplicate response');
      responses.set(key, response);
    }
  }
  return responses;
}

function collectPackClips(manifest: PackManifest): Map<string, SpeechAssetClip> {
  const clips = new Map<string, SpeechAssetClip>();
  for (const clip of manifest.clips) {
    if (clips.has(clip.id)) throw new Error('Duplicate clip');
    clips.set(clip.id, clip);
  }
  return clips;
}

function checkPackIdentity(manifest: PackManifest, identity: SpeechAssetIdentity): void {
  if (manifest.buildVersion !== identity.buildVersion || manifest.model !== identity.model ||
    !(identity.voices ?? [identity.voice]).includes(manifest.voice) || manifest.locale !== identity.locale) {
    throw new Error('Speech identity mismatch');
  }
}

async function loadPackManifest(directory: string): Promise<{ root: string; manifest: PackManifest }> {
  const root = await fs.realpath(directory);
  const manifestPath = resolve(root, 'manifest.json');
  if (await fs.realpath(manifestPath) !== manifestPath) throw new Error('Manifest escapes directory');
  const info = await fs.stat(manifestPath);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds limit');
  const manifest = SpeechAssetManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  return { root, manifest };
}

async function loadPack(options: SpeechAssetCatalogueOptions): Promise<LoadedPack> {
  const { root, manifest } = await loadPackManifest(options.directory);
  checkPackIdentity(manifest, options.identity);
  const clips = collectPackClips(manifest);
  const responses = expandPackTemplates(manifest, clips);
  return { root, voice: manifest.voice, clips, responses };
}

interface ClipReader {
  readClip(id: string): Promise<Buffer | undefined>;
  cachedBytes(): number;
  cachedEntries(): number;
}

function createClipReader(clips: Map<string, SpeechAssetClip>, root: string, cacheMaxBytes: number): ClipReader {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer | undefined>>();
  let cachedBytes = 0;
  const remember = (id: string, bytes: Buffer): void => {
    if (bytes.length > cacheMaxBytes) return;
    while (cachedBytes + bytes.length > cacheMaxBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= cache.get(oldest)?.length ?? 0;
      cache.delete(oldest);
    }
    cache.set(id, bytes);
    cachedBytes += bytes.length;
  };
  const readClip = async (id: string): Promise<Buffer | undefined> => {
    const hit = cache.get(id);
    if (hit !== undefined) {
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const queued = pending.get(id);
    if (queued !== undefined) return queued;
    const clip = clips.get(id);
    if (clip === undefined) return undefined;
    const work = verifiedPcm(root, clip).then((bytes) => {
      if (bytes !== undefined) remember(id, bytes);
      return bytes;
    });
    pending.set(id, work);
    work.then(() => pending.delete(id), () => pending.delete(id));
    return work;
  };
  return { readClip, cachedBytes: () => cachedBytes, cachedEntries: () => cache.size };
}

function safePath(root: string, path: string): string | undefined {
  if (isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').includes('..')) return undefined;
  const candidate = resolve(root, path);
  return isInside(root, candidate) ? candidate : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

async function verifiedPcm(root: string, entry: SpeechAssetClip): Promise<Buffer | undefined> {
  const candidate = safePath(root, entry.path);
  if (candidate === undefined || entry.bytes % 2 !== 0 || entry.durationMs !== Math.round(entry.bytes / 32)) return undefined;
  try {
    const real = await fs.realpath(candidate);
    if (!isInside(root, real)) return undefined;
    const info = await fs.stat(real);
    if (!info.isFile() || info.size !== entry.bytes) return undefined;
    const bytes = await fs.readFile(real);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/** A malformed, mismatched, or absent pack yields an empty catalogue. */
export async function createSpeechAssetCatalogue(options: SpeechAssetCatalogueOptions): Promise<SpeechAssetCatalogue> {
  const cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_BYTES;
  if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 0) throw new Error('Invalid speech asset cache limit');
  let pack: LoadedPack | undefined;
  try {
    pack = await loadPack(options);
  } catch {
    pack = undefined;
  }
  const clips = pack?.clips ?? new Map<string, SpeechAssetClip>();
  const responses = pack?.responses ?? new Map<string, Response>();
  const root = pack?.root ?? '';
  const ready = pack !== undefined;
  const reader = createClipReader(clips, root, cacheMaxBytes);
  const packBytes = [...clips.values()].reduce((sum, clip) => sum + clip.bytes, 0);
  return {
    ready,
    status: () => ({ ready, responses: responses.size, clips: clips.size, packBytes,
      cachedBytes: reader.cachedBytes(), cachedEntries: reader.cachedEntries() }),
    async resolve(text, voice): Promise<Buffer | undefined> {
      if ((voice ?? options.identity.voice) !== pack?.voice) return undefined;
      const response = responses.get(speechAssetKey(text));
      if (response === undefined) return undefined;
      const chunks: Buffer[] = [];
      let total = 0;
      for (const id of response.clipIds) {
        const chunk = await reader.readClip(id);
        if (chunk === undefined) return undefined;
        total += chunk.length;
        if (total > MAX_ASSEMBLED_BYTES) return undefined;
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    },
  };
}

/** Only device TTS is decorated; STT and browser encoded speech pass through. */
export function withSpeechAssets(port: SpeechPort, catalogue: SpeechAssetCatalogue): SpeechPort {
  const observeHit = (kind: string, chars: number, pcmBytes: number, durationMs: number): void => {
    const status = catalogue.status();
    journal('v2.speech_asset_hit', {
      kind,
      chars,
      pcm_bytes: pcmBytes,
      duration_ms: durationMs,
      responses: status.responses,
      cached_entries: status.cachedEntries,
    });
    recordObservationMetrics([
      { name: 'speech.cache_hit', value: 1 },
      { name: 'speech.duration_ms', value: durationMs },
      { name: 'speech.input_chars', value: chars },
      { name: 'speech.audio_ms', value: Math.round((pcmBytes / 2 / 16_000) * 1000) },
    ]);
  };
  const observeMiss = (durationMs: number): void => {
    recordObservationMetrics([
      { name: 'speech.cache_miss', value: 1 },
      { name: 'speech.duration_ms', value: durationMs },
    ]);
  };
  return {
    transcribe: (pcm) => port.transcribe(pcm),
    ...(port.openTranscriptStream !== undefined ? { openTranscriptStream: port.openTranscriptStream.bind(port) } : {}),
    transcribeEncoded: (input) => port.transcribeEncoded(input),
    synthesizeEncoded: (input) => port.synthesizeEncoded(input),
    synthesizePcm: async (text, voice) => traceSpan('speech-assets', { metadata: { format: 'pcm' } }, async () => {
      const start = performance.now();
      const pcm = await catalogue.resolve(text, voice);
      const durationMs = Math.round(performance.now() - start);
      if (pcm === undefined) {
        observeMiss(durationMs);
        return port.synthesizePcm(text, voice);
      }
      observeHit('pcm', text.length, pcm.length, durationMs);
      return { pcm, sourceRateHz: 16_000 };
    }),
    synthesizeMp3: async (text, voice) => traceSpan('speech-assets', { metadata: { format: 'mp3' } }, async () => {
      const start = performance.now();
      const pcm = await catalogue.resolve(text, voice);
      if (pcm === undefined) {
        observeMiss(Math.round(performance.now() - start));
        return port.synthesizeMp3(text, voice);
      }
      try {
        const mp3 = encodePcmMp3(pcm);
        const durationMs = Math.round(performance.now() - start);
        observeHit('mp3', text.length, pcm.length, durationMs);
        return { mp3 };
      } catch {
        observeMiss(Math.round(performance.now() - start));
        return port.synthesizeMp3(text, voice);
      }
    }),
  };
}

/** Env wiring for the opt-in decorator; unset dir and url means disabled. */
function speechAssetsIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechAssetIdentity {
  return {
    buildVersion: env.BOB_SPEECH_ASSETS_BUILD ?? '',
    model: env.BOB_TTS_MODEL ?? BOB_TTS_MODEL,
    voice: env.BOB_TTS_VOICE ?? BOB_TTS_VOICE,
    locale: env.BOB_SPEECH_ASSETS_LOCALE ?? 'en-US',
    voices: [env.BOB_TTS_VOICE ?? BOB_TTS_VOICE, ttsVoiceFor('Bob')],
  };
}

export function speechAssetsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechAssetCatalogueOptions | undefined {
  const directory = env.BOB_SPEECH_ASSETS_DIR;
  if (directory === undefined || directory === '') return undefined;
  return { directory, identity: speechAssetsIdentityFromEnv(env) };
}

const EMPTY_CATALOGUE: SpeechAssetCatalogue = { ready: false, resolve: async () => undefined, status: () => EMPTY_STATUS };

/**
 * One load per process. A local dir wins; else BOB_SPEECH_ASSETS_URL names a
 * hosted pack folder, downloaded once to a fresh temp dir. Journals the outcome
 * (counts and a reason enum only, never the URL or path).
 */
function openSpeechAssets(env: NodeJS.ProcessEnv): { remote: boolean; open: () => Promise<SpeechAssetCatalogue> } | undefined {
  const local = speechAssetsOptionsFromEnv(env);
  if (local !== undefined) return { remote: false, open: () => createSpeechAssetCatalogue(local) };
  const url = env.BOB_SPEECH_ASSETS_URL;
  if (url === undefined || url === '') return undefined;
  const identity = speechAssetsIdentityFromEnv(env);
  return {
    remote: true,
    open: async () => createSpeechAssetCatalogue({ directory: (await fetchSpeechPack(url, identity.buildVersion)).directory, identity }),
  };
}

function journalLoad(source: string, build: string, startedAt: number, catalogue: SpeechAssetCatalogue | undefined, error?: unknown): void {
  if (catalogue?.ready === true) {
    const status = catalogue.status();
    journal('v2.speech_assets_loaded', { pack_source: source, build, responses: status.responses, clips: status.clips,
      pack_bytes: status.packBytes, duration_ms: Math.round(performance.now() - startedAt) });
    return;
  }
  const reason = error instanceof SpeechPackFetchError ? error.reason : 'invalid_pack';
  journal('v2.speech_assets_load_failed', { pack_source: source, build, reason, duration_ms: Math.round(performance.now() - startedAt) });
}

/** Opt-in decorator: no dir or url (or a bad pack) behaves exactly like the base port. */
export function withSpeechAssetsFromEnv(port: SpeechPort, env: NodeJS.ProcessEnv = process.env): SpeechPort {
  const source = openSpeechAssets(env);
  if (source === undefined) return port;
  const label = source.remote ? 'url' : 'dir';
  const build = env.BOB_SPEECH_ASSETS_BUILD ?? '';
  const startedAt = performance.now();
  let loaded: SpeechAssetCatalogue | undefined;
  const pending = source.open().then(
    (catalogue) => { journalLoad(label, build, startedAt, catalogue); return catalogue; },
    (error: unknown) => { journalLoad(label, build, startedAt, undefined, error); return EMPTY_CATALOGUE; },
  ).then((catalogue) => {
    loaded = catalogue;
    return catalogue;
  });
  // A hosted pack never holds up a turn: until the boot download lands, replies use ordinary TTS.
  const current = async (): Promise<SpeechAssetCatalogue> => (source.remote ? loaded ?? EMPTY_CATALOGUE : pending);
  const lazy: SpeechAssetCatalogue = {
    get ready() { return loaded?.ready ?? false; },
    resolve: async (text, voice) => (await current()).resolve(text, voice),
    status: () => loaded?.status() ?? EMPTY_STATUS,
  };
  return withSpeechAssets(port, lazy);
}
