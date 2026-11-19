import { beforeEach, expect, it, vi } from 'vitest';
import { getTools, setTool } from './tools-api';
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
const response = { scope: { scope: 'account', scopeId: 'owner' }, canEdit: true, tools: [] };
beforeEach(() => fetchWithAuth.mockReset());
it('sends only scope selectors and validates the returned catalog', async () => {
  fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify(response)));
  expect(await getTools({ conversationId: 'cnv_one', integrationId: 'account-id' })).toEqual(response);
  expect(fetchWithAuth).toHaveBeenCalledWith('/api/tools?conversationId=cnv_one&integrationId=account-id', { signal: undefined });
  fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
  await expect(getTools({})).rejects.toThrow();
});
it('reset sends null and successful changes invalidate mention candidates', async () => {
  fetchWithAuth.mockResolvedValueOnce(new Response(JSON.stringify(response)));
  const changed = vi.fn();
  window.addEventListener('bob:tool-preferences-changed', changed);
  try {
    await setTool(response.scope as { scope: 'account'; scopeId: string }, 'create_task', null);
    expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body)).toEqual({ scope: 'account', scopeId: 'owner', toolId: 'create_task', enabled: null });
    expect(changed).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('bob:tool-preferences-changed', changed); }
});
