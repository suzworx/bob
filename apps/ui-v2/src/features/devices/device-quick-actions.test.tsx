import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from './devices-api';
import { DeviceQuickActions } from './device-quick-actions';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

const SETTINGS: Device['settings'] = { volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' };
const DEVICE: Device = {
  id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b',
  name: 'Kitchen',
  model: 'M5Stack Cardputer',
  paired_at: 1,
  last_seen_at: null,
  settings: SETTINGS,
  pending: false,
  settings_supported: true,
  ring_settings_supported: true,
  wake_word_supported: false,
  live: { connected: true, battery_pct: 80, charging: false, fw_version: '1.2.0' },
};
const ANNOUNCE = `/api/devices/${DEVICE.id}/announce`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sentBody(call = 0): unknown {
  return JSON.parse(String(fetchWithAuth.mock.calls[call][1]?.body));
}

function renderActions(device: Device = DEVICE) {
  const onSaved = vi.fn();
  render(<DeviceQuickActions device={device} onSettingsSaved={onSaved} />);
  return { user: userEvent.setup(), onSaved };
}

beforeEach(() => fetchWithAuth.mockReset());

describe('DeviceQuickActions', () => {
  it('Test speaker sends a ringing notice and says it was sent', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(202, { status: 'sent' }));
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Test speaker' }));
    expect(await screen.findByText('Sent to Kitchen.')).toBeTruthy();
    expect(fetchWithAuth.mock.calls[0][0]).toBe(ANNOUNCE);
    expect(sentBody()).toEqual({ kind: 'notice', title: 'Speaker test', ring: true });
  });

  it('says a held notice delivers when ready', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(202, { status: 'held' }));
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Test speaker' }));
    expect(await screen.findByText('Kitchen will show it when free.')).toBeTruthy();
  });

  it('says the device is offline on 409, and a neutral error otherwise', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(409, { error: 'no_device' }));
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Test speaker' }));
    expect(await screen.findByText('Kitchen is offline.')).toBeTruthy();
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    await user.click(screen.getByRole('button', { name: 'Test speaker' }));
    expect(await screen.findByText("Couldn't reach Kitchen. Try again.")).toBeTruthy();
  });

  it('Announce sends the typed title and message without a ring', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(202, { status: 'sent' }));
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Announce…' }));
    const dialog = screen.getByRole('dialog', { name: 'Announce on Kitchen' });
    const send = within(dialog).getByRole('button', { name: 'Announce' });
    expect(send.hasAttribute('disabled') || send.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.type(within(dialog).getByRole('textbox', { name: /^Title/ }), 'Dinner is ready');
    await user.type(within(dialog).getByRole('textbox', { name: /^Message/ }), 'Come down please');
    await user.click(send);
    expect(await screen.findByText('Sent to Kitchen.')).toBeTruthy();
    expect(sentBody()).toEqual({ kind: 'notice', title: 'Dinner is ready', body: 'Come down please', ring: false });
  });

  it('caps the title at 28 characters', async () => {
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Announce…' }));
    const title = within(screen.getByRole('dialog')).getByRole('textbox', { name: /^Title/ });
    await user.type(title, 'x'.repeat(40));
    expect((title as HTMLInputElement).value).toBe('x'.repeat(28));
  });

  it('Do not disturb and Mute save through the settings PATCH', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(200, { settings: { ...SETTINGS, dnd: true }, delivered: true, pending: true }));
    const { user, onSaved } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Do not disturb' }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...SETTINGS, dnd: true }, true));
    expect(fetchWithAuth.mock.calls[0][0]).toBe(`/api/devices/${DEVICE.id}/settings`);
    expect(sentBody()).toEqual({ dnd: true });
    fetchWithAuth.mockResolvedValueOnce(json(500, {}));
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(await screen.findByText("Couldn't change Mute.")).toBeTruthy();
    expect(sentBody(1)).toEqual({ muted: true });
  });

  it('shows Do not disturb and Mute as pressed from the stored settings, and off without firmware support', () => {
    renderActions({ ...DEVICE, settings: { ...SETTINGS, dnd: true }, settings_supported: false });
    const dnd = screen.getByRole('button', { name: 'Do not disturb' });
    expect(dnd.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('false');
    expect(dnd.hasAttribute('disabled') || dnd.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('offline: Test speaker and Announce are off with the reason; muted, Test speaker says unmute', () => {
    const off = (el: HTMLElement): boolean => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    const { unmount } = render(<DeviceQuickActions device={{ ...DEVICE, live: { ...DEVICE.live, connected: false } }} onSettingsSaved={vi.fn()} />);
    expect(off(screen.getByRole('button', { name: 'Test speaker' }))).toBe(true);
    expect(off(screen.getByRole('button', { name: 'Announce…' }))).toBe(true);
    unmount();
    render(<DeviceQuickActions device={{ ...DEVICE, settings: { ...SETTINGS, muted: true } }} onSettingsSaved={vi.fn()} />);
    expect(off(screen.getByRole('button', { name: 'Test speaker' }))).toBe(true);
    expect(off(screen.getByRole('button', { name: 'Announce…' }))).toBe(false);
  });

  it('a failed announce keeps the dialog and the typed text, with Retry', async () => {
    fetchWithAuth.mockResolvedValueOnce(json(500, {}));
    const { user } = renderActions();
    await user.click(screen.getByRole('button', { name: 'Announce…' }));
    const dialog = screen.getByRole('dialog', { name: 'Announce on Kitchen' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Title/ }), 'Dinner');
    await user.click(within(dialog).getByRole('button', { name: 'Announce' }));
    expect(await within(dialog).findByRole('button', { name: 'Retry' })).toBeTruthy();
    expect((within(dialog).getByRole('textbox', { name: /^Title/ }) as HTMLInputElement).value).toBe('Dinner');
  });
});
