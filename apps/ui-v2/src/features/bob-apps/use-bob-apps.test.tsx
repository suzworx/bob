import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppRequestError, getApp, listApps } from './bob-apps-api';
import { useBobApps } from './use-bob-apps';

vi.mock('./bob-apps-api', async (original) => ({
  ...(await original<typeof import('./bob-apps-api')>()),
  getApp: vi.fn(),
  listApps: vi.fn(async () => ({ apps: [], nextCursor: null })),
}));
afterEach(cleanup);

it('tells someone opening an app they cannot see that it is not here, without saying whose it is (#1423)', async () => {
  vi.mocked(getApp).mockRejectedValue(new AppRequestError(404));
  const { result } = renderHook(() => useBobApps('05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10'));
  await waitFor(() => expect(result.current.error).toBe('This app isn\u2019t here. It may be private to someone else, or it may have been deleted.'));
  expect(listApps).toHaveBeenCalled();
});

it('keeps the try-again message for any other failure', async () => {
  vi.mocked(getApp).mockRejectedValue(new AppRequestError(500));
  const { result } = renderHook(() => useBobApps('05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10'));
  await waitFor(() => expect(result.current.error).toBe('Couldn\u2019t open your apps. Please try again.'));
});
