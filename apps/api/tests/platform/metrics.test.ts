/**
 * Bounded-label metrics registry tests (issue #145, S14-METRICS): the label
 * allowlist is enforced at runtime, identifiers are never label values, the
 * snapshot is numbers only, and cardinality stays bounded even when callers
 * pass random data. Follows the journal privacy/vocabulary scans' style.
 */
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/platform/observability/metrics.ts';

describe('metrics registry (S14-METRICS)', () => {
  it('increments a counter with an allowlisted label and shows it in the snapshot', () => {
    const metrics = createMetrics();
    metrics.counter('bob_commands_total', { operation: 'hello', status: 'ok' });
    metrics.counter('bob_commands_total', { operation: 'hello', status: 'ok' });
    metrics.counter('bob_commands_total', { operation: 'turn_start', status: 'refused' });
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['bob_commands_total{operation="hello",status="ok"}']).toBe(2);
    expect(snapshot.counters['bob_commands_total{operation="turn_start",status="refused"}']).toBe(1);
  });

  it('rejects a label value outside the allowlist in test mode', () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter('bob_commands_total', { operation: 'hello', status: 'improvising' }),
    ).toThrow(/not allowlisted/);
  });

  it('rejects a uuid as a label value', () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter('bob_commands_total', {
        operation: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        status: 'ok',
      }),
    ).toThrow(/not allowlisted/);
  });

  it('rejects an email as a label value', () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter('bob_commands_total', { operation: 'hello', status: 'owner@example.com' }),
    ).toThrow(/not allowlisted/);
  });

  it('rejects a URL as a label value', () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter('bob_commands_total', { operation: 'https://example.com/cb', status: 'ok' }),
    ).toThrow(/not allowlisted/);
  });

  it('rejects a token-shaped string as a label value', () => {
    const metrics = createMetrics();
    expect(() =>
      metrics.counter('bob_commands_total', { operation: 'olxd_abc123def456ghi', status: 'ok' }),
    ).toThrow(/not allowlisted/);
  });

  it('returns a snapshot with numbers only, never samples or last-value strings', () => {
    const metrics = createMetrics();
    metrics.counter('bob_commands_total', { operation: 'hello', status: 'ok' });
    metrics.observe('bob_provider_sync_lag_ms', 150, { provider: 'google', status: 'ok' });
    metrics.observe('bob_provider_sync_lag_ms', 350, { provider: 'google', status: 'ok' });
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['bob_commands_total{operation="hello",status="ok"}']).toBe(1);
    expect(snapshot.durations['bob_provider_sync_lag_ms{provider="google",status="ok"}']).toEqual({
      count: 2,
      total_ms: 500,
    });
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else if (node !== null && typeof node === 'object') {
        for (const value of Object.values(node)) walk(value);
      } else {
        expect(typeof node, `expected a number, got ${String(node)}`).toBe('number');
      }
    };
    walk(snapshot);
  });

  it('keeps cardinality bounded when callers pass random ids as label values', () => {
    const metrics = createMetrics({ strict: false });
    const statuses = ['ok', 'refused', 'failed'];
    for (let i = 0; i < 1000; i += 1) {
      metrics.counter('bob_commands_total', {
        operation: `id-${i}-${Math.random().toString(16).slice(2)}`,
        status: statuses[i % statuses.length]!,
      });
    }
    const snapshot = metrics.snapshot();
    const series = Object.keys(snapshot.counters).filter((key) => key.startsWith('bob_commands_total'));
    expect(series.length).toBeLessThanOrEqual(9 * 3);
    const total = Object.values(snapshot.counters).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(1000);
  });

  // A PR review on #174 found both of these. Each guards a way the registry
  // could record a series that can never be aggregated or trusted again.

  it('refuses a call that omits a declared label, so one metric keeps one shape', () => {
    const metrics = createMetrics();
    expect(() => metrics.counter('bob_commands_total', { status: 'ok' })).toThrow(
      /label operation was not supplied/,
    );
  });

  it('degrades a missing declared label to unknown in production rather than dropping it', () => {
    const metrics = createMetrics({ strict: false });
    metrics.counter('bob_commands_total', { status: 'ok' });
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['bob_commands_total{operation="unknown",status="ok"}']).toBe(1);
  });

  it('refuses a NaN duration, which would poison total_ms for the whole process', () => {
    const metrics = createMetrics();
    expect(() => metrics.observe('bob_provider_sync_lag_ms', Number.NaN, { provider: 'google', status: 'ok' })).toThrow(
      /finite, non-negative/,
    );
  });

  it('refuses an infinite or negative duration', () => {
    const metrics = createMetrics();
    expect(() => metrics.observe('bob_provider_sync_lag_ms', Number.POSITIVE_INFINITY, { provider: 'google', status: 'ok' })).toThrow(
      /finite, non-negative/,
    );
    expect(() => metrics.observe('bob_provider_sync_lag_ms', -1, { provider: 'google', status: 'ok' })).toThrow(/finite, non-negative/);
  });

  it('drops an impossible duration in production instead of recording it', () => {
    const metrics = createMetrics({ strict: false });
    metrics.observe('bob_provider_sync_lag_ms', Number.NaN, { provider: 'google', status: 'ok' });
    metrics.observe('bob_provider_sync_lag_ms', 120, { provider: 'google', status: 'ok' });
    const durations = metrics.snapshot().durations;
    const only = Object.values(durations)[0];
    expect(only?.count).toBe(1);
    expect(only?.total_ms).toBe(120);
  });
});