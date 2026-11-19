/**
 * Vitest suite for the opt-in debug channel. The contract under test is not
 * "debug logs things" but "debug never changes what the journal logs" -- the
 * journal's redaction guarantee is what lets debug mode carry transcripts at
 * all.
 *
 * debug.ts reads BOB_DEBUG once at module load, so the enabled and disabled
 * cases are exercised through separate dynamic imports with vi.resetModules().
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEBUG_PATH, journal, openJournalFile, setJournalSink } from '../../src/platform/logger.ts';

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let logSpy: ReturnType<typeof vi.spyOn>;
const originalDebugFlag = process.env.BOB_DEBUG;
const originalPayloadDebugFlag = process.env.BOB_DEBUG_PAYLOAD;

/** Imports a fresh debug module with BOB_DEBUG set to the given value. */
async function loadDebug(enabled: boolean, payload = false) {
  vi.resetModules();
  if (enabled) process.env.BOB_DEBUG = '1';
  else delete process.env.BOB_DEBUG;
  if (payload) process.env.BOB_DEBUG_PAYLOAD = '1';
  else delete process.env.BOB_DEBUG_PAYLOAD;
  const mod = await import('@bob/ai');
  logSpy.mockClear(); // importing the barrel loads config.ts, whose dotenv prints its own banner
  return mod;
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  setJournalSink(null);
});

afterEach(() => {
  setJournalSink(null);
  if (originalDebugFlag === undefined) delete process.env.BOB_DEBUG;
  else process.env.BOB_DEBUG = originalDebugFlag;
  if (originalPayloadDebugFlag === undefined) delete process.env.BOB_DEBUG_PAYLOAD;
  else process.env.BOB_DEBUG_PAYLOAD = originalPayloadDebugFlag;
  vi.restoreAllMocks();
});

describe('debug mode disabled', () => {
  it('emits nothing at all', async () => {
    const { debugLog, isDebugEnabled } = await loadDebug(false);
    expect(isDebugEnabled()).toBe(false);
    debugLog('turn.transcript', { text: 'hello world' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('never reaches a configured sink', async () => {
    const { debugLog, setDebugSink } = await loadDebug(false);
    const sink = vi.fn();
    setDebugSink(sink);
    debugLog('turn.transcript', { text: 'hello world' });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('debug mode enabled', () => {
  it('records payload the journal is forbidden to carry', async () => {
    const { debugLog, setDebugSink } = await loadDebug(true, true);
    const sink = vi.fn();
    setDebugSink(sink);
    debugLog('turn.transcript', { text: 'what is the roman empire', session: 's1' });

    expect(sink).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(sink.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(entry.ts).toMatch(ISO_TS);
    expect(entry.event).toBe('turn.transcript');
    expect(entry.text).toBe('what is the roman empire');
    expect(entry.session).toBe('s1');
    expect(entry.payload).toBe('enabled');
  });

  it('suppresses payload while retaining an explicit suppression label', async () => {
    const { debugLog, setDebugSink } = await loadDebug(true);
    const sink = vi.fn();
    setDebugSink(sink);
    debugLog('turn.transcript', { text: 'private transcript' });

    const line = sink.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('private transcript');
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.text).toBeUndefined();
    expect(entry.payload).toBe('suppressed');
  });

  it('redacts credentials even though it logs everything else', async () => {
    const { debugLog, setDebugSink } = await loadDebug(true);
    const sink = vi.fn();
    setDebugSink(sink);
    debugLog('ai.request', {
      api_key: 'sk-or-v1-abcdef',
      authorization: 'Bearer sk-or-v1-abcdef',
      token: 'secret-value',
      model: 'openai/gpt-4o',
    });

    const line = sink.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('sk-or-v1-abcdef');
    expect(line).not.toContain('secret-value');
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.api_key).toBe('[redacted]');
    expect(entry.authorization).toBe('[redacted]');
    expect(entry.model).toBe('openai/gpt-4o');
  });

  it('collapses binary payloads to a byte count instead of dumping audio', async () => {
    const { debugLog, setDebugSink } = await loadDebug(true);
    const sink = vi.fn();
    setDebugSink(sink);
    debugLog('ai.tts_response', { audio: new Uint8Array(2048) });

    const entry = JSON.parse(sink.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(entry.audio_bytes).toBe(2048);
    expect(entry.audio).toBeUndefined();
  });

  it('survives an unserializable field without throwing', async () => {
    const { debugLog, setDebugSink } = await loadDebug(true);
    const sink = vi.fn();
    setDebugSink(sink);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => debugLog('turn.agent_reply', { circular })).not.toThrow();
    const entry = JSON.parse(sink.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(entry.debug_error).toBe('unserializable');
  });
});

describe('journal isolation', () => {
  it('keeps journal output byte-identical when debug mode is on', async () => {
    const { setDebugSink } = await loadDebug(true);
    const debugSink = vi.fn();
    setDebugSink(debugSink);
    const journalSink = vi.fn();
    setJournalSink(journalSink);

    journal('v2.stt_completed', { session: 's1', duration_ms: 12 });

    expect(journalSink).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(journalSink.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['conversation_id', 'conversation_source', 'duration_ms', 'event', 'level', 'message', 'session', 'source', 'ts']);
    // Debug entries must never be routed into the journal sink.
    expect(debugSink).not.toHaveBeenCalled();
  });

  it('writes to a different default file than the journal', () => {
    expect(DEFAULT_DEBUG_PATH).not.toBe(DEFAULT_JOURNAL_PATH_FOR_COMPARISON);
    expect(DEFAULT_DEBUG_PATH.endsWith('v2-debug.log')).toBe(true);
  });

  it('appends debug lines to its own file sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-debug-'));
    try {
      const path = join(dir, 'v2-debug.log');
      const sink = openJournalFile(path);
      sink('{"event":"turn.transcript"}');
      expect(readFileSync(path, 'utf8')).toBe('{"event":"turn.transcript"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Imported separately so the comparison above reads clearly.
const DEFAULT_JOURNAL_PATH_FOR_COMPARISON = DEFAULT_DEBUG_PATH.replace('v2-debug.log', 'v2-journal.log');
