import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordObservationMetrics, recordTraceSignal, traceSpan } from '@bob/ai';
import { anonymousTelemetryRoute, telemetryRoute } from '../../src/platform/observability/telemetry.ts';
import { journal, moduleJournal } from '../../src/platform/logger.ts';
import { AnonymousTelemetryRequestSchema } from '../../src/platform/observability/schemas.ts';

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
const navigation = { event: 'ui_navigation', page: 'chat', view_id: VIEW_ID, duration_ms: 120 };

async function ingest(events: unknown[], userId: string | null = USER_ID): Promise<number> {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), setHeader: vi.fn() };
  const request = {
    body: { events },
    ...(userId === null ? {} : { account: { userId } }),
  };
  await telemetryRoute(request as Request, response as unknown as Response);
  return response.status.mock.calls[0]?.[0] as number;
}

async function anonymousIngest(events: unknown[], ip = '192.0.2.10'): Promise<{ status: number; drops: string | undefined }> {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn(), setHeader: vi.fn() };
  await anonymousTelemetryRoute({ body: { events }, socket: { remoteAddress: ip } } as Request, response as unknown as Response);
  return { status: response.status.mock.calls[0]?.[0] as number, drops: response.setHeader.mock.calls[0]?.[1] as string | undefined };
}

/** An event as the journal records it: the browser's `event` kind travels as `ui_event`. */
const journaled = ({ event, ...rest }: { event: string }): Record<string, unknown> => ({ ...rest, ui_event: event });

describe('UI telemetry ingestion', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('accepts bounded app page templates and rejects customer app identifiers', async () => {
    expect(await ingest([{ ...navigation, page: 'apps', route: '/apps/:appId' }])).toBe(204);
    expect(await ingest([{ ...navigation, page: 'apps', route: '/apps/private-app' }])).toBe(400);
    expect(await ingest([{ ...navigation, page: 'apps', appId: 'private-app' }])).toBe(400);
  });

  it('names allowlisted actions and joins their request outcomes under an account-owned workflow', async () => {
    const action = 'app.app.session-gate.button.back-to-home.click';
    const action_id = '77777777-7777-4777-8777-777777777777';
    const event = { ...navigation, event: 'ui_action', route: '/', action, action_id, trigger: 'onClick', stage: 'complete', outcome: 'returned' };
    expect(await ingest([event])).toBe(204);
    expect(traceSpan).toHaveBeenCalledWith(`ui-action ${action} complete`, expect.objectContaining({ workflowNamespace: `ui-action/${USER_ID}`, workflowId: action_id }), expect.any(Function));
    expect(recordObservationMetrics).toHaveBeenCalledWith([
      { name: 'ui.action.duration_ms', value: 120, attributes: { outcome: 'returned' } }, { name: 'ui.action.failed', value: 0 }, { name: 'ui.action.aborted', value: 0 },
    ]);
    vi.clearAllMocks();
    expect(await ingest([{ ...event, stage: 'start', outcome: undefined }])).toBe(204);
    expect(recordObservationMetrics).not.toHaveBeenCalled();
    expect(await ingest([{ ...event, action: 'private-action' }])).toBe(400);
    expect(await ingest([{ ...event, trigger: 'private-trigger' }])).toBe(400);
    expect(await ingest([{ ...event, route: '/c/private-id' }])).toBe(400);
  });

  it.each([
    [{ page: 'chat' }, 'conversations'], [{ page: 'spaces' }, 'spaces'], [{ page: 'calendar' }, 'calendar'],
    [{ page: 'memory' }, 'memory'], [{ page: 'devices' }, 'devices'], [{ page: 'pair' }, 'devices'],
    [{ page: 'usage' }, 'account'], [{ page: 'metrics' }, 'platform'], [{ page: 'gmail' }, 'google'],
    [{ page: 'connectors' }, 'google'], [{ page: 'other' }, 'other'],
    [{ area: 'voice' }, 'voice'], [{ area: 'productivity' }, 'tasks'], [{ area: 'notifications' }, 'notifications'],
    [{ area: 'chat', page: 'other' }, 'conversations'],
  ])('journals v2.web_telemetry as source web with the module mapped from %j (%s)', async (where, module) => {
    const event = { ...navigation, ...where, ...('area' in where ? { event: 'ui_request', method: 'GET', status: 200, outcome: 'ok' } : {}) };
    expect(await ingest([event])).toBe(204);
    expect(moduleJournal).toHaveBeenCalledWith(module, 'web');
    expect(journal).toHaveBeenCalledWith('v2.web_telemetry', expect.objectContaining({ ui_event: event.event }));
  });

  it.each([
    [{ event: 'reply_feedback', trace_id: 'a'.repeat(32), positive: true }, 'conversations'],
    [{ event: 'turn_timing', eos_to_first_audio_ms: 420 }, 'voice'],
  ])('journals page-less %j in the module its event name maps to (%s)', async (event, module) => {
    expect(await ingest([event])).toBe(204);
    expect(moduleJournal).toHaveBeenCalledWith(module, 'web');
  });

  it('tags anonymous sign-in events as web telemetry in the account module', async () => {
    expect((await anonymousIngest([{ ...navigation, page: 'signin', route: 'signin' }])).status).toBe(204);
    expect(moduleJournal).toHaveBeenCalledWith('account', 'web');
  });

  it('keeps a normalized request endpoint in its observation name, rejects raw identifiers and preserves UUID joins', async () => {
    const event = { ...navigation, event: 'ui_request', area: 'productivity', endpoint: '/api/tasks/:id', method: 'PATCH', status: 200, outcome: 'ok', request_id: VIEW_ID, action_id: VIEW_ID };
    expect(await ingest([event])).toBe(204);
    expect(traceSpan).toHaveBeenCalledWith('ui-request PATCH /api/tasks/:id', expect.objectContaining({ workflowNamespace: `ui-action/${USER_ID}`, workflowId: VIEW_ID }), expect.any(Function));
    expect(await ingest([{ ...event, endpoint: '/api/tasks/private-id' }])).toBe(400);
  });

  it('journals a ui_request trace id as request_trace_id, keeping trace_id for the logger', async () => {
    const trace_id = '0af7651916cd43dd8448eb211c80319c';
    const event = { ...navigation, event: 'ui_request', area: 'chat', method: 'GET', status: 200, outcome: 'ok', trace_id };
    expect(await ingest([event])).toBe(204);
    const fields = vi.mocked(journal).mock.calls.find(([name]) => name === 'v2.web_telemetry')?.[1];
    expect(fields).toMatchObject({ ui_event: 'ui_request', request_trace_id: trace_id });
    expect(fields).not.toHaveProperty('trace_id');
  });

  it('accepts anonymous auth failures without accepting account identity, arbitrary actions or private metadata', async () => {
    const event = { event: 'ui_auth', view_id: VIEW_ID, operation: 'signInWithPassword', outcome: 'error', duration_ms: 42 };
    expect((await anonymousIngest([event])).status).toBe(204);
    expect(traceSpan).toHaveBeenCalledWith('ui-auth signInWithPassword', expect.objectContaining({ workflowNamespace: `ui-anonymous/${VIEW_ID}`, metadata: expect.objectContaining({ auth_state: 'anonymous', outcome: 'error' }) }), expect.any(Function));
    expect(vi.mocked(traceSpan).mock.calls[0]?.[1]).not.toHaveProperty('userId');
    expect(recordObservationMetrics).toHaveBeenCalledWith([
      { name: 'ui.auth.duration_ms', value: 42 }, { name: 'ui.auth.failed', value: 1 }, { name: 'ui.auth.aborted', value: 0 },
    ]);
    for (const fields of [{ userId: USER_ID }, { user_id: USER_ID }, { password: 'private' }, { page: 'account' }, { operation: 'private' }]) {
      expect((await anonymousIngest([{ ...event, ...fields }])).status).toBe(400);
    }
    expect((await anonymousIngest([navigation])).status).toBe(400);
    expect((await anonymousIngest([{ ...navigation, page: 'signin', route: 'signin' }])).status).toBe(204);
    expect((await anonymousIngest(Array.from({ length: 11 }, () => event))).status).toBe(400);
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toMatch(/192\.0\.2|private|22222222/);
  });

  it('bounds anonymous traffic per IP and reports dropped detail instead of claiming collection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const event = { ...navigation, page: 'signin', route: 'signin' };
    const batch = Array.from({ length: 10 }, () => event);
    for (let i = 0; i < 12; i++) expect((await anonymousIngest(batch, '192.0.2.40')).status).toBe(204);
    expect(await anonymousIngest(batch, '192.0.2.40')).toEqual({ status: 204, drops: '10' });
    for (let i = 0; i < 7; i++) await anonymousIngest([event], '192.0.2.40');
    expect((await anonymousIngest([event], '192.0.2.40')).status).toBe(429);
    expect((await anonymousIngest([event], '192.0.2.41')).status).toBe(204);
  });

  it('accepts a mixed authentication-page summary without broadening anonymous action or navigation pages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const event = { ...navigation, event: 'ui_metrics_window', page: 'other', route: '/reset',
      requests_ok: 0, requests_error: 0, requests_aborted: 0, events_observed: 2, events_accepted: 2,
      events_dropped: 0, batches_failed: 0, timing_overflow: 0, server_dropped: 0 };
    expect((await anonymousIngest([event], '192.0.2.42')).status).toBe(204);
    expect((await anonymousIngest([{ ...event, route: '/account' }], '192.0.2.42')).status).toBe(400);
    expect((await anonymousIngest([{ ...navigation, page: 'other', route: '/reset' }], '192.0.2.42')).status).toBe(400);
  });

  it('exports measured request latency and separate failure/cancellation samples', async () => {
    await ingest([{ ...navigation, event: 'ui_request', area: 'chat', method: 'GET', status: 0, outcome: 'aborted' }]);
    expect(recordObservationMetrics).toHaveBeenCalledWith([
      { name: 'ui.request.duration_ms', value: 120 },
      { name: 'ui.request.failed', value: 0 },
      { name: 'ui.request.aborted', value: 1 },
    ]);
  });

  it('accepts bounded pre-sampling window counts without turning window duration into request latency', async () => {
    const window = { ...navigation, event: 'ui_metrics_window', page: 'other',
      requests_ok: 20, requests_error: 2, requests_aborted: 1,
      events_observed: 200, events_accepted: 100, events_dropped: 100,
      batches_failed: 1, timing_overflow: 2 };
    expect(await ingest([window])).toBe(204);
    expect(recordObservationMetrics).toHaveBeenCalledWith(expect.arrayContaining([
      { name: 'ui.window.requests_ok', value: 20 },
      { name: 'ui.window.requests_error', value: 2 },
      { name: 'ui.window.events_dropped', value: 100 },
    ]));
    expect(JSON.stringify(vi.mocked(recordObservationMetrics).mock.calls)).not.toContain('ui.request.duration_ms');
    vi.clearAllMocks();
    expect(await ingest([{ ...window, requests_ok: 1_000_001 }])).toBe(400);
    expect(await ingest([{ ...window, requests_error: -1 }])).toBe(400);
    expect(await ingest([{ ...window, url: 'private-marker' }])).toBe(400);
    expect(recordObservationMetrics).not.toHaveBeenCalled();
  });

  it('journals navigation and exports a metadata-only account-scoped view observation', async () => {
    expect(await ingest([navigation])).toBe(204);
    expect(journal).toHaveBeenCalledWith('v2.web_telemetry', expect.objectContaining(journaled(navigation)));
    expect(traceSpan).toHaveBeenCalledWith('ui-navigation', expect.objectContaining({
      detached: true,
      workflowNamespace: `ui-view/${USER_ID}`,
      workflowId: VIEW_ID,
      tags: ['web'],
      metadata: {
        event: 'ui_navigation', page: 'chat', view_id: VIEW_ID,
        browser_duration_ms: '120', timing_source: 'browser',
      },
    }), expect.any(Function));
  });

  it('exports bounded interactions, React commits and first-party request summaries', async () => {
    const events = [
      { ...navigation, event: 'ui_interaction', target: 'button' },
      { ...navigation, event: 'ui_render', phase: 'nested-update' },
      { ...navigation, event: 'ui_request', area: 'voice', method: 'POST', status: 503, outcome: 'error' },
    ];
    expect(await ingest(events)).toBe(204);
    expect(vi.mocked(traceSpan).mock.calls.map(([name]) => name)).toEqual(['ui-interaction', 'ui-render', 'ui-request']);
    expect(vi.mocked(traceSpan).mock.calls[2]?.[1].metadata).toMatchObject({
      area: 'voice', method: 'POST', status: '503', outcome: 'error',
    });
  });

  it('attributes every exported UI span to the authenticated caller, never a browser-supplied id', async () => {
    expect(await ingest([navigation, { ...navigation, event: 'ui_interaction', target: 'button' }])).toBe(204);
    expect(vi.mocked(traceSpan).mock.calls.map(([, attrs]) => attrs.userId)).toEqual([USER_ID, USER_ID]);
    vi.clearAllMocks();
    for (const key of ['userId', 'user_id']) {
      expect(await ingest([{ ...navigation, [key]: '99999999-9999-4999-8999-999999999999' }])).toBe(400);
    }
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it('requires an authenticated account before accepting telemetry', async () => {
    expect(await ingest([navigation], null)).toBe(401);
    expect(journal).not.toHaveBeenCalled();
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it('preserves summary counters when the detail budget is exhausted and bounds summaries separately', async () => {
    const account = '66666666-6666-4666-8666-666666666666';
    const batch = Array.from({ length: 20 }, () => navigation);
    for (let i = 0; i < 6; i += 1) await ingest(batch, account);
    vi.clearAllMocks();
    const summary = { ...navigation, event: 'ui_metrics_window', page: 'other',
      requests_ok: 1, requests_error: 0, requests_aborted: 0,
      events_observed: 1, events_accepted: 0, events_dropped: 1,
      batches_failed: 0, timing_overflow: 0 };
    await ingest([navigation, summary], account);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    expect(recordObservationMetrics).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i += 1) await ingest([summary], account);
    expect(recordObservationMetrics).toHaveBeenCalledTimes(30);
  });

  it('keeps journaling and accepting the batch if trace export fails', async () => {
    vi.mocked(traceSpan).mockRejectedValueOnce(new Error('secret exception detail'));
    expect(await ingest([navigation, navigation])).toBe(204);
    expect(journal).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain('secret exception detail');
  });

  it('never combines two accounts even when their browser view ids match', async () => {
    await ingest([navigation]);
    await ingest([navigation], '33333333-3333-4333-8333-333333333333');
    const attrs = vi.mocked(traceSpan).mock.calls.map((call) => call[1]);
    expect(attrs[0]?.workflowNamespace).not.toBe(attrs[1]?.workflowNamespace);
    expect(attrs[0]?.workflowId).toBe(attrs[1]?.workflowId);
  });

  it.each(['url', 'text', 'value', 'body', 'headers', 'token', 'component', 'selector'])('rejects private field %s instead of exporting it', async (key) => {
    expect(await ingest([{ ...navigation, [key]: 'private-marker' }])).toBe(400);
    expect(journal).not.toHaveBeenCalled();
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it.each([
    { page: '/chat/private' }, { view_id: 'not-a-uuid' }, { duration_ms: -1 },
    { duration_ms: 120001 }, { duration_ms: 0.5 },
    { event: 'ui_interaction', target: 'user text' },
    { event: 'ui_render', phase: 'private-component' },
    { event: 'ui_request', area: 'voice', method: 'POST', status: 600, outcome: 'ok' },
    { event: 'ui_request', area: 'voice', method: 'POST', status: 200.1, outcome: 'ok' },
    { event: 'ui_request', area: 'voice', method: 'SECRET', status: 200, outcome: 'ok' },
    { event: 'ui_request', area: 'private-area', method: 'GET', status: 200, outcome: 'ok' },
    { event: 'ui_request', area: 'voice', method: 'GET', status: 200, outcome: 'private-error' },
  ])('rejects invalid dimensions: %j', async (fields) => {
    expect(await ingest([{ ...navigation, ...fields }])).toBe(400);
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it('retains the existing 20-event batch limit', async () => {
    expect(await ingest(Array.from({ length: 21 }, () => navigation))).toBe(400);
    expect(traceSpan).not.toHaveBeenCalled();
  });

  it('caps each account at 120 UI events, preserves voice events and refills at two per second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
    const limitedAccount = '44444444-4444-4444-8444-444444444444';
    const otherAccount = '55555555-5555-4555-8555-555555555555';
    const batch = Array.from({ length: 20 }, () => navigation);
    for (let i = 0; i < 6; i += 1) expect(await ingest(batch, limitedAccount)).toBe(204);
    expect(traceSpan).toHaveBeenCalledTimes(120);
    expect(journal).toHaveBeenCalledTimes(120);
    vi.clearAllMocks();
    expect(await ingest([navigation], limitedAccount)).toBe(204);
    expect(traceSpan).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();

    expect(await ingest([navigation], otherAccount)).toBe(204);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    const voiceEvent = { event: 'turn_timing', eos_to_first_audio_ms: 100 };
    expect(await ingest([navigation, voiceEvent], limitedAccount)).toBe(204);
    expect(journal).toHaveBeenCalledTimes(2);
    expect(journal).toHaveBeenLastCalledWith('v2.web_telemetry', expect.objectContaining(journaled(voiceEvent)));
    expect(traceSpan).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(499);
    await ingest([navigation], limitedAccount);
    expect(traceSpan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await ingest([navigation, navigation], limitedAccount);
    expect(traceSpan).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    await ingest(batch, limitedAccount);
    expect(traceSpan).toHaveBeenCalledTimes(22);
  });

  describe('browser signals joined to a server trace', () => {
    const trace_id = '0af7651916cd43dd8448eb211c80319c';

    it.each([[true, 1], [false, 0]])('records reply_feedback positive=%s as user.feedback %i and journals it', async (positive, value) => {
      expect(await ingest([{ event: 'reply_feedback', trace_id, positive }])).toBe(204);
      expect(recordTraceSignal).toHaveBeenCalledExactlyOnceWith(trace_id, 'user.feedback', value);
      const fields = vi.mocked(journal).mock.calls.find(([name]) => name === 'v2.web_telemetry')?.[1];
      expect(fields).toMatchObject({ ui_event: 'reply_feedback', positive, request_trace_id: trace_id });
      expect(fields).not.toHaveProperty('trace_id');
      expect(traceSpan).not.toHaveBeenCalled();
    });

    it('rejects malformed or unauthenticated reply_feedback and any client text', async () => {
      const valid = { event: 'reply_feedback', trace_id, positive: true };
      for (const bad of [
        { ...valid, trace_id: 'ABC' }, { ...valid, trace_id: undefined }, { ...valid, positive: 'yes' },
        { ...valid, comment: 'private-comment' }, { event: 'reply_feedback', trace_id },
      ]) expect(await ingest([bad])).toBe(400);
      expect(await ingest([valid], null)).toBe(401);
      expect(AnonymousTelemetryRequestSchema.safeParse({ events: [valid] }).success).toBe(false);
      expect(recordTraceSignal).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(journal).mock.calls)).not.toContain('private-comment');
    });

    it('attaches turn_timing to its trace only when a valid trace id rides along', async () => {
      const timing = { event: 'turn_timing', eos_to_first_audio_ms: 840, stt_ms: 120 };
      expect(await ingest([timing])).toBe(204);
      expect(recordTraceSignal).not.toHaveBeenCalled();
      expect(await ingest([{ ...timing, trace_id }])).toBe(204);
      expect(recordTraceSignal).toHaveBeenCalledExactlyOnceWith(trace_id, 'voice.eos_to_first_audio_ms', 840);
      expect(vi.mocked(journal).mock.calls.at(-1)?.[1]).toMatchObject({ request_trace_id: trace_id, eos_to_first_audio_ms: 840 });
      expect(await ingest([{ ...timing, trace_id: 'not-a-trace-id' }])).toBe(400);
      expect(recordTraceSignal).toHaveBeenCalledTimes(1);
    });
  });
});
