import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoice } from './use-voice';
import { fetchWithAuth } from '../../lib/auth/use-session';

vi.mock('../../lib/auth/use-session', () => ({ fetchWithAuth: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe('voice workflow transport', () => {
  it('carries one execution id through transcription and both speech paths and accepts the server trace id', async () => {
    const workflowId = '11111111-1111-4111-8111-111111111111';
    const traceId = 'a'.repeat(32);
    const onTrace = vi.fn();
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello' }), {
      headers: { 'X-Bob-Trace-Id': traceId, 'content-type': 'application/json' },
    })).mockResolvedValueOnce(new Response('audio')).mockResolvedValueOnce(new Response('audio'));
    URL.createObjectURL = vi.fn(() => 'blob:voice');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useVoice());
    const clip = { size: 1, type: 'audio/webm', arrayBuffer: async () => new Uint8Array([1]).buffer } as Blob;
    await act(async () => {
      expect(await result.current.transcribe(clip, { workflowId, onTrace })).toBe('hello');
      await result.current.speak('hello', workflowId);
      await result.current.synthesize('hello', new AbortController().signal, workflowId);
    });
    expect(onTrace).toHaveBeenCalledWith(traceId);
    expect(vi.mocked(fetchWithAuth).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).workflowId)).toEqual([workflowId, workflowId, workflowId]);
  });
});

// #1041: a spent AI budget answers the voice routes 503 out_of_credit, as chat does.
describe('voice on a spent AI budget', () => {
  const outOfCredit = (): Response => new Response(
    JSON.stringify({ error: { code: 'out_of_credit', message: 'The AI service is out of credit.' } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
  const clip = { size: 1, type: 'audio/webm', arrayBuffer: async () => new Uint8Array([1]).buffer } as Blob;

  it('names out_of_credit for transcription, a spoken reply and a hands-free sentence', async () => {
    vi.mocked(fetchWithAuth).mockReset()
      .mockResolvedValueOnce(outOfCredit())
      .mockResolvedValueOnce(outOfCredit())
      .mockResolvedValueOnce(outOfCredit());
    const { result } = renderHook(() => useVoice());
    await act(async () => {
      expect(await result.current.transcribe(clip)).toBeNull();
    });
    expect(result.current.error).toBe('out_of_credit');
    act(() => result.current.clearError());
    await act(async () => {
      await result.current.speak('hello');
    });
    expect(result.current.error).toBe('out_of_credit');
    await expect(result.current.synthesize('hello', new AbortController().signal)).rejects.toThrow('out_of_credit');
  });

  it('keeps upload for any other failed transcription', async () => {
    vi.mocked(fetchWithAuth).mockReset().mockResolvedValueOnce(new Response('{}', { status: 502 }));
    const { result } = renderHook(() => useVoice());
    await act(async () => {
      expect(await result.current.transcribe(clip)).toBeNull();
    });
    expect(result.current.error).toBe('upload');
  });
});
