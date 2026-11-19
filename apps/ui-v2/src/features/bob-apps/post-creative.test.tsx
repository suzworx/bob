import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostCreative } from './post-creative';
import * as renderer from './post-creative-render';

vi.mock('./post-creative-render', async (original) => ({
  ...(await original<typeof renderer>()),
  loadCreativeArt: vi.fn(),
  paintCreative: vi.fn(),
  canvasToPngFile: vi.fn(),
  downloadFile: vi.fn(),
}));

const png = new File(['png'], 'bob-instagram.png', { type: 'image/png' });
const props = { text: 'Hello from Bob', channel: 'instagram', artUrl: '/brand/bob/bob-helper.webp' } as const;

function stubShare(share: unknown, canShare: unknown): void {
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
}

const dialogMethods = ['showModal', 'close'] as const;
const originalMethods = dialogMethods.map((name) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => { dialogMethods.forEach((name, index) => { const original = originalMethods[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); }); });

describe('PostCreative', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:creative');
    URL.revokeObjectURL = vi.fn();
    vi.mocked(renderer.loadCreativeArt).mockResolvedValue(new Image());
    vi.mocked(renderer.canvasToPngFile).mockResolvedValue(png);
  });
  afterEach(() => { stubShare(undefined, undefined); vi.clearAllMocks(); });

  it('downloads where the browser cannot share files', async () => {
    render(<PostCreative {...props} />);
    const button = await screen.findByRole('button', { name: 'Download image' });
    await waitFor(() => expect(renderer.canvasToPngFile).toHaveBeenCalled());
    await waitFor(() => expect(button.getAttribute('aria-busy')).not.toBe('true'));
    await userEvent.click(button);
    expect(renderer.downloadFile).toHaveBeenCalledWith(png);
    expect(screen.getByRole('img').getAttribute('alt')).toContain('Hello from Bob');
  });

  it('shares the finished file where it can, and a closed sheet is not an error', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('closed', 'AbortError')));
    stubShare(share, () => true);
    render(<PostCreative {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Share image' }));
    expect(share).toHaveBeenCalledWith({ files: [png] });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Share image' })).toBeTruthy();
  });

  it('offers download when sharing fails', async () => {
    stubShare(() => Promise.reject(new DOMException('no', 'NotAllowedError')), () => true);
    render(<PostCreative {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Share image' }));
    expect(await screen.findByRole('button', { name: 'Download image' })).toBeTruthy();
    expect(screen.getByText("Sharing didn't work here")).toBeTruthy();
  });

  it('shows a kind error when drawing fails (tainted canvas), and Try again recovers', async () => {
    vi.mocked(renderer.canvasToPngFile).mockRejectedValueOnce(new DOMException('tainted', 'SecurityError'));
    render(<PostCreative {...props} />);
    expect(await screen.findByText("Bob couldn't draw this image")).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(screen.queryByText("Bob couldn't draw this image")).toBeNull();
  });

  it('opens the full image from a compact preview and releases its URL on unmount', async () => {
    const { unmount } = render(<PostCreative {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: /^Open Preview image/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(URL.createObjectURL).toHaveBeenCalledWith(png);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:creative');
  });

  it('redraws for a new post', async () => {
    const { rerender } = render(<PostCreative {...props} />);
    await waitFor(() => expect(renderer.paintCreative).toHaveBeenCalledTimes(1));
    rerender(<PostCreative {...props} text="Another post" />);
    await waitFor(() => expect(renderer.paintCreative).toHaveBeenLastCalledWith(expect.anything(), 'instagram', 'Another post', expect.anything()));
  });

  it('discards a late previous-post render instead of offering the wrong file', async () => {
    let finishOld: ((file: File) => void) | undefined;
    vi.mocked(renderer.canvasToPngFile).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const next = new File(['next'], 'next.png', { type: 'image/png' });
    vi.mocked(renderer.canvasToPngFile).mockResolvedValueOnce(next);
    const { rerender } = render(<PostCreative {...props} />);
    await waitFor(() => expect(renderer.canvasToPngFile).toHaveBeenCalledTimes(1));
    rerender(<PostCreative {...props} text="Another post" />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(next));
    await act(async () => { finishOld?.(png); });
    await userEvent.click(screen.getByRole('button', { name: 'Download image' }));
    expect(renderer.downloadFile).toHaveBeenCalledWith(next);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]?.[0]).toBe(next);
  });
});
