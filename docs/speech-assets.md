# Speech assets (server-first template audio)

Prerecorded sound templates assembled from reusable phrases and variable
slots, to avoid repeated text-to-speech generation. Existing STT, LLM
understanding, tool execution and conversation behavior are unchanged: there
is no deterministic command routing and the LLM is never bypassed.

## How it works

- A pack is raw PCM16 16 kHz mono clips plus exact response templates in
  `apps/api/src/voice/speech-assets-manifest.ts` (`schemaVersion: 2`).
- Templates are `literal` phrases plus `slot` value lists. The catalogue in
  `apps/api/src/voice/speech-assets.ts` expands them to at most 256 exact
  response strings and remembers each response's clip list.
- Matching is exact after `speechAssetKey`: typographic apostrophes and
  quotes count as ASCII, and whitespace runs collapse. Words, case and other
  punctuation must match. Spoken-identical spellings (`3`/`three`, `OK`/`Okay`)
  are separate responses that share one clip.
- `withSpeechAssets` decorates only device TTS (`synthesizePcm`,
  `synthesizeMp3`). STT and browser encoded speech pass through untouched.
- On an exact response match the server verifies every clip (path inside the
  pack, byte size, `sha256`, `durationMs = round(bytes / 32)`,
  `sampleRateHz: 16000`), concatenates the PCM, and encodes MP3 once with the
  existing encoder. Separately encoded MP3 files are never concatenated.
- Missing, corrupt, incompatible or unmatched assets fall back to ordinary
  TTS without changing the response or duplicating playback.

Server assembly still downloads audio over the downlink; it does not
eliminate downlink traffic. Device-side asset storage is a later phase.

## Limits

- Manifest at most 64 KiB; clips at most 256; templates at most 64 with 1..8
  segments each; slot values 1..64; expanded responses at most 256; phrases
  at most 700 chars (the TTS cap); assembled PCM at most 320 KiB (the device
  playback buffer); clip bytes 2..320 KiB, even.
- Identity must match exactly: `buildVersion`, `model`, `voice`, `locale`.
  A mismatch, duplicate clip/template/response, unknown clip, over-long or
  ambiguous phrase yields an empty catalogue that always falls back.

## Enabling

Opt-in, disabled by default:

- `BOB_SPEECH_ASSETS_DIR`: pack directory holding `manifest.json` + clips.
- `BOB_SPEECH_ASSETS_URL`: instead of a directory, the public folder of a
  hosted pack (see "Hosting" below). Ignored when the directory is set.
- `BOB_SPEECH_ASSETS_BUILD`: expected `buildVersion`.
- `BOB_TTS_MODEL`: effective model (default `microsoft/mai-voice-2.1-flash`).
- Voice: a pack loads when its voice is one the server can request, the
  default `BOB_TTS_VOICE` (default `en-US-Harper`) or Bob's
  (`BOB_TTS_VOICE_BOB`, default `en-US-Sage`); any other voice is refused.
  A pack is single-voice: only speech requested in the pack's voice hits, so
  with a Sage pack Bob turns play clips and Bob turns use ordinary TTS (and
  the reverse with a Harper pack, #1006).
- `BOB_SPEECH_ASSETS_LOCALE`: expected locale (default `en-US`).

Wired in `apps/api/src/app-deps.ts` outside the TTS cache: a hit skips the
provider entirely; a miss falls through to the cache then the provider.
Unset directory returns the base port unchanged; a bad pack resolves to
fallback on every turn.

The old whole-phrase pack `data/voice-assets/20261012-public-v1`
(`schemaVersion: 1`, 18 phrases) does not match this schema and is not
loaded by the catalogue. The `20261012-template-v2` clips keep about 1 s of
provider silence each and must not be played.

**Production (2026-10-20):** `BOB_SPEECH_ASSETS_URL`/`_BUILD` serve the Bob (en-US-Sage) pack
`bob-en-us-932b5222b644` from Supabase Storage (`v2.speech_assets_loaded` 223 responses, 58 clips,
about 4-6 s after boot). Bob turns whose exact reply is in the pack skip provider TTS; Bob (Harper) turns
always fall back. Rollback was drilled the same day: delete `BOB_SPEECH_ASSETS_URL` and redeploy the
live deployment (a variable change on a docs-only commit is skipped by Railway's watch paths), then set
it again. The owner heard the desktop A/B on 2026-10-16; device listening happens through normal use.

## Hosting (Supabase Storage)

Production has no persistent disk and must never get a Railway volume
(`docs/deploy.md`), so approved packs live in the production Supabase
project's Storage, in the **public** bucket `speech-packs`. Pack audio is
public phrases from a committed spec only, never user content, so public
read is safe. Each build sits under its own immutable path
`speech-packs/<buildVersion>/` (`manifest.json` plus the clips it lists;
`audition.wav`, `spec.json` and `pack.json` stay local).

Upload a recorded pack (loads the repo `.env`; the key never prints):

```bash
npx tsx apps/api/scripts/upload-speech-pack.ts --dir data/voice-assets/<build>
```

It needs `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` (or
`SUPABASE_SECRET_KEY`); without either key it reads the project's secret key
in memory through the Management API with `SUPABASE_ACCESS_TOKEN`. It
verifies every clip locally, creates the bucket public if absent, refuses a
build that already exists (never overwrites), uploads the manifest last, and
prints the `BOB_SPEECH_ASSETS_URL` line.

At boot, with `BOB_SPEECH_ASSETS_URL` set (and no directory), the server
downloads `manifest.json` (at most 64 KiB) and every clip it lists into a
fresh `os.tmpdir()/bob-speech-assets/<build>-*/` directory
(`apps/api/src/voice/speech-assets-remote.ts`): clip paths are checked before
any request, the pack is at most 8 MiB, each request times out after 10 s,
four at a time, and each clip's size and `sha256` must match. It then loads
that directory with the ordinary verifying loader. One attempt per process:
any failure journals `v2.speech_assets_load_failed` and every reply uses
ordinary TTS. A turn never waits for the download, and nothing is fetched
during turns.

- **Enable**: set `BOB_SPEECH_ASSETS_URL` and `BOB_SPEECH_ASSETS_BUILD` on
  Railway (after listening approval). The pack's voice must be the default or
  Bob's voice (above), or the identity check refuses it. Confirm
  `v2.speech_assets_loaded` in the journal after the deploy.
- **Rollback**: unset `BOB_SPEECH_ASSETS_URL` (the next deploy speaks with
  ordinary TTS). Old builds stay in the bucket; delete one only when no
  deploy points at it.

## Building a pack

Record from a committed source spec of public phrases (never user content):

```bash
npx tsx apps/api/scripts/record-speech-pack.ts --spec apps/api/scripts/speech-packs/core-en-us.json
```

The spec lists `clips: [{ id, say }]` and generator-format templates. The
recorder needs the real Gateway key. It refuses stub speech and a spec
model/voice other than the effective one. Each clip goes through
`conditionSpeechClip` (`apps/api/src/voice/audio/speech-clip.ts`), which
trims the provider's silence padding to 30 ms lead and 250 ms tail of its own
audio, levels speech to -20 dBFS under a -1 dBFS peak, and fades the ends.
The pack lands in `data/voice-assets/<name>-<hash>/`, named after a hash of
the spec and every clip, so a build id is never reused or overwritten. Next
to the manifest it writes `pack.json` (hashes, identity, conditioning) and
`audition.wav` (every clip, for listening). It prints the two env lines that
enable it.

Prefer whole sentences per clip: separately synthesized fragments carry
standalone prosody. Join only at sentence boundaries until listening on the
device approves finer joins.

To build a manifest from clips recorded some other way:

1. Record each phrase/slot value with the effective model/voice, to WAV,
   then resample to raw PCM16 16 kHz mono (one clip per file, inside the
   pack directory).
2. Describe the pack in a spec JSON file:
   `{ buildVersion, model, voice, locale, clips: [{ id, file }],
   templates: [{ id, segments }] }`, with `file` relative to the spec and
   resolving inside the pack directory.
3. Run `node scripts/generate-speech-assets.mjs --dir <pack> --spec <spec>
   --write`. Without `--write` the manifest prints to stdout. The script
   computes `sha256`, `bytes`, `durationMs`, enforces the bounds above, and
   refuses ambiguous or over-limit packs.

## Telemetry (text-free)

- Journal `v2.speech_assets_loaded` / `v2.speech_assets_load_failed` once per
  process: `pack_source` (`dir`/`url`), `build`, `duration_ms`, plus
  `responses`, `clips`, `pack_bytes` or a `reason` enum. Never the URL or path.
- Journal `v2.speech_asset_hit` on hits only: `kind` (`pcm`/`mp3`), `chars`,
  `pcm_bytes`, `duration_ms` (assembly, including MP3 encode), `responses`,
  `cached_entries`. Never the response text. Misses journal nothing.
- Metrics: `speech.cache_hit` on hits (= provider calls avoided),
  `speech.cache_miss` on misses, `speech.duration_ms` for assembly/encode
  time, `speech.input_chars` and `speech.audio_ms` on hits. All bounded;
  failures never break the turn.

## Coverage

Which agent replies a pack would speak from clips:

```bash
npx tsx apps/api/scripts/speech-coverage.ts --pack <dir> --build <id> --reps 5
```

It runs the real device agent on synthetic prompts, with stub tools that echo
the request. It scores the final step's text (batch mode, what production runs
with `BOB_STREAMING_REPLY=0`) and each streamed sentence piece, then writes
`data/speech-coverage/`. The [October 13 report](research/2026-10-13-speech-pack-coverage.md)
has the current numbers: 14-44% exact batch hits in the timer domain, with the
production hit rate unknown.

## Measuring

Compare before/after with identical response text, voice and format.
Report cold (first assembly, clips uncached) and warm (clips cached)
separately, and label evidence as software (unit/synthetic bytes),
real-provider (Gateway TTS for clip recording), device (Cardputer
playback), or production. Synthetic byte tests prove joining and fallback,
not naturalness: assess phrase joins and audio quality by listening on the
device before claiming anything about how it sounds.

The [October 12 validation report](research/2026-10-12-speech-template-validation.md)
records a real-provider comparison and a compatible local v2 pack. That pack
is not deployed and listening signoff remains pending. The generator refuses
an oversized UTF-8 manifest before printing it or replacing an existing file.
