/**
 * Vitest suite for the v2 journal in logger.ts: console/sink emission,
 * sink lifecycle, file journaling, rotation, and the default journal path.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, ROOT_CONTEXT, trace, TraceFlags, type Context, type ContextManager } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOURNAL_PATH,
  DEFAULT_LOG_GENERATIONS,
  DEFAULT_MAX_LOG_BYTES,
  journal,
  journalLevel,
  openJournalFile,
  setJournalSink,
} from '../../src/platform/logger.ts';

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  setJournalSink(null);
});

afterEach(() => {
  setJournalSink(null);
  vi.restoreAllMocks();
});

describe('journal', () => {
  it('writes one JSON line with ts and event to the console', () => {
    journal('v2.hello', { session_id: 's1', seq: 3 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0] as string;
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.ts).toMatch(ISO_TS);
    expect(entry.event).toBe('v2.hello');
    expect(entry.session_id).toBe('s1');
    expect(entry.seq).toBe(3);
  });

  it('forwards the same line to the configured sink', () => {
    const sink = vi.fn();
    setJournalSink(sink);
    journal('v2.turn', { turn_ref: 't1', ok: true });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe(sink.mock.calls[0]?.[0]);
  });

  it('defaults fields to an empty object', () => {
    journal('v2.ping');
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(Object.keys(JSON.parse(line) as Record<string, unknown>)).toEqual(['ts', 'level', 'event', 'message', 'source', 'conversation_id', 'conversation_source']);
    expect(JSON.parse(line)).toMatchObject({ source: 'api' });
  });

  it('is silent on the file sink after setJournalSink(null)', () => {
    const sink = vi.fn();
    setJournalSink(sink);
    setJournalSink(null);
    journal('v2.pong');
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('journalLevel', () => {
  it.each(['v2.turn_failed', 'v2.turn_stage_stt_failed', 'v2.x_error', 'v2.error', 'v2.ota.error'])('marks %s as error', (event) => {
    expect(journalLevel(event)).toBe('error');
  });

  it.each(['v2.hello', 'v2.turn_completed', 'v2.failed_over', 'v2.error_budget', 'v2.errors', 'v2.terror'])('marks %s as info', (event) => {
    expect(journalLevel(event)).toBe('info');
  });
});

describe('journal Railway envelope', () => {
  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const SPAN_ID = 'b7ad6b7169203331';
  const lastEntry = (): Record<string, unknown> => JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;

  function inSpan(traceId: string, spanId: string, run: () => void): void {
    const span = trace.wrapSpanContext({ traceId, spanId, traceFlags: TraceFlags.SAMPLED });
    context.with(trace.setSpan(context.active(), span), run);
  }

  // Synchronous stand-in for the SDK's context manager: the journal call is synchronous.
  class StackContextManager implements ContextManager {
    private stack: Context[] = [ROOT_CONTEXT];
    active(): Context {
      return this.stack.at(-1) ?? ROOT_CONTEXT;
    }
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      ctx: Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      this.stack.push(ctx);
      try {
        return fn.call(thisArg, ...args);
      } finally {
        this.stack.pop();
      }
    }
    bind<T>(_ctx: Context, target: T): T {
      return target;
    }
    enable(): this {
      return this;
    }
    disable(): this {
      this.stack = [ROOT_CONTEXT];
      return this;
    }
  }

  beforeEach(() => {
    context.setGlobalContextManager(new StackContextManager());
  });

  afterEach(() => {
    context.disable();
  });

  it('sets message to the event and level from the event name', () => {
    journal('v2.turn_failed', { stage: 'stt' });
    expect(lastEntry()).toMatchObject({ level: 'error', event: 'v2.turn_failed', message: 'v2.turn_failed', stage: 'stt' });
    journal('v2.turn_completed');
    expect(lastEntry()).toMatchObject({ level: 'info', message: 'v2.turn_completed' });
  });

  it('adds trace_id and span_id from the active span, after the caller fields', () => {
    inSpan(TRACE_ID, SPAN_ID, () => journal('v2.hello', { seq: 1 }));
    const entry = lastEntry();
    expect(entry.trace_id).toBe(TRACE_ID);
    expect(entry.span_id).toBe(SPAN_ID);
    expect(Object.keys(entry)).toEqual(['ts', 'level', 'event', 'message', 'source', 'conversation_id', 'conversation_source', 'seq', 'trace_id', 'span_id']);
  });

  it('writes the same enriched line to the console and the sink', () => {
    const sink = vi.fn();
    setJournalSink(sink);
    inSpan(TRACE_ID, SPAN_ID, () => journal('v2.hello'));
    expect(sink.mock.calls[0]?.[0]).toBe(logSpy.mock.calls[0]?.[0]);
    expect(JSON.parse(sink.mock.calls[0]?.[0] as string)).toMatchObject({ trace_id: TRACE_ID });
  });

  it('omits trace_id and span_id outside a span', () => {
    journal('v2.hello');
    expect(lastEntry()).not.toHaveProperty('trace_id');
    expect(lastEntry()).not.toHaveProperty('span_id');
  });

  it('omits both when the span context is invalid', () => {
    inSpan('0'.repeat(32), '0'.repeat(16), () => journal('v2.hello'));
    expect(lastEntry()).not.toHaveProperty('trace_id');
    expect(lastEntry()).not.toHaveProperty('span_id');
  });

  it('keeps level, message, trace_id and span_id reserved for the logger', () => {
    const spoof = { level: 'debug', message: 'spoofed', trace_id: 'spoof-trace', span_id: 'spoof-span' };
    journal('v2.turn_failed', spoof);
    expect(lastEntry()).toMatchObject({ level: 'error', message: 'v2.turn_failed' });
    expect(lastEntry()).not.toHaveProperty('trace_id');
    inSpan(TRACE_ID, SPAN_ID, () => journal('v2.hello', spoof));
    expect(lastEntry()).toMatchObject({ level: 'info', message: 'v2.hello', trace_id: TRACE_ID, span_id: SPAN_ID });
  });

  it('never throws when reading the span fails', () => {
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => journal('v2.hello')).not.toThrow();
    expect(lastEntry()).toMatchObject({ event: 'v2.hello' });
    expect(lastEntry()).not.toHaveProperty('trace_id');
  });
});

describe('openJournalFile', () => {
  it('creates parent directories and appends lines to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-journal-'));
    try {
      const file = join(dir, 'nested', 'sub', 'v2-journal.log');
      const sink = openJournalFile(file);
      sink('{"event":"v2.one"}');
      sink('{"event":"v2.two"}');
      openJournalFile(file)('{"event":"v2.three"}'); // second sink appends.
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
      expect(lines).toEqual(['{"event":"v2.one"}', '{"event":"v2.two"}', '{"event":"v2.three"}']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openJournalFile rotation', () => {
  // A server left running writes the same journal for weeks. Unbounded, the
  // file is eventually deleted wholesale, which is how history gets lost.
  it('rotates the live file once a line would pass the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-rotate-'));
    try {
      const file = join(dir, 'v2-journal.log');
      const sink = openJournalFile(file, { maxBytes: 24, generations: 2 });
      sink('{"event":"one"}'); // 16 bytes with the newline.
      sink('{"event":"two"}'); // Would reach 32, so it rotates first.
      expect(readFileSync(file, 'utf8')).toBe('{"event":"two"}\n');
      expect(readFileSync(join(dir, 'v2-journal.1.log'), 'utf8')).toBe('{"event":"one"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The suffix has to stay last, or `npm run logs:clean` -- which matches on
  // the extension -- would sweep the live file and leave the rotations.
  it('names generations with the .log suffix last and drops the oldest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-rotate-'));
    try {
      const file = join(dir, 'v2-journal.log');
      const sink = openJournalFile(file, { maxBytes: 24, generations: 2 });
      for (const event of ['one', 'two', 'three', 'four']) sink(`{"event":"${event}"}`);
      expect(readFileSync(join(dir, 'v2-journal.1.log'), 'utf8')).toBe('{"event":"three"}\n');
      expect(readFileSync(join(dir, 'v2-journal.2.log'), 'utf8')).toBe('{"event":"two"}\n');
      expect(existsSync(join(dir, 'v2-journal.3.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Otherwise a line longer than the whole budget rotates an empty file on
  // every write, shredding the history one entry at a time.
  it('writes a line larger than the cap rather than rotating forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-rotate-'));
    try {
      const file = join(dir, 'v2-journal.log');
      const sink = openJournalFile(file, { maxBytes: 8, generations: 2 });
      sink('{"event":"a-very-long-entry"}');
      expect(readFileSync(file, 'utf8')).toBe('{"event":"a-very-long-entry"}\n');
      expect(existsSync(join(dir, 'v2-journal.1.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A restarted server must not append to a file that is already at the cap
  // and then never rotate it, so the opening size comes from disk.
  it('counts the existing file against the cap when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bob-rotate-'));
    try {
      const file = join(dir, 'v2-journal.log');
      writeFileSync(file, `${'x'.repeat(40)}\n`);
      openJournalFile(file, { maxBytes: 24, generations: 2 })('{"event":"fresh"}');
      expect(readFileSync(file, 'utf8')).toBe('{"event":"fresh"}\n');
      expect(readFileSync(join(dir, 'v2-journal.1.log'), 'utf8').startsWith('xxx')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to a bounded cap and a small number of generations', () => {
    expect(DEFAULT_MAX_LOG_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_LOG_GENERATIONS).toBeGreaterThan(0);
  });
});

describe('DEFAULT_JOURNAL_PATH', () => {
  it('points into the data directory under the journal filename', () => {
    expect(DEFAULT_JOURNAL_PATH.endsWith(join('data', 'v2-journal.log'))).toBe(true);
  });
});