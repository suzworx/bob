import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRED_ERROR, PairDialog } from './pair-dialog';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const LOOKUP = { pairing_id: 'pair-123', device_model: 'Bob', fw_version: '1.0.0', requested_at: 1, expires_at: Date.now() + 600_000 };

function bodies(url: string): unknown[] {
  return fetchWithAuth.mock.calls.filter(([u]) => u === url).map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

function open(onPaired = vi.fn(), onOpenChange = vi.fn()) {
  render(<PairDialog isOpen onOpenChange={onOpenChange} onPaired={onPaired} />);
  return { user: userEvent.setup(), onPaired, onOpenChange, code: () => screen.getByRole('textbox', { name: /^Code on the screen/ }) as HTMLInputElement };
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  window.history.replaceState(null, '', '/devices/pair');
});
afterEach(() => window.history.replaceState(null, '', '/'));

describe('PairDialog', () => {
  it('is a dialog titled "Pair a device" that autofocuses the code and says where to find it', () => {
    const { code } = open();
    expect(screen.getByRole('dialog', { name: 'Pair a device' })).toBeTruthy();
    expect(document.activeElement).toBe(code());
    expect(screen.getByText("Find the 8-character code on your device's screen.")).toBeTruthy();
  });

  it('prefills the code from ?code=', () => {
    window.history.replaceState(null, '', '/devices/pair?code=k7qx4tzp');
    const { code } = open();
    expect(code().value).toBe('K7QX-4TZP');
  });

  it('pairs and names the device in one step, then hands back the new id', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, LOOKUP)).mockResolvedValueOnce(json(200, { device_id: 'dev-1', name: 'Kitchen' }));
    const { user, code, onPaired } = open();
    await user.type(code(), 'K7QX4TZP');
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'Kitchen');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith({ device_id: 'dev-1', name: 'Kitchen' }));
    expect(bodies('/api/pair/lookup')).toEqual([{ user_code: 'K7QX4TZP' }]);
    expect(bodies('/api/pair/approve')).toEqual([{ pairing_id: 'pair-123', name: 'Kitchen' }]);
  });

  it('an expired code clears the field and asks for the new one; the next code pairs', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(json(200, LOOKUP))
      .mockResolvedValueOnce(json(404, { error: { code: 'not_found' } }))
      .mockResolvedValueOnce(json(200, { ...LOOKUP, pairing_id: 'pair-456' }))
      .mockResolvedValueOnce(json(200, { device_id: 'dev-2', name: 'Bob' }));
    const { user, code, onPaired } = open();
    await user.type(code(), 'K7QX4TZP');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText(EXPIRED_ERROR)).toBeTruthy();
    expect(code().value).toBe('');
    await user.type(code(), 'ABCD2345');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith({ device_id: 'dev-2', name: 'Bob' }));
  });

  it('says how long to wait when rate limited', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(429, { retry_after_seconds: 120 }));
    const { user, code } = open();
    await user.type(code(), 'K7QX4TZP');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
  });

  it('Pair waits for all eight characters; Cancel closes without a request', async () => {
    const { user, code, onOpenChange } = open();
    await user.type(code(), 'K7QX');
    const pair = screen.getByRole('button', { name: 'Pair' });
    expect(pair.hasAttribute('disabled') || pair.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
