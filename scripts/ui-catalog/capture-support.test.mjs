import { describe, expect, it, vi } from 'vitest';
import { ensureCaptureMemories } from './capture-support.mjs';

describe('catalog prerequisites', () => {
  it('creates both dialog prerequisites through the local idempotent memory API', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    await ensureCaptureMemories('http://localhost:7444', 'local-test', { API_URL: 'http://127.0.0.1:54321' }, request);
    expect(request.mock.calls.map(([, init]) => JSON.parse(init.body).kind)).toEqual(['fact', 'action_item']);
    expect(request.mock.calls.every(([url, init]) => url === 'http://localhost:7444/api/memories' && init.method === 'POST')).toBe(true);
  });
  it('refuses remote data before sending a request', async () => {
    const request = vi.fn();
    await expect(ensureCaptureMemories('https://api.heybob.xyz', 'unused', { API_URL: 'http://127.0.0.1:54321' }, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('reports a failed prerequisite instead of silently capturing an empty state', async () => {
    await expect(ensureCaptureMemories('http://localhost:7444', 'local-test', { API_URL: 'http://127.0.0.1:54321' }, vi.fn().mockResolvedValue({ ok: false, status: 503 }))).rejects.toThrow('503');
  });
});

