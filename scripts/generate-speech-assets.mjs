import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/*
 * generate-speech-assets.mjs — build a schemaVersion 2 speech-asset pack.
 *
 * A pack is raw PCM16 16 kHz mono clips plus exact response templates made of
 * literal phrases and variable slots. The server assembles validated clips,
 * then encodes MP3 once; anything missing or unmatched falls back to ordinary
 * TTS. Record the clips with the effective model/voice first (provider TTS to
 * WAV, resampled to PCM16 16 kHz mono), then describe them in a spec file:
 *
 *   { buildVersion, model, voice, locale,
 *     clips: [{ id, file }], templates: [{ id, segments }] }
 *
 * Segments are { type: "literal", text, clipId } or
 * { type: "slot", values: [{ text, clipId }] }. Paths stay inside the pack
 * directory. Run:
 *
 *   node scripts/generate-speech-assets.mjs --dir data/voice-assets/my-pack \
 *     --spec assets-spec.json --write
 *
 * Without --write the manifest prints to stdout. Exit non-zero on any bound
 * violation (256 clips, 64 templates, 8 segments, 64 slot values, 256 expanded
 * responses, 700-char phrases, 180-char clip paths and a 64 KiB manifest).
 * Server assembly still downloads audio.
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Mirrors speechAssetKey in apps/api/src/voice/speech-assets.ts: the server's lookup key. */
function speechAssetKey(text) {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function usage() {
  return 'usage: node scripts/generate-speech-assets.mjs --dir <pack-dir> --spec <spec.json> [--write]';
}

function fail(message) {
  throw new Error(message);
}

function takeValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(usage());
  return { value, next: index + 1 };
}

function parseArgs(argv) {
  const out = { dir: undefined, spec: undefined, write: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--dir') {
      const taken = takeValue(argv, index);
      out.dir = taken.value;
      index = taken.next;
    } else if (arg === '--spec') {
      const taken = takeValue(argv, index);
      out.spec = taken.value;
      index = taken.next;
    } else if (arg === '--write') {
      out.write = true;
    } else {
      throw new Error(`${usage()}\nunknown arg: ${arg}`);
    }
    index += 1;
  }
  if (out.dir === undefined || out.spec === undefined) throw new Error(usage());
  return out;
}

function checkSpecScalars(spec) {
  const { buildVersion, model, voice, locale, clips, templates } = spec;
  if (typeof buildVersion !== 'string' || !BUILD_RE.test(buildVersion)) fail('spec.buildVersion is not a build id');
  if (typeof model !== 'string' || model.length < 1 || model.length > 128) fail('spec.model is not 1..128 chars');
  if (typeof voice !== 'string' || voice.length < 1 || voice.length > 128) fail('spec.voice is not 1..128 chars');
  if (typeof locale !== 'string' || locale.length < 2 || locale.length > 32) fail('spec.locale is not 2..32 chars');
  if (!Array.isArray(clips) || clips.length > 256) fail('spec.clips holds at most 256 entries');
  if (!Array.isArray(templates) || templates.length > 64) fail('spec.templates holds at most 64 entries');
}

async function clipManifestEntry(entry, clipIds, specDir, root) {
  if (typeof entry?.id !== 'string' || !ID_RE.test(entry.id)) fail(`clip id is not valid: ${entry?.id}`);
  if (clipIds.has(entry.id)) fail(`duplicate clip: ${entry.id}`);
  clipIds.add(entry.id);
  if (typeof entry?.file !== 'string' || entry.file === '') fail(`clip ${entry.id} is missing its file`);
  const abs = resolve(specDir, entry.file);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith('..')) fail(`clip ${entry.id} escapes the pack directory`);
  const path = rel.split('\\').join('/');
  if (path.length > 180) fail(`clip ${entry.id} path exceeds 180 chars`);
  const bytes = await fs.readFile(abs);
  if (bytes.length < 2 || bytes.length > 320 * 1024 || bytes.length % 2 !== 0) {
    fail(`clip ${entry.id} is not valid PCM16 bytes`);
  }
  const durationMs = Math.round(bytes.length / 32);
  if (durationMs < 1) fail(`clip ${entry.id} duration rounds to zero`);
  return {
    id: entry.id,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    durationMs,
    sampleRateHz: 16_000,
  };
}

async function buildManifestClips(clips, specDir, root) {
  const manifestClips = [];
  const clipIds = new Set();
  for (const entry of clips) {
    manifestClips.push(await clipManifestEntry(entry, clipIds, specDir, root));
  }
  return { manifestClips, clipIds };
}

function segmentChoices(segment, templateId) {
  const choices = segment?.type === 'literal'
    ? [{ text: segment.text, clipId: segment.clipId }]
    : segment?.type === 'slot' ? segment.values : undefined;
  if (!Array.isArray(choices) || choices.length < 1 || choices.length > 64) {
    fail(`template ${templateId} has a bad segment`);
  }
  return choices;
}

function checkChoice(choice, clipIds, templateId) {
  if (typeof choice?.text !== 'string' || choice.text.length < 1 || choice.text.length > 200) {
    fail(`template ${templateId} has a bad phrase`);
  }
  if (!clipIds.has(choice.clipId)) fail(`template ${templateId} names an unknown clip`);
}

function combineSpecVariants(variants, choices, clipIds, responses, templateId) {
  const next = [];
  for (const prefix of variants) {
    for (const choice of choices) {
      checkChoice(choice, clipIds, templateId);
      const phrase = prefix + choice.text;
      const key = speechAssetKey(phrase);
      if (phrase.length > 700 || next.some((other) => speechAssetKey(other) === key)) {
        fail(`template ${templateId} is ambiguous or long`);
      }
      next.push(phrase);
      if (next.length + responses.size > 256) fail('pack expands to more than 256 responses');
    }
  }
  return next;
}

function expandSpecTemplate(template, clipIds, responses, templateIds) {
  if (typeof template?.id !== 'string' || !ID_RE.test(template.id)) fail(`template id is not valid: ${template?.id}`);
  if (templateIds.has(template.id)) fail(`duplicate template: ${template.id}`);
  templateIds.add(template.id);
  if (!Array.isArray(template.segments) || template.segments.length < 1 || template.segments.length > 8) {
    fail(`template ${template.id} holds 1..8 segments`);
  }
  let variants = [''];
  for (const segment of template.segments) {
    variants = combineSpecVariants(variants, segmentChoices(segment, template.id), clipIds, responses, template.id);
  }
  return variants;
}

function expandSpecResponses(templates, clipIds) {
  const templateIds = new Set();
  const responses = new Set();
  for (const template of templates) {
    const variants = expandSpecTemplate(template, clipIds, responses, templateIds);
    for (const phrase of variants) {
      const key = speechAssetKey(phrase);
      if (responses.has(key)) fail(`duplicate response in ${template.id}`);
      responses.add(key);
    }
  }
  return responses;
}

async function writeManifest(root, manifest, templates, manifestClips, responses, write) {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) fail('Manifest exceeds 64 KiB');
  if (!write) {
    process.stdout.write(text);
    return;
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, 'manifest.json'), text);
  console.log(`wrote manifest.json: ${manifestClips.length} clips, ${templates.length} templates, ${responses.size} responses`);
}

async function main() {
  const { dir, spec, write } = parseArgs(process.argv.slice(2));
  const root = resolve(dir);
  const specPath = resolve(spec);
  const specRaw = JSON.parse(await fs.readFile(specPath, 'utf8'));
  checkSpecScalars(specRaw);
  const { buildVersion, model, voice, locale, clips, templates } = specRaw;
  const specDir = dirname(specPath);
  const { manifestClips, clipIds } = await buildManifestClips(clips, specDir, root);
  const responses = expandSpecResponses(templates, clipIds);
  const manifest = { schemaVersion: 2, buildVersion, model, voice, locale, clips: manifestClips, templates };
  await writeManifest(root, manifest, templates, manifestClips, responses, write);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
