import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { DeviceHeaderControl, type DeviceHeaderTarget } from './device-header-control';
import { useDeviceConversation } from './use-device-conversation';

// The picker's lists (#668); its own tests cover them.
vi.mock('@/features/chat/use-conversation-list', () => ({
  useConversationList: () => ({ conversations: [{ id: 'c9', title: 'Trip plan', createdAt: 1, updatedAt: 1 }] }),
}));
vi.mock('@/features/spaces/use-spaces', () => ({ useOptionalSpaces: () => ({ spaces: [] }) }));
vi.mock('@/features/spaces/use-threads', () => ({ useThreads: () => ({ threads: [], createThread: vi.fn() }) }));
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.removeAttribute('open');
};

let serverActive: { conversation_id: string; title: string } | null;
let putStatus: number;
// The account's paired devices (GET /api/devices); one unnamed by default.
let paired: Array<Record<string, unknown>>;
const ONE = { id: 'd1', name: 'Kitchen', model: 'Bob', connected: false, live: { connected: false }, active_conversation_id: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function puts(): unknown[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === '/api/devices/active-conversation' && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)));
}

// The PUT's answer: the configured failure, else the pointer moves where the body says.
function answerPut(init: RequestInit): Response {
  if (putStatus === 202) return json({ status: 'pending' }, 202);
  if (putStatus === 409) return json({ error: { code: 'no_device' } }, 409);
  if (putStatus !== 200) return json({ error: { code: 'x' } }, putStatus);
  const body = JSON.parse(String(init.body)) as { conversation_id: string | null; thread_id?: string };
  const id = body.thread_id === undefined ? body.conversation_id : `thr_${body.thread_id}`;
  serverActive = id === null ? null : { conversation_id: id, title: 'Trip plan' };
  return json({});
}

function Harness({ target }: { target: DeviceHeaderTarget }): ReactElement {
  const device = useDeviceConversation();
  return <DeviceHeaderControl device={device} target={target} statusKey="here" />;
}

function renderControl(target: DeviceHeaderTarget): void {
  render(
    <Theme theme={neutralTheme}>
      <Harness target={target} />
    </Theme>,
  );
}

describe('DeviceHeaderControl', () => {
  beforeEach(() => {
    serverActive = null;
    putStatus = 200;
    paired = [ONE];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/active') return json({ active: serverActive });
        if (url === '/api/devices') {
          return json({ devices: paired, active_space: null, active_conversation: serverActive && { id: serverActive.conversation_id, title: serverActive.title } });
        }
        if (url === '/api/devices/active-conversation' && init?.method === 'PUT') return answerPut(init);
        throw new Error(`unrouted fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing while the account has no paired device (P0)', async () => {
    paired = [];
    renderControl({ conversationId: 'c1' });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/devices')).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /^Use on/ })).toBeNull();
    expect(screen.queryByRole('button', { name: / options$/ })).toBeNull();
  });

  it('with 2+ devices: the picks go to the chosen device, never account-wide (P0)', async () => {
    const workshop = { ...ONE, id: 'd2', name: 'Workshop', connected: true, live: { connected: true } };
    paired = [ONE, workshop];
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    // The online one is the default.
    await user.click(await screen.findByRole('button', { name: 'Use on Workshop' }));
    await waitFor(() => expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null, device_id: 'd2' }]));
    await user.click(screen.getByRole('button', { name: 'Workshop options' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Change conversation/ }));
    const dialog = await screen.findByRole('dialog', { name: /^Change conversation/ });
    expect(within(dialog).getByRole('combobox', { name: 'Device' })).toBeTruthy();
  });

  it('a double click sends once and never says it failed (P0)', async () => {
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    const button = await screen.findByRole('button', { name: 'Use on Kitchen' });
    await user.dblClick(button);
    await screen.findByText('Sent to Kitchen.');
    expect(puts()).toHaveLength(1);
    expect(screen.queryByText(/Could not reach/)).toBeNull();
  });

  it('not on the device: a labelled button, one click moves it, then On device', async () => {
    serverActive = { conversation_id: 'c2', title: 'Groceries' };
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    expect(await screen.findByText('On Kitchen: Groceries')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use on Kitchen' }));
    expect(await screen.findByText('Sent to Kitchen.')).toBeTruthy();
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null }]);
    expect(screen.getByText('On Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use on Kitchen' })).toBeNull();
  });

  it('on the device: the status, and the menu starts a new conversation', async () => {
    serverActive = { conversation_id: 'thr_t1', title: 'Groceries' };
    const user = userEvent.setup();
    renderControl({ threadId: 't1', spaceId: 's1', spaceName: 'Home' });
    expect(await screen.findByText('On Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use on Kitchen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Kitchen options' }));
    await user.click(await screen.findByRole('menuitem', { name: /^New conversation on Kitchen/ }));
    await screen.findByText('Sent to Kitchen.');
    expect(puts()).toEqual([{ conversation_id: null, space_id: 's1' }]);
  });

  it('a thread sends its id in its space', async () => {
    const user = userEvent.setup();
    renderControl({ threadId: 't1', spaceId: 's1' });
    await user.click(await screen.findByRole('button', { name: 'Use on Kitchen' }));
    await screen.findByText('Sent to Kitchen.');
    expect(puts()).toEqual([{ conversation_id: null, space_id: 's1', thread_id: 't1' }]);
  });

  it.each([
    [409, 'Kitchen is not connected.'],
    [500, 'Could not reach Kitchen.'],
  ])('answers %i honestly and never pretends it moved', async (status, text) => {
    putStatus = status;
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    await user.click(await screen.findByRole('button', { name: 'Use on Kitchen' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use on Kitchen' })).toBeTruthy();
    expect(screen.queryByText('On Kitchen')).toBeNull();
  });

  it('follows bob:active-changed without a click', async () => {
    renderControl({ conversationId: 'c1' });
    await screen.findByRole('button', { name: 'Use on Kitchen' });
    serverActive = { conversation_id: 'c1', title: 'Trip plan' };
    act(() => {
      window.dispatchEvent(new Event('bob:active-changed'));
    });
    expect(await screen.findByText('On Kitchen')).toBeTruthy();
  });

  it('an offline device: says the pick is pending until it reconnects', async () => {
    putStatus = 202;
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    await user.click(await screen.findByRole('button', { name: 'Use on Kitchen' }));
    expect(await screen.findByText('Pending — applies when Kitchen reconnects.')).toBeTruthy();
  });

  it('Change conversation… opens the Devices page picker, and a pick moves the pointer', async () => {
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    await user.click(await screen.findByRole('button', { name: 'Kitchen options' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Change conversation/ }));
    expect(await screen.findByRole('dialog', { name: /^Change conversation/ })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /^Trip plan/ }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()).toEqual([{ conversation_id: 'c9', space_id: null }]);
  });
});

describe('DeviceHeaderControl names the paired device (WS185-SERVER)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url === '/api/active') return json({ active: null });
        if (url === '/api/devices') {
          return json({ devices: [{ id: 'd1', name: 'Round Bob', model: 'Bob', live: { connected: true } }], active_space: null });
        }
        throw new Error(`unrouted fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('labels the button and the menu with the device name, not Cardputer', async () => {
    const user = userEvent.setup();
    renderControl({ conversationId: 'c1' });
    expect(await screen.findByRole('button', { name: 'Use on Round Bob' })).toBeTruthy();
    expect(screen.queryByText(/Cardputer/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Round Bob options' }));
    expect(await screen.findByRole('menuitem', { name: /^New conversation on Round Bob/ })).toBeTruthy();
  });
});
