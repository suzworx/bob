import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from '@/features/spaces/use-spaces';
import type { Device } from './devices-api';
import { NowTalkingCard, STATUS_KEY } from './now-talking-card';
import { DEVICE_APPLIED, DEVICE_STATUS, type DeviceConversation } from './use-device-conversation';
import { spacePath } from '../../app/routes';

// #900: a minimal paired device, for the "which Cardputer" selector.
function pairedDevice(id: string, name: string): Device {
  return {
    id,
    name,
    model: 'M5Stack Cardputer',
    paired_at: 1,
    last_seen_at: null,
    settings: { volume: 5, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' },
    pending: false,
    settings_supported: true,
    ring_settings_supported: true,
    wake_word_supported: false,
    live: { connected: false, battery_pct: null, charging: null, fw_version: null },
  };
}

const GARDEN: Space = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Garden', kind: 'group', role: 'owner', membership_revision: 1, created_at: 1, updated_at: 1, members: [],
};
const HOUR_AGO = Date.now() - 3_600_000;
const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>(async () => new Response('{"devices":[]}')));
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('@/features/spaces/use-spaces', () => ({ useOptionalSpaces: () => ({ spaces: [GARDEN] }) }));
vi.mock('@/features/chat/use-conversation-list', () => ({
  useConversationList: () => ({ conversations: [{ id: 'cnv_1', title: 'Trip plan', createdAt: 1, updatedAt: HOUR_AGO }] }),
}));
// Stable references, as the real query hook returns.
const THREADS = vi.hoisted(() => ({ list: [] as unknown[], create: () => Promise.resolve(null) }));
vi.mock('@/features/spaces/use-threads', () => ({
  useThreads: () => ({ threads: THREADS.list, createThread: THREADS.create }),
}));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

function device(overrides: Partial<DeviceConversation> = {}): DeviceConversation {
  return { activeId: 'cnv_1', activeTitle: 'Trip plan', status: null, send: vi.fn(async () => 'sent' as const), items: () => [], ...overrides };
}

// A thread pointer's facts come from GET /api/threads/:id: it lives in Garden.
const STUDIO: Space = { ...GARDEN, id: '22222222-2222-4222-8222-222222222222', name: 'Studio' };

function card(conversation: DeviceConversation, lastTurnAt?: number | null, activeSpace: Space | null = STUDIO) {
  render(<NowTalkingCard device={conversation} activeSpace={activeSpace} spaces={[GARDEN, STUDIO]} lastTurnAt={lastTurnAt} deviceName="Kitchen" />);
}

/** The row's own button carries the title and description. */
const row = (title: RegExp): HTMLElement => screen.getByRole('button', { name: title });

beforeEach(() => {
  fetchWithAuth.mockImplementation(async (input) => {
    if (String(input) === '/api/threads/t1') {
      return new Response(JSON.stringify({ id: 't1', space_id: GARDEN.id, title: 'Seeds', updated_at: HOUR_AGO }), { status: 200 });
    }
    return new Response('{"devices":[]}');
  });
});

describe('NowTalkingCard (#1240: Talking in)', () => {
  it('a General chat: its title, "In General" and last turn', () => {
    card(device());
    expect(row(/^Trip plan/).textContent).toMatch(/In General · last turn/);
  });

  it('a thread: ITS OWN space, never the default space for new conversations (P0)', async () => {
    const user = userEvent.setup();
    card(device({ activeId: 'thr_t1', activeTitle: 'Seeds' }));
    await waitFor(() => expect(row(/^Seeds/).textContent).toContain('In Garden'));
    expect(row(/^Seeds/).textContent).not.toContain('Studio');
    expect(screen.queryByText(/Space: General/)).toBeNull();
    await user.click(row(/^Seeds/));
    expect(window.location.pathname).toBe(spacePath(GARDEN.id, 'threads', 't1'));
  });

  it('a General chat opens that chat', async () => {
    const user = userEvent.setup();
    card(device());
    await user.click(row(/^Trip plan/));
    expect(window.location.pathname).toBe('/c/cnv_1');
  });

  it("last turn is this device's newest turn when it has one, else the chat's updated time", () => {
    card(device(), Date.now() - 120_000);
    expect(row(/^Trip plan/).textContent).toMatch(/min/);
    cleanup();
    card(device(), null);
    expect(row(/^Trip plan/).textContent).toMatch(/hour|hr/);
  });

  it('no pointer: a new conversation that starts in the default space', () => {
    card(device({ activeId: null, activeTitle: null }));
    expect(screen.getByText('A new conversation')).toBeTruthy();
    expect(screen.getByText('Starts in Studio on the next turn')).toBeTruthy();
  });

  it('Change opens the picker, titled "Change conversation"', async () => {
    const user = userEvent.setup();
    card(device());
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('dialog', { name: /^Change conversation/ })).toBeTruthy();
  });

  it('a pick waiting for an offline device says so on the row, then applied', () => {
    card(device({ status: { key: STATUS_KEY, text: DEVICE_STATUS.pending } }));
    expect(row(/^Trip plan/).textContent).toContain('Waiting for Kitchen to come online');
    cleanup();
    card(device({ status: { key: STATUS_KEY, text: DEVICE_APPLIED } }));
    expect(row(/^Trip plan/).textContent).toContain(DEVICE_APPLIED);
  });

  it("ignores another surface's status", () => {
    card(device({ status: { key: 'cnv_1', text: DEVICE_STATUS.pending } }));
    expect(row(/^Trip plan/).textContent).not.toContain('Waiting');
  });

  it('resolves the title locally when the hook carries none of its own (#900)', async () => {
    card(device({ activeId: 'thr_t1', activeTitle: null }));
    expect(await screen.findByRole('button', { name: /^Seeds/ })).toBeTruthy();
  });

  it('passes the devices through, scoped: the device page picker offers no device choice', async () => {
    const user = userEvent.setup();
    render(<NowTalkingCard device={device()} activeSpace={GARDEN} spaces={[GARDEN]} devices={[pairedDevice('d1', 'Kitchen'), pairedDevice('d2', 'Workshop')]} deviceId="d1" />);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await screen.findByRole('dialog', { name: /^Change conversation/ });
    expect(screen.queryByRole('combobox', { name: 'Device' })).toBeNull();
  });
});

afterEach(() => window.history.replaceState(null, '', '/'));
