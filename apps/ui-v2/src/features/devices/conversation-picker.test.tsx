import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationPicker, NEW_THREAD_TITLE } from './conversation-picker';
import type { Device } from './devices-api';
import type { DeviceConversation, DeviceSendResult } from './use-device-conversation';

const GARDEN = '11111111-1111-4111-8111-111111111111';
const fetchWithAuth = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/auth/use-session', () => ({ fetchWithAuth }));
vi.mock('@/features/chat/use-conversation-list', () => ({
  useConversationList: () => ({
    // updatedAt interleaves with the threads below, so Recent is one merged list.
    conversations: ['Trip plan', 'Grocery list', 'Recipes', 'Taxes', 'Birthday', 'Car repair'].map((title, i) => ({
      id: `cnv_${i}`, title, createdAt: 1, updatedAt: 100 - i * 10,
    })),
  }),
}));
vi.mock('@/features/spaces/use-spaces', () => ({
  useOptionalSpaces: () => ({ spaces: [{ id: GARDEN, name: 'Garden' }] }),
}));
const createThread = vi.hoisted(() => vi.fn());
const THREADS = ['Seeds', 'Beds', 'Compost', 'Tools'].map((title, i) => ({
  id: `t${i}`, space_id: GARDEN, title, archived_at: null, updated_at: 95 - i * 10,
}));
vi.mock('@/features/spaces/use-threads', () => ({
  useThreads: (spaceId: string | null) => ({ threads: spaceId === null ? [] : THREADS, createThread }),
}));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

function device(activeId: string | null, result: DeviceSendResult = 'sent', extra: Partial<DeviceConversation> = {}): DeviceConversation {
  return { activeId, activeTitle: null, status: null, deviceName: 'Kitchen', send: vi.fn(async () => result), items: () => [], ...extra };
}

function pairedDevice(id: string, name: string, ownSpace: string | null = null): Device {
  return {
    id, name, model: 'Bob', paired_at: 1, last_seen_at: null,
    settings: { volume: 5, muted: false, mode: 'ptt', dnd: false, ring_seconds: 30, ring_sound: 'classic', wake_word: 'bob' },
    pending: false, settings_supported: true, ring_settings_supported: true, wake_word_supported: false,
    live: { connected: false, battery_pct: null, charging: null, fw_version: null }, active_space_id: ownSpace,
  };
}
const KITCHEN = pairedDevice('d1', 'Kitchen');
const WORKSHOP = pairedDevice('d2', 'Workshop', GARDEN);

let listed: { devices: Device[]; active_space: { id: string; name: string } | null; active_conversation: null };

function open(conversation: DeviceConversation, extra: Partial<Parameters<typeof ConversationPicker>[0]> = {}) {
  const onOpenChange = vi.fn();
  render(<ConversationPicker isOpen onOpenChange={onOpenChange} device={conversation} statusKey="card" {...extra} />);
  return { onOpenChange, user: userEvent.setup() };
}

const recentLabels = (): string[] =>
  within(screen.getByRole('list', { name: 'Recent' })).getAllByRole('listitem').map((item) => item.querySelector('button')?.textContent ?? '');

beforeEach(() => {
  listed = { devices: [KITCHEN], active_space: null, active_conversation: null };
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async () => new Response(JSON.stringify(listed), { status: 200 }));
  createThread.mockReset();
});
afterEach(cleanup);

describe('ConversationPicker (#1240 P0)', () => {
  it('is titled "Change conversation" for the device, with the search focused', () => {
    open(device(null));
    expect(screen.getByRole('dialog', { name: /^Change conversation/ })).toBeTruthy();
    expect(screen.getByText('for Kitchen')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search conversations' }));
  });

  it('current first, then recent chats merged by time across General and spaces, then start new', async () => {
    open(device('thr_t1'));
    await waitFor(() => expect(recentLabels().length).toBeGreaterThan(0));
    const current = within(screen.getByRole('list', { name: 'Current' })).getByRole('listitem');
    expect(current.textContent).toContain('Beds');
    expect(current.textContent).toContain('Current');
    expect(recentLabels().slice(0, 4).map((label) => label.split(/General|Garden/)[0])).toEqual(['Trip plan', 'Seeds', 'Grocery list', 'Recipes']);
    expect(recentLabels()).toHaveLength(8);
    const lists = screen.getAllByRole('list').map((list) => list.getAttribute('aria-labelledby') && list.textContent?.slice(0, 10));
    expect(lists.length).toBe(3);
    expect(screen.getByRole('button', { name: /^New conversation/ })).toBeTruthy();
  });

  it('search reaches everything, and says so when nothing matches', async () => {
    const { user } = open(device(null));
    await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'co');
    expect(within(screen.getByRole('list', { name: 'Matches' })).getAllByRole('listitem').map((i) => i.textContent?.split(/General|Garden/)[0])).toEqual(['Compost']);
    await user.clear(screen.getByRole('textbox', { name: 'Search conversations' }));
    await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'zzz');
    expect(screen.getByRole('heading', { name: 'No chats match "zzz"' })).toBeTruthy();
  });

  it('a General pick uses the default space and closes; a thread pick sends its own space', async () => {
    listed.active_space = { id: GARDEN, name: 'Garden' };
    const conversation = device(null);
    const { user, onOpenChange } = open(conversation);
    await user.click(await screen.findByRole('button', { name: /^Trip plan/ }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(conversation.send).toHaveBeenCalledWith({ conversationId: 'cnv_0', spaceId: GARDEN }, 'card', undefined);
    await user.click(screen.getByRole('button', { name: /^Seeds/ }));
    expect(conversation.send).toHaveBeenLastCalledWith({ conversationId: null, spaceId: GARDEN, threadId: 't0' }, 'card', undefined);
  });

  it('a second pick while one is in flight is ignored: no false "Could not reach" (P0)', async () => {
    const conversation = device(null, 'busy');
    const { user, onOpenChange } = open(conversation);
    await user.click(await screen.findByRole('button', { name: /^Trip plan/ }));
    expect(screen.queryByText(/Could not reach/)).toBeNull();
    expect(screen.queryByText(/Could not/)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('rows are off while a pick is in flight', async () => {
    open(device(null, 'sent', { isSending: true }));
    const row = await screen.findByRole('button', { name: /^Trip plan/ });
    expect(row.hasAttribute('disabled')).toBe(true);
  });

  it('a real failure names the device and keeps the picker open', async () => {
    const { user, onOpenChange } = open(device(null, 'failed'));
    await user.click(await screen.findByRole('button', { name: /^Trip plan/ }));
    expect(await screen.findByText('Could not reach Kitchen.')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('"New conversation" says the actual default space it starts in (P0)', async () => {
    const conversation = device(null);
    const { user } = open(conversation, { defaultSpace: { id: GARDEN, name: 'Garden' } });
    const button = screen.getByRole('button', { name: /^New conversation/ });
    expect(button.textContent).toContain('Starts in Garden');
    expect(screen.queryByText(/New in General/)).toBeNull();
    await user.click(button);
    expect(conversation.send).toHaveBeenCalledWith({ conversationId: null, spaceId: GARDEN }, 'card', undefined);
  });

  it('New in a space creates a thread there and points at it', async () => {
    createThread.mockResolvedValueOnce({ id: 'new-thread' });
    const conversation = device(null);
    const { user } = open(conversation);
    await user.click(screen.getByRole('button', { name: 'New in a space' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Garden' }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith(NEW_THREAD_TITLE));
    await waitFor(() => expect(conversation.send).toHaveBeenCalledWith({ conversationId: null, spaceId: GARDEN, threadId: 'new-thread' }, 'card', undefined));
  });

  it('with 2+ devices from a chat header: choose the device, and the pick targets it with its own space', async () => {
    listed = { devices: [KITCHEN, WORKSHOP], active_space: null, active_conversation: null };
    const conversation = device(null);
    const { user } = open(conversation, { devices: [KITCHEN, WORKSHOP], deviceId: 'd1', canChooseDevice: true });
    await user.click(screen.getByRole('combobox', { name: 'Device' }));
    await user.click(await screen.findByRole('option', { name: 'Workshop' }));
    expect(screen.getByText('for Workshop')).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /^Trip plan/ }));
    expect(conversation.send).toHaveBeenCalledWith({ conversationId: 'cnv_0', spaceId: GARDEN }, 'card', 'd2');
  });

  it('from the device page (scoped) there is no device choice', () => {
    open(device(null), { devices: [KITCHEN, WORKSHOP], deviceId: 'd1' });
    expect(screen.queryByRole('combobox', { name: 'Device' })).toBeNull();
  });
});
