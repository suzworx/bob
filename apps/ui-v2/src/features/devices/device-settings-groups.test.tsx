import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from './devices-api';
import { DeviceSettingsGroups } from './device-settings-groups';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

const SETTINGS: Device['settings'] = {
  volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob',
};
const OFFLINE: Device['live'] = { connected: false, battery_pct: null, charging: null, fw_version: null };
const ONLINE: Device['live'] = { connected: true, battery_pct: 81, charging: true, fw_version: '1.4.0' };
const DEVICE: Device = {
  id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b',
  name: 'Kitchen',
  model: 'M5Stack Cardputer',
  paired_at: 1756100000000,
  last_seen_at: 1756100500000,
  settings: SETTINGS,
  pending: false,
  settings_supported: true,
  ring_settings_supported: true,
  wake_word_supported: false,
  live: OFFLINE,
};
const settingsUrl = `/api/devices/${DEVICE.id}/settings`;

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

function saved(settings: Partial<Device['settings']>): Response {
  return new Response(JSON.stringify({ id: DEVICE.id, settings: { ...SETTINGS, ...settings }, delivered: true, pending: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function patchBodies(): unknown[] {
  return fetchWithAuth.mock.calls.filter(([url]) => url === settingsUrl).map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

// As the page does: a saved change replaces the device's settings and pending.
function Harness({ initial }: { initial: Device }) {
  const [device, setDevice] = useState(initial);
  return <DeviceSettingsGroups device={device} onSaved={(settings, pending) => setDevice((d) => ({ ...d, settings, pending }))} />;
}

function renderGroups(overrides: Partial<Device> = {}) {
  render(<Harness initial={{ ...DEVICE, ...overrides }} />);
  return userEvent.setup();
}

/** A group's row is a button named by its name and summary. */
function groupRow(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

async function open(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(groupRow(name));
}

beforeEach(() => {
  vi.useRealTimers();
  fetchWithAuth.mockReset();
});

describe('DeviceSettingsGroups: the folded groups (#668, #1240)', () => {
  it('lists Sound and Listening folded, each with a one-line summary; Mute, DND, Screen and About live elsewhere', () => {
    renderGroups({ settings: { ...SETTINGS, volume: 4, mode: 'wake', ring_sound: 'chime', ring_seconds: 60, wake_word: 'bob' }, wake_word_supported: true, live: ONLINE });
    expect(groupRow('Sound').textContent).toContain('Volume 4 · Chime ring, 1 minute');
    expect(groupRow('Listening').textContent).toContain('Wake word · "Hey Bob"');
    for (const name of ['Sound', 'Listening']) expect(groupRow(name).getAttribute('aria-expanded')).toBe('false');
    for (const gone of ['Quiet', 'Screen', 'Voice and language', 'About']) expect(screen.queryByRole('button', { name: new RegExp(`^${gone}`) })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says Muted in the Sound summary when muted', () => {
    renderGroups({ settings: { ...SETTINGS, muted: true } });
    expect(groupRow('Sound').textContent).toContain('Muted · Classic ring, 30 seconds');
  });

  it('offers no wake word choice: Hey Bob is the only one', async () => {
    const user = renderGroups({ wake_word_supported: true, settings: { ...SETTINGS, mode: 'wake' } });
    await open(user, 'Listening');
    expect(screen.queryByRole('combobox', { name: 'Wake word' })).toBeNull();
  });

  it('opens one group at a time', async () => {
    const user = renderGroups();
    await open(user, 'Sound');
    expect(groupRow('Sound').getAttribute('aria-expanded')).toBe('true');
    await open(user, 'Listening');
    expect(groupRow('Listening').getAttribute('aria-expanded')).toBe('true');
    expect(groupRow('Sound').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('DeviceSettingsGroups controls (#327)', () => {
  it('shows the stored values with accessible names', async () => {
    const user = renderGroups({ settings: { ...SETTINGS, volume: 4, mode: 'wake' }, live: ONLINE });
    await open(user, 'Sound');
    expect(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-valuenow')).toBe('4');
    await open(user, 'Listening');
    expect(screen.getByRole('combobox', { name: 'Listening mode' }).textContent).toContain('Wake word');
    expect(screen.queryByText(/back online/)).toBeNull();
  });

  it('says an offline device applies changes when it is back online', () => {
    renderGroups();
    expect(screen.getByText('Changes apply when Kitchen is back online.')).toBeTruthy();
  });

  it('the listening mode saves the chosen mode and shows the server value', async () => {
    fetchWithAuth.mockResolvedValueOnce(saved({ mode: 'announce_only' }));
    const user = renderGroups();
    await open(user, 'Listening');
    await user.click(screen.getByRole('combobox', { name: 'Listening mode' }));
    await user.click(await screen.findByRole('option', { name: 'Announcements only' }));
    expect(patchBodies()).toEqual([{ mode: 'announce_only' }]);
    await waitFor(() => expect(groupRow('Listening').textContent).toContain('Announcements only'));
  });

  it('the volume saves from the keyboard, and a failed save reverts with a Banner', async () => {
    fetchWithAuth.mockResolvedValueOnce(saved({ volume: 7 }));
    fetchWithAuth.mockRejectedValueOnce(new TypeError('offline'));
    const user = renderGroups();
    await open(user, 'Sound');
    act(() => screen.getByRole('slider', { name: 'Volume' }).focus());
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(groupRow('Sound').textContent).toContain('Volume 7'));
    act(() => screen.getByRole('slider', { name: 'Volume' }).focus());
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(screen.getByText("Couldn't change the volume.")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-valuenow')).toBe('7'));
    expect(patchBodies()).toEqual([{ volume: 7 }, { volume: 6 }]);
  });

  // c1: the lead's report: Home then ArrowRight x8 left the volume at 0.
  it('keyboard Home, ArrowRight x8 and End each move the volume, and save once with the final value', async () => {
    // The server answers each PATCH with what it was sent.
    fetchWithAuth.mockImplementation(async (_url, init) =>
      saved(typeof init?.body === 'string' ? (JSON.parse(init.body) as Partial<Device['settings']>) : {}));
    // c3: fake timers make the 400 ms settle deterministic, so "one save per
    // burst" is exact here; the e2e only checks the last save, under real timing.
    await open(renderGroups(), 'Sound');
    const volume = (): HTMLElement => screen.getByRole('slider', { name: 'Volume' });
    // Only the settle's timers are faked. The keys go through fireEvent: after
    // each userEvent action the library waits on a setTimeout(0) that faked
    // timers never fire.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const press = (key: string, times = 1): void => {
        for (let i = 0; i < times; i += 1) fireEvent.keyDown(volume(), { key });
      };
      const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      act(() => volume().focus());
      press('Home');
      expect(volume().getAttribute('aria-valuenow')).toBe('0');
      await settle(300); // a gap shorter than the settle is still one burst
      press('ArrowRight', 8);
      expect(volume().getAttribute('aria-valuenow')).toBe('8');
      await settle(399);
      expect(patchBodies()).toEqual([]);
      await settle(1);
      expect(patchBodies()).toEqual([{ volume: 8 }]);
      expect(groupRow('Sound').textContent).toContain('Volume 8');
      expect(volume().getAttribute('aria-valuenow')).toBe('8');
      act(() => volume().focus());
      press('End');
      expect(volume().getAttribute('aria-valuenow')).toBe('10');
      await settle(400);
      expect(patchBodies()).toEqual([{ volume: 8 }, { volume: 10 }]);
      expect(groupRow('Sound').textContent).toContain('Volume 10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says Applying… (announced) only while a change waits', async () => {
    fetchWithAuth.mockResolvedValueOnce(saved({ ring_sound: 'chime' }));
    const user = renderGroups();
    expect(screen.queryByText('Applying…')).toBeNull();
    await open(user, 'Sound');
    await user.click(screen.getByRole('combobox', { name: 'Ring sound' }));
    await user.click(await screen.findByRole('option', { name: 'Chime' }));
    expect(await screen.findByText('Applying…')).toBeTruthy();
    await waitFor(() => {
      const regions = Array.from(document.querySelectorAll('[aria-live="polite"]'));
      expect(regions.map((region) => region.textContent).join(' ')).toContain('Kitchen settings applying');
    });
  });

  it('firmware that never reported its settings: one note at the top, controls off', async () => {
    const user = renderGroups({ settings_supported: false, ring_settings_supported: false });
    expect(screen.getByText('Update Kitchen to change settings from here.')).toBeTruthy();
    expect(groupRow('Sound').textContent).not.toContain('Needs a firmware update');
    await open(user, 'Sound');
    expect(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-disabled')).toBe('true');
    expect(isDisabled(screen.getByRole('combobox', { name: 'Ring sound' }))).toBe(true);
  });
});

describe('DeviceSettingsGroups timer ring settings (#389)', () => {
  it('shows the stored ring length and sound, states the range, and offers the lengths', async () => {
    const user = renderGroups({ settings: { ...SETTINGS, ring_seconds: 45, ring_sound: 'chime' } });
    await open(user, 'Sound');
    expect(screen.getByRole('combobox', { name: 'Timer ring length' }).textContent).toContain('45 seconds');
    expect(screen.getByRole('combobox', { name: 'Ring sound' }).textContent).toContain('Chime');
    expect(screen.getByText('How long a timer or alarm rings, 10 to 120 seconds.')).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Timer ring length' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '10 seconds', '20 seconds', '30 seconds', '45 seconds', '1 minute', '90 seconds', '2 minutes',
    ]);
  });

  it('saves a ring length, and a stored length off the choices still shows', async () => {
    fetchWithAuth.mockResolvedValueOnce(saved({ ring_seconds: 60 }));
    const user = renderGroups({ settings: { ...SETTINGS, ring_seconds: 25 } });
    await open(user, 'Sound');
    expect(screen.getByRole('combobox', { name: 'Timer ring length' }).textContent).toContain('25 seconds');
    await user.click(screen.getByRole('combobox', { name: 'Timer ring length' }));
    await user.click(await screen.findByRole('option', { name: '1 minute' }));
    expect(patchBodies()).toEqual([{ ring_seconds: 60 }]);
    await waitFor(() => expect(groupRow('Sound').textContent).toContain('Classic ring, 1 minute'));
  });

  it('disables only the ring controls, saying "Needs a firmware update", for firmware without ring support', async () => {
    const user = renderGroups({ ring_settings_supported: false });
    await open(user, 'Sound');
    expect(isDisabled(screen.getByRole('combobox', { name: 'Timer ring length' }))).toBe(true);
    expect(isDisabled(screen.getByRole('combobox', { name: 'Ring sound' }))).toBe(true);
    expect(screen.getAllByText('Needs a firmware update').length).toBeGreaterThan(0);
    expect(screen.getByRole('slider', { name: 'Volume' }).getAttribute('aria-disabled')).not.toBe('true');
  });
});
