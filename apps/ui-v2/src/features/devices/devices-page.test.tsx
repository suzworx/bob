import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSpace, Device } from './devices-api';
import type { Space, SpacesValue } from '@/features/spaces/use-spaces';
import { notifyDevicesChanged } from './devices-events';
import { DevicesPage } from './devices-page';
import { devicePath, spacePath } from '../../app/routes';

const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));

const spacesHook = vi.hoisted(() => ({ value: null as SpacesValue | null }));
vi.mock('@/features/spaces/use-spaces', () => ({ useOptionalSpaces: () => spacesHook.value }));

// The pointer comes from the shared hook (its own tests cover the requests).
const pointer = vi.hoisted(() => ({
  value: {
    activeId: null as string | null,
    activeTitle: null as string | null,
    status: null as { key: string; text: string } | null,
    send: vi.fn(async () => 'sent' as const),
    items: () => [],
  },
}));
const useDeviceConversationSpy = vi.hoisted(() => vi.fn());
vi.mock('@/features/devices/use-device-conversation', async (importActual) => ({
  ...(await importActual<object>()),
  useDeviceConversation: (options?: { deviceId?: string }) => {
    useDeviceConversationSpy(options);
    return pointer.value;
  },
}));
const activity = vi.hoisted(() => ({ value: { state: 'ready', items: [] } as unknown }));
const activityCalls: Array<[string, number]> = [];
vi.mock('./device-recent', async (importActual) => ({
  ...(await importActual<object>()),
  useDeviceActivity: (id: string, key: number) => {
    activityCalls.push([id, key]);
    return activity.value;
  },
}));
vi.mock('@/features/chat/use-conversation-list', () => ({ useConversationList: () => ({ conversations: [] }) }));
vi.mock('@/features/spaces/use-threads', () => ({ useThreads: () => ({ threads: [], createThread: vi.fn() }) }));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

const SPACE_GARDEN = '11111111-1111-4111-8111-111111111111';
const SPACE_WORK = '22222222-2222-4222-8222-222222222222';
const THREAD = '5b7a1c2e-0000-4000-8000-000000000001';

function spacesValue(): SpacesValue {
  const space = (id: string, name: string): Space => ({
    id, kind: 'group', name, role: 'owner', membership_revision: 1, created_at: 1, updated_at: 1, members: [],
  });
  return {
    spaces: [space(SPACE_GARDEN, 'Garden'), space(SPACE_WORK, 'Studio')],
    state: 'ready', activeSpace: null, activeSpaceId: null, setActiveSpace: vi.fn(), createSpace: vi.fn(), renameSpace: vi.fn(),
    archiveSpace: vi.fn(), listArchivedSpaces: vi.fn(), restoreSpace: vi.fn(), refresh: vi.fn(async () => {}),
  } as SpacesValue;
}

const SETTINGS: Device['settings'] = { volume: 6, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' };
const OFFLINE: Device['live'] = { connected: false, battery_pct: null, charging: null, fw_version: null };
const ONLINE: Device['live'] = { connected: true, battery_pct: 82, charging: false, fw_version: '0.168.0' };

const DEVICE_A: Device = {
  id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b', name: 'Kitchen', model: 'Bob (Waveshare 1.85C)',
  paired_at: 1756100000000, last_seen_at: 1756100500000, settings: SETTINGS, pending: false,
  settings_supported: true, ring_settings_supported: true, wake_word_supported: true, live: OFFLINE,
};
const DEVICE_B: Device = { ...DEVICE_A, id: '7a0f3c3f-8d2b-5e4f-ab6c-1d2e3f4a5b6c', name: 'Workshop', last_seen_at: null };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Every GET /api/devices answers with these; other requests answer per test. */
let listed: { devices: Device[]; active_conversation: null; active_space: ActiveSpace | null };
let routes: Record<string, (init?: RequestInit) => Response>;

function dateOnly(ms: number): string {
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', calendar: 'gregory' }).format(new Date(ms));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/devices');
  listed = { devices: [DEVICE_A], active_conversation: null, active_space: null };
  routes = {};
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${url}`];
    if (route) return route(init);
    if (url === '/api/devices' && method === 'GET') return jsonResponse(200, listed);
    return jsonResponse(404, {});
  });
  activity.value = { state: 'ready', items: [] };
  activityCalls.length = 0;
  spacesHook.value = spacesValue();
  pointer.value = { ...pointer.value, activeId: null, activeTitle: null, status: null, send: vi.fn(async () => 'sent' as const) };
  useDeviceConversationSpy.mockClear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const rows = async (): Promise<HTMLElement[]> => within(await screen.findByRole('list')).getAllByRole('listitem');

describe('DevicesPage list (#1240 P0: always a list)', () => {
  it('shows skeleton rows while loading', () => {
    fetchWithAuth.mockReturnValueOnce(new Promise<Response>(() => {}));
    render(<DevicesPage />);
    expect(screen.getByRole('heading', { name: 'Devices', level: 1 })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading devices' })).toBeTruthy();
  });

  it('is a list even with one device: dot, name and "Offline · seen <date>"', async () => {
    render(<DevicesPage />);
    const [row] = await rows();
    expect(within(row).getByText('Kitchen')).toBeTruthy();
    expect(within(row).getByLabelText('Offline')).toBeTruthy();
    expect(row.textContent).toContain(`Offline · seen ${dateOnly(DEVICE_A.last_seen_at!)}`);
    expect(screen.queryByRole('heading', { name: 'Talking in' })).toBeNull();
    expect(activityCalls).toEqual([]);
  });

  it('a connected device reads "Connected · 82%" with the success dot, from one online rule', async () => {
    // live.connected alone is online, as is connected alone (isDeviceOnline).
    listed.devices = [{ ...DEVICE_A, live: ONLINE }, { ...DEVICE_B, connected: true }];
    render(<DevicesPage />);
    const [kitchen, workshop] = await rows();
    expect(kitchen.textContent).toContain('Connected · 82%');
    expect(within(kitchen).getByLabelText('Connected')).toBeTruthy();
    expect(within(workshop).getByLabelText('Connected')).toBeTruthy();
    expect(screen.getByText('2 connected')).toBeTruthy();
  });

  it('a row opens /devices/<id>', async () => {
    const user = userEvent.setup();
    listed.devices = [DEVICE_A, DEVICE_B];
    render(<DevicesPage />);
    await user.click(await screen.findByRole('button', { name: /^Workshop/ }));
    expect(window.location.pathname).toBe(devicePath(DEVICE_B.id));
    expect(await screen.findByRole('heading', { name: 'Workshop', level: 1 })).toBeTruthy();
  });

  it('each row has one menu: Rename, then Remove device last', async () => {
    const user = userEvent.setup();
    render(<DevicesPage />);
    await rows();
    await user.click(screen.getByRole('button', { name: 'Actions for Kitchen' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Remove device']);
  });

  it('an empty account gets one "Pair a device" that opens /devices/pair', async () => {
    const user = userEvent.setup();
    listed.devices = [];
    render(<DevicesPage />);
    expect(await screen.findByRole('heading', { name: 'No devices yet', level: 2 })).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Pair a device' });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(window.location.pathname).toBe('/devices/pair');
  });

  it('a failed load says so with Retry, which reads again', async () => {
    const user = userEvent.setup();
    fetchWithAuth.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<DevicesPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load your devices.");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Kitchen')).toBeTruthy();
  });

  it('refetches when notifyDevicesChanged fires', async () => {
    render(<DevicesPage />);
    await rows();
    listed.devices = [DEVICE_A, DEVICE_B];
    act(() => notifyDevicesChanged());
    expect(await screen.findByText('Workshop')).toBeTruthy();
  });

  it('an unknown id says the device is not here and leads back', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/devices/gone');
    render(<DevicesPage />);
    expect(await screen.findByRole('heading', { name: "This device isn't here anymore" })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to devices' }));
    expect(window.location.pathname).toBe('/devices');
  });
});

describe('DevicesPage rename and remove', () => {
  it('Rename opens a dialog; a 2xx renames the row', async () => {
    const user = userEvent.setup();
    routes[`PATCH /api/devices/${DEVICE_A.id}`] = () => new Response(null, { status: 200 });
    render(<DevicesPage />);
    await rows();
    await user.click(screen.getByRole('button', { name: 'Actions for Kitchen' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const box = screen.getByRole('textbox', { name: /^Device name/ });
    expect(document.activeElement).toBe(box);
    await user.clear(box);
    await user.type(box, 'Pantry{Enter}');
    expect(await screen.findByText('Pantry')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a failed rename keeps the dialog and the draft open', async () => {
    const user = userEvent.setup();
    routes[`PATCH /api/devices/${DEVICE_A.id}`] = () => new Response(null, { status: 500 });
    render(<DevicesPage />);
    await rows();
    await user.click(screen.getByRole('button', { name: 'Actions for Kitchen' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const box = screen.getByRole('textbox', { name: /^Device name/ }) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, 'Pantry{Enter}');
    expect(await screen.findByText("Couldn't rename it. Try again.")).toBeTruthy();
    expect(box.value).toBe('Pantry');
  });

  it('Remove device asks by name, and removes only after the 204', async () => {
    const user = userEvent.setup();
    routes[`DELETE /api/devices/${DEVICE_A.id}`] = () => new Response(null, { status: 204 });
    listed.devices = [DEVICE_A, DEVICE_B];
    render(<DevicesPage />);
    await rows();
    await user.click(screen.getByRole('button', { name: 'Actions for Kitchen' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove device' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Kitchen?' });
    expect(dialog.textContent).toContain('Kitchen stops working until you pair it again.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Kitchen')).toBeNull());
    expect(window.location.pathname).toBe('/devices');
    expect(screen.getByText('Workshop')).toBeTruthy();
  });

  it('a failed remove keeps the dialog open and says so', async () => {
    const user = userEvent.setup();
    routes[`DELETE /api/devices/${DEVICE_A.id}`] = () => new Response(null, { status: 500 });
    render(<DevicesPage />);
    await rows();
    await user.click(screen.getByRole('button', { name: 'Actions for Kitchen' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove device' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Kitchen?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText("Couldn't remove Kitchen. Try again.")).toBeTruthy();
    expect(screen.getByText('Kitchen')).toBeTruthy();
  });
});

describe('DevicesPage detail (#1240 P0: always the detail at /devices/:id)', () => {
  function openDetail(device: Device = DEVICE_A): void {
    window.history.replaceState(null, '', devicePath(device.id));
  }

  it('header: back, name, status and the quick actions; sections in order; model shown once', async () => {
    const user = userEvent.setup();
    listed.devices = [{ ...DEVICE_A, live: ONLINE }];
    openDetail();
    render(<DevicesPage />);
    expect(await screen.findByRole('heading', { name: 'Kitchen', level: 1 })).toBeTruthy();
    expect(screen.getByText('Connected · 82%')).toBeTruthy();
    for (const name of ['Test speaker', 'Announce…']) expect(screen.getByRole('button', { name })).toBeTruthy();
    for (const name of ['Do not disturb', 'Mute']) expect(screen.getByRole('button', { name })).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Talking in', 'Settings', 'Recent', 'About']);
    // The product name, once (About), never the SKU on its own line elsewhere.
    expect(screen.getAllByText('Bob · Waveshare 1.85C')).toHaveLength(1);
    expect(screen.queryByText(/Cardputer/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to devices' }));
    expect(window.location.pathname).toBe('/devices');
  });

  it('Mute in the header and Settings share one save: the PATCH reflects in both', async () => {
    const user = userEvent.setup();
    routes[`PATCH /api/devices/${DEVICE_A.id}/settings`] = (init) => jsonResponse(200, {
      settings: { ...SETTINGS, ...(JSON.parse(String(init?.body)) as object) }, delivered: true, pending: false,
    });
    listed.devices = [{ ...DEVICE_A, live: ONLINE }];
    openDetail();
    render(<DevicesPage />);
    await user.click(await screen.findByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sound/ }).textContent).toContain('Muted'));
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('offline: Test speaker and Announce are off; settings say they apply when it is back', async () => {
    openDetail();
    render(<DevicesPage />);
    const test = await screen.findByRole('button', { name: 'Test speaker' });
    const off = (el: HTMLElement): boolean => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    expect(off(test)).toBe(true);
    expect(off(screen.getByRole('button', { name: 'Announce…' }))).toBe(true);
    expect(screen.getByText('Changes apply when Kitchen is back online.')).toBeTruthy();
  });

  it('scopes the pointer hook to the device once there are several', async () => {
    listed.devices = [DEVICE_A, DEVICE_B];
    openDetail(DEVICE_B);
    render(<DevicesPage />);
    await screen.findByRole('heading', { name: 'Workshop', level: 1 });
    expect(useDeviceConversationSpy).toHaveBeenLastCalledWith({ deviceId: DEVICE_B.id });
    expect(new Set(activityCalls.map(([id]) => id))).toEqual(new Set([DEVICE_B.id]));
  });

  it("Talking in: a thread shows ITS OWN space and opens it, not the default space", async () => {
    const user = userEvent.setup();
    // The default space for new conversations is Studio; the thread lives in Garden.
    listed.active_space = { id: SPACE_WORK, name: 'Studio' };
    routes[`GET /api/threads/${THREAD}`] = () => jsonResponse(200, { id: THREAD, space_id: SPACE_GARDEN, title: 'Seed order', updated_at: 1 });
    pointer.value = { ...pointer.value, activeId: `thr_${THREAD}`, activeTitle: 'Seed order' };
    openDetail();
    render(<DevicesPage />);
    const row = await screen.findByRole('button', { name: /^Seed order/ });
    await waitFor(() => expect(row.closest('li')?.textContent).toContain('In Garden'));
    expect(screen.queryByText(/Space: General/)).toBeNull();
    await user.click(row);
    expect(window.location.pathname).toBe(spacePath(SPACE_GARDEN, 'threads', THREAD));
  });

  it('Talking in: a General chat says "In General"; the default space lives in Settings', async () => {
    listed.active_space = { id: SPACE_GARDEN, name: 'Garden' };
    pointer.value = { ...pointer.value, activeId: 'cnv_abc12345', activeTitle: 'Grocery list' };
    openDetail();
    render(<DevicesPage />);
    const row = await screen.findByRole('button', { name: /^Grocery list/ });
    expect(row.closest('li')?.textContent).toContain('In General');
    expect((screen.getByRole('combobox', { name: /^New conversations start in/ }) as HTMLElement).textContent).toContain('Garden');
  });

  it('changing where new conversations start PUTs the space (this device only with several)', async () => {
    const user = userEvent.setup();
    routes['PUT /api/devices/active-space'] = () => jsonResponse(200, { active_space: { id: SPACE_GARDEN, name: 'Garden' } });
    listed.devices = [DEVICE_A, DEVICE_B];
    openDetail();
    render(<DevicesPage />);
    await user.click(await screen.findByRole('combobox', { name: /^New conversations start in/ }));
    await user.click(await screen.findByRole('option', { name: 'Garden' }));
    const put = fetchWithAuth.mock.calls.find(([url, init]) => url === '/api/devices/active-space' && init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ space_id: SPACE_GARDEN, device_id: DEVICE_A.id });
  });
});

describe('DevicesPage pairing (#1240)', () => {
  it('`pairing` shows the pair dialog over the list', async () => {
    window.history.replaceState(null, '', '/devices/pair');
    render(<DevicesPage pairing />);
    expect(await screen.findByRole('dialog', { name: 'Pair a device' })).toBeTruthy();
    expect(await screen.findByText('Kitchen')).toBeTruthy();
  });

  it('a successful pair closes to /devices and highlights the new device', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/devices/pair?code=K7QX4TZP');
    routes['POST /api/pair/lookup'] = () => jsonResponse(200, { pairing_id: 'p1', device_model: 'Bob', expires_at: Date.now() + 60_000 });
    routes['POST /api/pair/approve'] = () => {
      listed.devices = [DEVICE_A, DEVICE_B];
      return jsonResponse(200, { device_id: DEVICE_B.id, name: 'Workshop' });
    };
    render(<DevicesPage pairing />);
    await user.click(await screen.findByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(window.location.pathname).toBe('/devices'));
    const row = (await screen.findByText(/Just paired/)).closest('li');
    expect(row?.textContent).toContain('Workshop');
  });
});
