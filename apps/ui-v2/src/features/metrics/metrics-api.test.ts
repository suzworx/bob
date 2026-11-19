import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

import { fetchOperatorMetrics, probeOperatorAccess } from './metrics-api';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('fetchOperatorMetrics', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it('asks for the page and range and returns the document', async () => {
    const doc = { backlog: 0 };
    fetchWithAuth.mockResolvedValue(respond(200, doc));
    await expect(fetchOperatorMetrics('platform', '30d')).resolves.toEqual(doc);
    const path = String(fetchWithAuth.mock.calls[0]?.[0]);
    expect(path).toContain('/api/operator/metrics/platform');
    expect(path).toContain('range=30d');
  });

  it.each(['ai', 'devices', 'features'] as const)('requests the %s page path', async (page) => {
    fetchWithAuth.mockResolvedValue(respond(200, { turns: 1 }));
    await fetchOperatorMetrics(page, '24h');
    expect(String(fetchWithAuth.mock.calls[0]?.[0])).toBe(`/api/operator/metrics/${page}?range=24h`);
  });

  it('throws metrics_failed on a non-ok response', async () => {
    fetchWithAuth.mockResolvedValue(respond(500, { error: { code: 'store_error' } }));
    await expect(fetchOperatorMetrics('usage', '7d')).rejects.toThrow('metrics_failed');
  });
});

describe('probeOperatorAccess', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it('is true on 204', async () => {
    fetchWithAuth.mockResolvedValue(respond(204));
    await expect(probeOperatorAccess()).resolves.toBe(true);
    expect(String(fetchWithAuth.mock.calls[0]?.[0])).toBe('/api/operator/access');
  });

  it('is false on 404', async () => {
    fetchWithAuth.mockResolvedValue(respond(404, { error: { code: 'not_found' } }));
    await expect(probeOperatorAccess()).resolves.toBe(false);
  });

  it('throws on anything else', async () => {
    fetchWithAuth.mockResolvedValue(respond(500));
    await expect(probeOperatorAccess()).rejects.toThrow();
  });
});
