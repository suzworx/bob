import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics, recordTraceSignal, traceSpan } from '@bob/ai';
import { anonymousTelemetryRoute, telemetryRoute } from '../../src/platform/observability/telemetry.ts';
import { journal, moduleJournal } from '../../src/platform/logger.ts';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
  recordObservationMetrics: vi.fn(),
  recordTraceSignal: vi.fn(),
}));
vi.mock('../../src/platform/logger.ts', () => {
  const journal = vi.fn();
  return { journal, moduleJournal: vi.fn(() => journal) };
});

const VIEW_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = 'conv_0123456789abcdef0123456789abcdef';
const TRACE_ID = 'ab'.repeat(16);
const base = { page: 'chat', route: '/', view_id: VIEW_ID, duration_ms: 0 };
const vital = { ...base, event: 'web_vital', name: 'LCP', value: 2500, rating: 'good' };
const failure = { ...base, event: 'ui_error', kind: 'error', error_name: 'TypeError', frame: 'index-Ab12.js:10:20' };

async function ingest(events: unknown[], headers: Record<string, string> = {}): Promise<number> {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), setHeader: vi.fn() };
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const request = { body: { events }, account: { userId: USER_ID }, baseUrl: '/api', path: '/telemetry', get: (name: string) => lower[name.toLowerCase()] };
  await telemetryRoute(request as unknown as Request, response as unknown as Response);
  return response.status.mock.calls[0]?.[0] as number;
}

describe('web monitoring ingestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a CLIENT span named for the browser request in the trace the browser started', async () => {
    const request = { ...base, event: 'ui_request', area: 'productivity', endpoint: '/api/tasks/:id', method: 'PATCH', status: 200, outcome: 'ok', trace_id: TRACE_ID, duration_ms: 340 };
    expect(await ingest([request])).toBe(204);
    expect(recordTraceSignal).toHaveBeenCalledWith(TRACE_ID, 'ui.request.duration_ms', 340, expect.objectContaining({ name: 'browser PATCH /api/tasks/:id', durationMs: 340 }));
    vi.clearAllMocks();
    expect(await ingest([{ ...request, trace_id: undefined }])).toBe(204);
    expect(recordTraceSignal).not.toHaveBeenCalled();
    expect(await ingest([{ ...request, trace_id: 'not-a-trace' }])).toBe(400);
  });

  it('records each web vital as its metric, CLS included, and journals v2.web_telemetry', async () => {
    expect(await ingest([vital, { ...vital, name: 'CLS', value: 123 }, { ...vital, name: 'INP', rating: 'poor' }])).toBe(204);
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'ui.web_vital.lcp', value: 2500 }]);
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'ui.web_vital.cls', value: 123 }]);
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'ui.web_vital.inp', value: 2500 }]);
    expect(journal).toHaveBeenCalledWith('v2.web_telemetry', expect.objectContaining({ ui_event: 'web_vital', name: 'LCP', rating: 'good' }));
    // The fields never carry `event`: it would replace the journal name on the exported line.
    for (const [, fields] of vi.mocked(journal).mock.calls) expect(fields).not.toHaveProperty('event');
  });

  it('records a JavaScript error as ui.error and an error-level journal line carrying the tab session and conversation', async () => {
    expect(await ingest([failure], { 'X-Bob-Client-Session': SESSION, 'X-Bob-Conversation': CONVERSATION })).toBe(204);
    expect(recordObservationMetrics).toHaveBeenCalledWith([{ name: 'ui.error', value: 1 }]);
    expect(moduleJournal).toHaveBeenCalledWith('conversations', 'web');
    expect(journal).toHaveBeenCalledWith('v2.web_telemetry_error', expect.objectContaining({ ui_event: 'ui_error', error_name: 'TypeError', frame: 'index-Ab12.js:10:20', session_id: SESSION, conversation_id: CONVERSATION }));
    expect(traceSpan).toHaveBeenCalledWith('ui-error', expect.objectContaining({ sessionId: SESSION, conversationId: CONVERSATION, userId: USER_ID }), expect.any(Function));
  });

  it.each([
    ['an unknown vital', { ...vital, name: 'FID' }],
    ['a fractional value', { ...vital, value: 1.5 }],
    ['an unbounded value', { ...vital, value: 120001 }],
    ['an unknown rating', { ...vital, rating: 'ok' }],
    ['an extra field', { ...vital, url: '/c/private' }],
    ['a route that is not a template', { ...vital, route: '/c/private-id' }],
    ['an error message', { ...failure, message: 'private' }],
    ['an error name with punctuation', { ...failure, error_name: 'Error: private message' }],
    ['an oversized error name', { ...failure, error_name: 'A'.repeat(41) }],
    ['a frame holding a URL', { ...failure, frame: 'https://app.example/index.js?token=1:1:1' }],
    ['a frame holding a path', { ...failure, frame: '/assets/index.js:1:1' }],
    ['an unknown error kind', { ...failure, kind: 'warning' }],
  ])('rejects %s', async (_label, event) => {
    expect(await ingest([event])).toBe(400);
    expect(journal).not.toHaveBeenCalled();
  });

  it('accepts first-load navigation timings and rejects out-of-range ones', async () => {
    const navigation = { ...base, event: 'ui_navigation', dom_content_loaded_ms: 800, load_ms: 1500, ttfb_ms: 120 };
    expect(await ingest([navigation])).toBe(204);
    expect(await ingest([{ ...navigation, load_ms: 120001 }])).toBe(400);
  });

  it('rejects web vitals and errors on the anonymous lane', async () => {
    for (const event of [vital, failure]) {
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), setHeader: vi.fn() };
      await anonymousTelemetryRoute({ body: { events: [{ ...event, page: 'signin', route: 'signin' }] }, socket: { remoteAddress: '192.0.2.77' } } as Request, response as unknown as Response);
      expect(response.status.mock.calls[0]?.[0]).toBe(400);
    }
  });
});
