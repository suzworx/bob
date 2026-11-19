import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AppViewImage } from './app-view-image';
import { AppRenderer } from './app-renderer';
import { starterApp } from './app-starters';
import { AppRequestError, getApp, exportApp, type BobApp } from './bob-apps-api';
import { captureAppViewImage, ImageCaptureError } from './app-view-image-capture';

const appearance = vi.hoisted(() => ({ id: 'light' }));
vi.mock('@/app/theme-choice', () => ({ useActiveTheme: () => ({ id: appearance.id }) }));
vi.mock('./bob-apps-api', async (original) => ({ ...await original<typeof import('./bob-apps-api')>(), getApp: vi.fn(), exportApp: vi.fn() }));
vi.mock('./app-view-image-capture', async (original) => ({ ...await original<typeof import('./app-view-image-capture')>(), captureAppViewImage: vi.fn() }));
const app: BobApp = { id: 'app', installationId: 'installation', spaceId: null, canManage: true, revision: 3, lifecycle: 'active', createdAt: 1, updatedAt: 1, definition: starterApp('budget'), state: { items: [{ id: 'lunch', values: { title: 'Saved lunch', amount: 12 } }] }, metrics: { items: 1, total: 12 }, pendingDefinition: null, canUndo: true };
const selection = { viewId: 'slides', slideIndex: 1 };
const captured = { blob: new Blob(['png'], { type: 'image/png' }), width: 800, height: 600 };
const dialogMethods = ['showModal', 'close'] as const;
const originalMethods = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => { dialogMethods.forEach((name, index) => { const original = originalMethods[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); }); });
beforeEach(() => {
  appearance.id = 'light';
  vi.mocked(getApp).mockReset().mockResolvedValue(app);
  vi.mocked(captureAppViewImage).mockReset().mockResolvedValue(captured);
  vi.mocked(exportApp).mockReset().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => 'blob:prepared');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders only the actual selected slide as read-only image content with no navigation or record commands', () => {
  render(<AppRenderer definition={app.definition} state={app.state} metrics={app.metrics} selection={selection} presentation="image" />);
  expect(screen.getByRole('heading', { name: 'Next steps' })).toBeTruthy();
  expect(screen.queryByText('Saved lunch')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
});

it('reports the resolved fallback view and clamps a stale slide index to the displayed slide', () => {
  const changed = vi.fn();
  const { rerender } = render(<AppRenderer definition={app.definition} state={app.state} metrics={app.metrics} selection={{ viewId: 'removed-view' }} onSelectionChange={changed} presentation="image" />);
  expect(screen.getByRole('heading', { name: 'Expenses' })).toBeTruthy();
  expect(changed).toHaveBeenLastCalledWith({ viewId: 'records' });
  rerender(<AppRenderer definition={app.definition} state={app.state} metrics={app.metrics} selection={{ viewId: 'slides', slideIndex: 99 }} onSelectionChange={changed} presentation="image" />);
  expect(screen.getByRole('heading', { name: 'Next steps' })).toBeTruthy();
  expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
  expect(changed).toHaveBeenLastCalledWith({ viewId: 'slides', slideIndex: 1 });
});

it('checks current access before capture and again before exposing a prepared file', async () => {
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await waitFor(() => expect(getApp).toHaveBeenCalledTimes(2));
  const region = screen.getByRole('region', { name: 'Saved view image preview' });
  expect(captureAppViewImage).toHaveBeenCalledWith(region, { signal: expect.any(AbortSignal) });
  expect(vi.mocked(getApp).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(captureAppViewImage).mock.invocationCallOrder[0] ?? 0);
  expect(vi.mocked(getApp).mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(captureAppViewImage).mock.invocationCallOrder[0] ?? 0);
  expect(within(region).getByRole('heading', { name: 'Next steps' })).toBeTruthy();
  expect(await screen.findByRole('img')).toBeTruthy();
});

it('does not capture or expose a file when the initial fresh read denies access', async () => {
  vi.mocked(getApp).mockRejectedValueOnce(new AppRequestError(403));
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  expect(await screen.findByText('Couldn’t prepare this image. Your app is safe. Reload this page before trying again.')).toBeTruthy();
  expect(captureAppViewImage).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('discards a completed capture when access is revoked by the final fresh read', async () => {
  vi.mocked(getApp).mockResolvedValueOnce(app).mockRejectedValueOnce(new AppRequestError(403));
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await waitFor(() => expect(getApp).toHaveBeenCalledTimes(2));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Download image' })).toBeNull();
});

it('aborts an old capture on revision change and ignores its late completion', async () => {
  let finish: ((value: typeof captured) => void) | undefined;
  vi.mocked(captureAppViewImage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await waitFor(() => expect(captureAppViewImage).toHaveBeenCalledOnce());
  const signal = vi.mocked(captureAppViewImage).mock.calls[0]?.[1]?.signal;
  rerender(<AppViewImage app={{ ...app, revision: 4 }} userId="owner" selection={selection} onClose={vi.fn()} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish?.(captured); });
  expect(getApp).toHaveBeenCalledTimes(1);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('aborts capture when the preview unmounts without publishing a late result', async () => {
  let finish: ((value: typeof captured) => void) | undefined;
  vi.mocked(captureAppViewImage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await waitFor(() => expect(captureAppViewImage).toHaveBeenCalledOnce());
  const signal = vi.mocked(captureAppViewImage).mock.calls[0]?.[1]?.signal;
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish?.(captured); });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('offers the existing complete JSON export when a whole view exceeds image bounds', async () => {
  vi.mocked(captureAppViewImage).mockRejectedValueOnce(new ImageCaptureError('too_large'));
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));
  expect(exportApp).toHaveBeenCalledWith(app);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('ends preparation and aborts a hung fresh read within the total eight-second deadline', async () => {
  vi.useFakeTimers();
  vi.mocked(getApp).mockImplementationOnce(() => new Promise(() => undefined));
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  expect(getApp).toHaveBeenCalledOnce();
  const signal = vi.mocked(getApp).mock.calls[0]?.[1];
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Prepare image' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByText('Couldn’t prepare this image. Your app is safe. Reload this page before trying again.')).toBeTruthy();
  expect(captureAppViewImage).not.toHaveBeenCalled();
});

it('rejects a saved revision that changes between capture and the final access read', async () => {
  vi.mocked(getApp).mockResolvedValueOnce(app).mockResolvedValueOnce({ ...app, revision: 4 });
  render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await screen.findByText('Couldn’t prepare this image. Your app is safe. Reload this page before trying again.');
  expect(captureAppViewImage).toHaveBeenCalledOnce();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each([
  { name: 'actor', userId: 'another-owner', changedApp: app, nextSelection: selection },
  { name: 'installation', userId: 'owner', changedApp: { ...app, installationId: 'another-installation' }, nextSelection: selection },
  { name: 'space', userId: 'owner', changedApp: { ...app, spaceId: 'another-space' }, nextSelection: selection },
  { name: 'slide', userId: 'owner', changedApp: app, nextSelection: { viewId: 'slides', slideIndex: 0 } },
])('drops prepared output immediately when its $name identity changes', async ({ userId, changedApp, nextSelection }) => {
  const { rerender } = render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await screen.findByRole('img');
  rerender(<AppViewImage app={changedApp} userId={userId} selection={nextSelection} onClose={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prepared');
  expect(getApp).toHaveBeenCalledTimes(2);
});

it('invalidates a prepared file when its measured preview width changes', async () => {
  let notifyResize: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  const { container } = render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await screen.findByRole('img');
  const preview = container.querySelector<HTMLElement>('[aria-label="Saved view image preview"]');
  if (!preview) throw new Error('preview missing');
  vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
  act(() => { notifyResize?.([], {} as ResizeObserver); });
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prepared');
});

it('releases prepared output when the active theme changes', async () => {
  const { rerender } = render(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare image' }));
  await screen.findByRole('img');
  appearance.id = 'dark';
  rerender(<AppViewImage app={app} userId="owner" selection={selection} onClose={vi.fn()} />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:prepared');
});
