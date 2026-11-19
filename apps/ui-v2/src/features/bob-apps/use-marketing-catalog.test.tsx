import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useMarketingCatalog } from './use-marketing-catalog';
import { marketingCatalog } from './marketing-api';
vi.mock('./marketing-api', () => ({ marketingCatalog: vi.fn() }));
it('hides the previous owners catalog immediately when account identity changes', async () => {
  vi.mocked(marketingCatalog).mockResolvedValueOnce({ package: { name: 'First owner catalog' }, installations: [] } as never).mockImplementationOnce(() => new Promise(() => {}));
  const { result, rerender } = renderHook(({ userId }) => useMarketingCatalog(userId), { initialProps: { userId: 'first-owner' } });
  await waitFor(() => expect(result.current.data).not.toBeNull());
  rerender({ userId: 'second-owner' });
  expect(result.current.data).toBeNull();
});
