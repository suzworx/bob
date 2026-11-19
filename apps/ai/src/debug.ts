/**
 * Opt-in debug channel for local diagnosis. Unlike the v2 journal in
 * apps/api/src/platform/logger.ts -- which must never carry audio, transcripts, agent
 * text, credentials, URLs, or prompts -- this channel can record payload only when the separately opt-in
 * BOB_DEBUG_PAYLOAD=1 switch is enabled, so a failing turn can be
 * reconstructed end to end deliberately and locally.
 *
 * It is disabled unless BOB_DEBUG=1, writes to its own sink so journal
 * output is never contaminated, and always redacts credentials. Its file
 * lives under data/ (git-ignored) and must never be committed or shipped.
 */

import { isReservedJournalKey, journalEntry, writeConsoleLine, type JournalOrigin } from './journal.ts';

const DEBUG_ORIGIN: JournalOrigin = { source: 'ai', module: 'ai' };

/** Values a debug entry may carry; payload strings require the payload switch. */
export type DebugFields = Record<string, unknown>;

const DEBUG_ENABLED = process.env.BOB_DEBUG === '1';
const DEBUG_PAYLOAD_ENABLED = DEBUG_ENABLED && process.env.BOB_DEBUG_PAYLOAD === '1';

/**
 * Per-frame logging is a second, louder level: a single turn moves hundreds of
 * uplink and downlink frames, which buries the per-turn lines that answer most
 * questions. Enabled by BOB_DEBUG_FRAMES=1 (implies debug mode).
 */
const FRAME_DEBUG_ENABLED = DEBUG_ENABLED && process.env.BOB_DEBUG_FRAMES === '1';

let debugSink: ((line: string) => void) | null = null;

/** True when BOB_DEBUG=1 was set for this process. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}

/** True only when the opt-in payload switch is enabled alongside debug mode. */
export function isPayloadDebugEnabled(): boolean {
  return DEBUG_PAYLOAD_ENABLED;
}

/** True when per-frame logging was additionally requested. */
export function isFrameDebugEnabled(): boolean {
  return FRAME_DEBUG_ENABLED;
}

/** Sets the debug sink; pass null to disable file output. */
export function setDebugSink(sink: ((line: string) => void) | null): void {
  debugSink = sink;
}

const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|secret|token|password|bearer)/i;

/**
 * Replaces credential-shaped values so a debug log can never leak a key.
 * Only strings are redacted: a boolean like api_key_present carries no secret,
 * and blanking it destroys the very signal it was added to report.
 */
function redact(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (value.startsWith('sk-')) return REDACTED;
  return value;
}

/**
 * Serializes one debug entry. Buffers and typed arrays collapse to a byte
 * count rather than dumping binary audio into the log.
 */
// Tool arguments and results carry whatever the user said and whatever the
// assistant produced, so they are payload on the same footing as the reply
// text itself -- FR-018 admits no "derived content" exemption.
const PAYLOAD_KEY_PATTERN = /^(?:text|transcript|prompt|reply|message|messages|tool_calls|tool_results)$/i;

function serialize(fields: DebugFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let payloadSeen = false;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (PAYLOAD_KEY_PATTERN.test(key)) {
      payloadSeen = true;
      if (!DEBUG_PAYLOAD_ENABLED) continue;
    }
    if (value instanceof Uint8Array) {
      out[`${key}_bytes`] = value.byteLength;
      continue;
    }
    out[key] = redact(key, value);
  }
  if (payloadSeen) out.payload = DEBUG_PAYLOAD_ENABLED ? 'enabled' : 'suppressed';
  return out;
}

/**
 * Emits a timestamped JSON debug entry. A no-op when debug mode is off, so
 * call sites can stay unconditional on the hot path.
 */
export function debugLog(event: string, fields: DebugFields = {}): void {
  if (!DEBUG_ENABLED) return;
  // Debug payload never reaches the journal sink or the OTLP bridge: it has its own sink.
  const entry = journalEntry(event, {}, DEBUG_ORIGIN);
  for (const [key, value] of Object.entries(serialize(fields))) {
    // Payload fields such as `message` keep their value under a debug_ name instead of the envelope key.
    entry[isReservedJournalKey(key) ? `debug_${key}` : key] = value;
  }
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // A circular or otherwise unserializable field must never break a turn.
    line = JSON.stringify(journalEntry(event, { debug_error: 'unserializable' }, DEBUG_ORIGIN));
  }
  writeConsoleLine(line);
  debugSink?.(line);
}

/** Times an async stage and records its duration, result, and any failure. */
export async function debugTimed<T>(
  event: string,
  fields: DebugFields,
  run: () => Promise<T>,
): Promise<T> {
  if (!DEBUG_ENABLED) return run();
  const startedAt = Date.now();
  try {
    const result = await run();
    debugLog(event, { ...fields, ok: true, elapsed_ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    debugLog(event, {
      ...fields,
      ok: false,
      elapsed_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
