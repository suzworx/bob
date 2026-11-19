/**
 * Process start-up checks that run before the server is built (issue #619):
 * the journal and debug sinks, the effective configuration, the auth gate and
 * the AI-stub notice. Kept out of server.ts so that file only wires modules.
 */
import {
  AI_STUB_MODE,
  debugLog,
  isDebugEnabled,
  liveKeyRefusal,
  logAgentConfig,
  BOB_STT_MODEL,
  BOB_TTS_MODEL,
  BOB_TTS_VOICE,
  BOB_TTS_VOICE_BOB_REFUSED,
  onTelemetryError,
  productionKeyRefusal,
  scriptedStubAllowed,
  setDebugSink,
  TTS_TIMEOUT_MS,
  ttsVoiceFor,
} from '@bob/ai';
import { openJournalFile, setJournalSink, moduleJournal } from './platform/logger.ts';
import { V2_PATH, V2_PROTOCOL } from './voice/protocol.ts';
import { isProduction, validateAuthConfig } from './account/auth.ts';
import { DATABASE_URL_DIRECT_HOST, DATABASE_URL_REQUIRED, isSupabaseDirectHost } from './platform/db/db.ts';
import { enabledPayloadFlags } from './platform/observability/payload-flags.ts';

const journal = moduleJournal('server');

/** The effective configuration, resolved. Model/voice/format choices are invisible in the journal but decide how every reply sounds. */
function logEffectiveConfig(port: number, journalPath: string, debugPath: string): void {
  debugLog('server.config', {
    port,
    path: V2_PATH,
    protocol: V2_PROTOCOL,
    journal_path: journalPath,
    debug_path: debugPath,
    chat_model: process.env.BOB_CHAT_MODEL ?? '(default)',
    gateway_base_url: process.env.BOB_GATEWAY_BASE_URL ?? '(default)',
    stt_model: BOB_STT_MODEL,
    stt_language: process.env.BOB_STT_LANGUAGE ?? '(unset - provider auto-detects)',
    tts_model: BOB_TTS_MODEL,
    tts_voice: BOB_TTS_VOICE,
    tts_format: 'mp3',
    system_test_mode: process.env.BOB_SYSTEM_TEST === '1',
    api_key_present: Boolean(process.env.AI_GATEWAY_API_KEY),
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    cwd: process.cwd(),
  });
  logAgentConfig();
}

/**
 * The auth gate runs at startup whether or not BOB_PRODUCTION is set: a
 * malformed BOB_LEGACY_DEVICE_OWNER is refused in every mode (T036), while
 * the production-only checks (Supabase vars, system-test conflict, legacy
 * secret) stay gated inside validateAuthConfig.
 */
function refuseBadAuthConfig(): void {
  const authCheck = validateAuthConfig(process.env);
  if (authCheck.ok) return;
  const reason =
    'missing' in authCheck
      ? `BOB_PRODUCTION=1 requires ${authCheck.missing} to be set`
      : 'invalid' in authCheck
        ? `${authCheck.invalid} must be a valid uuid when set`
        : 'localOnly' in authCheck
          ? `${authCheck.localOnly}=1 requires a local database: point BOB_DATABASE_URL at 127.0.0.1, localhost or ::1 (the local Supabase stack)`
          : `${authCheck.mustUnset} must be unset when BOB_PRODUCTION=1`;
  console.error(`\n${reason} (web-auth.md production gate matrix).\n`);
  process.exit(1);
}

/**
 * One engine everywhere: there is no stand-in database, so a server with no
 * BOB_DATABASE_URL would fail on its first store call. Refuse at boot instead,
 * naming the fix (never a URL), and journal why.
 */
function refuseMissingDatabase(): void {
  if (process.env.BOB_DATABASE_URL) return;
  journal('v2.database_url_missing', {});
  console.error(`
${DATABASE_URL_REQUIRED}.
`);
  process.exit(1);
}

/**
 * #1306: the direct host resolves to IPv6 only, so a production server would
 * crash-loop on its first query. Refuse at boot, journaling the code only.
 */
function refuseDirectDatabaseHostInProduction(): void {
  if (!isProduction() || !isSupabaseDirectHost(process.env.BOB_DATABASE_URL ?? '')) return;
  journal('v2.database_url_unreachable_host', {});
  console.error(`\n${DATABASE_URL_DIRECT_HOST}.\n`);
  process.exit(1);
}

/**
 * #1039: a payload flag in production would send prompts, replies or transcripts
 * to the trace backends or Railway logs. Refuse to boot, journaling each flag by
 * name (never a value), rather than honour it silently.
 */
function refusePayloadFlagsInProduction(): void {
  if (!isProduction()) return;
  const flags = enabledPayloadFlags(process.env);
  if (flags.length === 0) return;
  for (const flag of flags) journal('v2.payload_flag_error', { flag });
  console.error(`\n${flags.join(', ')} must be unset when BOB_PRODUCTION=1: payload capture never runs in production (docs/observability.md).\n`);
  process.exit(1);
}

/**
 * #1041: test traffic once spent the production key's budget. A production
 * server refuses the dev/test key, and every other server refuses the
 * production key unless BOB_ALLOW_PROD_KEY=1: a local server is what live
 * probes, test:e2e:live and accept:replay spend through. Compared by
 * fingerprint only (apps/ai/src/key-guard.ts); the key is never logged. A
 * stubbed local server calls no provider, so it is not refused (unless
 * BOB_SYSTEM_TEST_REAL_TTS=1 keeps speech real).
 */
function refuseWrongAiKey(): void {
  const production = isProduction();
  const spendsNothing = !production && AI_STUB_MODE && process.env.BOB_SYSTEM_TEST_REAL_TTS !== '1';
  const reason = production ? productionKeyRefusal() : spendsNothing ? undefined : liveKeyRefusal();
  if (reason === undefined) return;
  journal('v2.ai_key_error', { production });
  console.error(`\n${reason}.\n`);
  process.exit(1);
}

/** #898: the production journal never said which TTS/STT models served a turn. `stub` says whether they are actually serving turns or sitting idle under the AI stub. */
export function journalSpeechConfig(): void {
  // A refused Bob override is loud (level error), and names only the voice in force, never the raw env text.
  if (BOB_TTS_VOICE_BOB_REFUSED) journal('v2.tts_voice_bob_error', { fallback_voice: ttsVoiceFor('Bob') });
  journal('v2.speech_config', {
    tts_model: BOB_TTS_MODEL,
    tts_voice: BOB_TTS_VOICE,
    tts_voice_bob: ttsVoiceFor('Bob'),
    tts_format: 'mp3',
    stt_model: BOB_STT_MODEL,
    tts_timeout_ms: TTS_TIMEOUT_MS,
    stub: AI_STUB_MODE,
  });
}

/** #550: BOB_AI_STUB=1 and =scripted are both BOB_AI_STUB; `variant` says whether the web chat answers canned or from the scripted stub agent. */
function journalAiStubMode(): void {
  const viaAiStub = process.env.BOB_AI_STUB === '1' || process.env.BOB_AI_STUB === 'scripted';
  journal('v2.ai_stub_mode', {
    source: viaAiStub ? 'BOB_AI_STUB' : 'BOB_SYSTEM_TEST',
    variant: scriptedStubAllowed() ? 'scripted' : 'canned',
  });
}

/** Opens the journal sink, logs the resolved configuration, refuses a production payload flag, the wrong AI key, a missing database or a bad auth config, journals the stub mode. */
export function bootChecks(port: number, journalPath: string, debugPath: string): void {
  setJournalSink(openJournalFile(journalPath));
  // Plan D3 (specs/009): Braintrust export failures surface in the journal as
  // v2.telemetry_export_failed { kind }, once per kind per process. The
  // subscription replaces the module's default console.warn; journal() also
  // prints to the console, so nothing is lost.
  onTelemetryError((kind: string) => journal('v2.telemetry_export_failed', { kind }));
  // A privacy refusal comes before every other, the debug sink and config log included: the
  // effective config carries the system instructions, which must not reach any output of a refused boot.
  refusePayloadFlagsInProduction();
  refuseWrongAiKey();
  if (isDebugEnabled()) {
    setDebugSink(openJournalFile(debugPath));
    logEffectiveConfig(port, journalPath, debugPath);
  }
  // With no URL the auth gate's local-database refusal would be the
  // less helpful message for the same root cause.
  refuseMissingDatabase();
  refuseDirectDatabaseHostInProduction();
  refuseBadAuthConfig();
  journalSpeechConfig();
  if (isProduction()) journal('v2.production_mode', {});
  if (AI_STUB_MODE) journalAiStubMode();
}
