/**
 * Loads the repo-root .env (with the working directory as fallback) and
 * exports the Gateway and system-test configuration used by the agents.
 */
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the repo-root .env. Under tsx (ESM) `import.meta.url` points at
 * this file, so `new URL('../../../.env', import.meta.url)` reaches the repo
 * root. The braintrust eval CLI bundles eval files to CommonJS (esbuild),
 * where `import.meta.url` is empty and that constructor throws; fall back to
 * walking up from the working directory to the first package.json that
 * declares workspaces, which marks the repo root.
 */
function resolveRepoRootEnvPath(): string {
  if (import.meta.url) {
    return fileURLToPath(new URL('../../../.env', import.meta.url));
  }
  let dir = process.cwd();
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        workspaces?: unknown;
      };
      if (Array.isArray(pkg.workspaces)) {
        return join(dir, '.env');
      }
    } catch {
      // No package.json here (or unreadable); keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return join(process.cwd(), '.env');
    }
    dir = parent;
  }
}

/** A developer .env changes unit-test behaviour, so it never loads under vitest unless BOB_TEST_DOTENV=1. */
export function shouldLoadDotenv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.VITEST) return true;
  return env.BOB_TEST_DOTENV === '1';
}

if (shouldLoadDotenv()) {
  dotenv.config({ path: resolveRepoRootEnvPath() });
  dotenv.config();
}

/** Parses a positive integer env value, falling back when unset or invalid. */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Gateway credential; the provider reads the same environment name by default. */
export const AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY ?? '';
/** Undocumented seam for pointing tests at a local stub; unset in production. */
export const BOB_GATEWAY_BASE_URL = process.env.BOB_GATEWAY_BASE_URL ?? '';
/**
 * How long an idle socket in the Gateway keep-alive pool is kept. The Gateway sends no Keep-Alive hint, so
 * this alone decides; it must stay below the Gateway's idle timeout, or a reused socket can die mid-request.
 */
export const BOB_GATEWAY_KEEPALIVE_MS = parsePositiveInteger(process.env.BOB_GATEWAY_KEEPALIVE_MS, 15_000);
export const BOB_CHAT_MODEL = process.env.BOB_CHAT_MODEL ?? 'openai/gpt-4o';
export const BOB_STT_MODEL = process.env.BOB_STT_MODEL ?? 'fish-audio/transcribe-1';
/** The streaming STT model used while the user talks when BOB_STT_STREAMING=1. */
export const BOB_STT_STREAMING_MODEL = process.env.BOB_STT_STREAMING_MODEL || 'microsoft/mai-transcribe-2-streaming';
/** Undocumented seam: override the providerOptions key that carries the language pin. */
export const BOB_STT_OPTIONS_NAMESPACE = process.env.BOB_STT_OPTIONS_NAMESPACE ?? '';
/** MAI rejects non-MAI voices such as 'alloy', so the TTS model and voice change together. */
export const BOB_TTS_MODEL = process.env.BOB_TTS_MODEL ?? 'microsoft/mai-voice-2.1-flash';
export const BOB_TTS_VOICE = process.env.BOB_TTS_VOICE ?? 'en-US-Harper';
/** The MAI-Voice-2.1 en-US voice ids. A Bob override outside them is a typo, not a voice. */
const MAI_EN_US_VOICES = new Set(['en-US-Ethan', 'en-US-Grant', 'en-US-Jasper', 'en-US-Sage', 'en-US-Harper', 'en-US-Iris', 'en-US-Olivia']);
const bobVoiceEnv = process.env.BOB_TTS_VOICE_BOB ?? '';
/** BOB_TTS_VOICE_BOB named no known MAI en-US voice: it was refused and boot journals v2.tts_voice_bob_error. */
export const BOB_TTS_VOICE_BOB_REFUSED = bobVoiceEnv !== '' && !MAI_EN_US_VOICES.has(bobVoiceEnv);
/** Bob's humble male voice: the owner auditioned the MAI US male voices and chose en-US-Sage. */
const BOB_TTS_VOICE_BOB = bobVoiceEnv !== '' && !BOB_TTS_VOICE_BOB_REFUSED ? bobVoiceEnv : 'en-US-Sage';
/** The TTS voice for a device turn: a device that names Bob gets Bob's voice, no name the default. */
export function ttsVoiceFor(assistantName?: 'Bob'): string {
  return assistantName === 'Bob' ? BOB_TTS_VOICE_BOB : BOB_TTS_VOICE;
}
/**
 * Language pinned for speech-to-text. Left unset the provider auto-detects,
 * and short noisy 16 kHz mic input is detected wrongly often enough that
 * replies come back in a language the speaker never used. Set to 'auto' to
 * deliberately restore auto-detection.
 */
export const BOB_STT_LANGUAGE = process.env.BOB_STT_LANGUAGE ?? 'en';
export const BOB_SYSTEM_TEST_MODE = process.env.BOB_SYSTEM_TEST === '1';

/**
 * AI-stub mode: BOB_AI_STUB=1 (or =scripted) enables the AI stubs (canned transcript, test-tone TTS,
 * "System test response: <input>" reply) without touching auth; BOB_SYSTEM_TEST=1 adds the loopback test issuer.
 */
export const AI_STUB_MODE =
  process.env.BOB_AI_STUB === '1' || process.env.BOB_AI_STUB === 'scripted' || BOB_SYSTEM_TEST_MODE;

/**
 * Whether the web chat answers from the scripted stub agent (stub-agent.ts), test infrastructure only:
 * BOB_AI_STUB=scripted opts in and BOB_PRODUCTION=1 always refuses. Read on every call so a test can flip it.
 */
export function scriptedStubAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BOB_PRODUCTION === '1') return false;
  return env.BOB_AI_STUB === 'scripted';
}

/**
 * Hard cap on characters sent to TTS. Synthesis time scales with input, so an uncapped reply can exceed
 * the request timeout and fail the turn with no audio; a cap degrades the reply instead of losing it.
 */
export const MAX_TTS_INPUT_CHARS = parsePositiveInteger(process.env.BOB_MAX_TTS_CHARS, 700);

/** Timeout for provider speech requests, sized to the MAI voice's measured latency. */
export const TTS_TIMEOUT_MS = parsePositiveInteger(process.env.BOB_TTS_TIMEOUT_MS, 8_000);

/** Overall deadline for a transcription, backup request included; a healthy batch call answers in 0.5-1.3 s. */
export const STT_TIMEOUT_MS = parsePositiveInteger(process.env.BOB_STT_TIMEOUT_MS, 8_000);
/** Parses a non-negative integer env value (0 allowed), falling back when unset or invalid. */
function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
/** When the STT model has not answered after this many ms, the audio also goes to BOB_STT_BACKUP_MODEL; first success wins. 0 = off. */
export const STT_HEDGE_MS = parseNonNegativeInteger(process.env.BOB_STT_HEDGE_MS, 2_500);
/** The hedged backup model. Same as the STT model = no hedge. */
export const BOB_STT_BACKUP_MODEL = process.env.BOB_STT_BACKUP_MODEL || 'openai/gpt-4o-mini-transcribe';

/**
 * Opt-in switch for capturing prompts and replies in exported spans
 * (specs/009, FR-003). Off by default: traces are metadata-only.
 * When set, payload capture is allowed in any environment including
 * production — prompts and replies leave over OTLP to the configured backend.
 */
export const BOB_TRACE_PAYLOAD = process.env.BOB_TRACE_PAYLOAD === '1';
