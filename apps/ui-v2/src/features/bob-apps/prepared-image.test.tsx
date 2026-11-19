import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreparedImage } from './prepared-image';

const first = new File(['first'], 'first.png', { type: 'image/png' });
const second = new File(['second'], 'second.png', { type: 'image/png' });
beforeEach(() => {
  URL.createObjectURL = vi.fn((file) => file === first ? 'blob:first' : 'blob:second');
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
});
afterEach(() => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
});

it('keeps the prepared preview read-only when expansion would nest another dialog', () => {
  render(<PreparedImage {...{ file: first, alt: 'Saved expenses', allowExpand: false }} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first');
  expect(screen.queryByRole('button', { name: /^Open Preview image/ })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('removes the previous preview immediately when its prepared file is cleared and releases its URL', () => {
  const { rerender } = render(<PreparedImage file={first} alt="Saved expenses" />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first');
  rerender(<PreparedImage file={null} alt="Saved expenses" />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
  expect(screen.queryByRole('button', { name: 'Share image' })).toBeNull();
});

it('resets a previous sharing failure when a different file becomes ready', async () => {
  const share = vi.fn().mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  const { rerender, unmount } = render(<PreparedImage file={first} alt="First view" />);
  fireEvent.click(screen.getByRole('button', { name: 'Share image' }));
  await screen.findByText("Sharing didn't work here");
  rerender(<PreparedImage file={second} alt="Second view" />);
  expect(screen.queryByText("Sharing didn't work here")).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Share image' }));
  await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
  expect(share.mock.calls[1]?.[0].files[0]).toBe(second);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
});

it('ignores an older share failure after switching files while the share sheet is open', async () => {
  let rejectOld: ((error: Error) => void) | undefined;
  const share = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  const { rerender } = render(<PreparedImage file={first} alt="First view" />);
  fireEvent.click(screen.getByRole('button', { name: 'Share image' }));
  expect(share).toHaveBeenCalledTimes(1);
  rerender(<PreparedImage file={second} alt="Second view" />);
  await act(async () => { rejectOld?.(new DOMException('blocked', 'NotAllowedError')); });
  expect(screen.queryByText("Sharing didn't work here")).toBeNull();
  expect(screen.getByRole('button', { name: 'Share image' })).toBeTruthy();
});
