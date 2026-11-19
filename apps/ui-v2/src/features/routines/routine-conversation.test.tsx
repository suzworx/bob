import type { ReactElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { getDraft, resetDrafts, setDraft } from '@/features/chat/drafts';
import { RoutineConversation } from './routine-conversation';
import { BRAND } from '@/lib/brand';

vi.mock('@/lib/auth/use-session', () => ({
  authHeaders: () => ({ Authorization: 'Bearer owner' }),
  fetchWithAuth: (url: string, init?: RequestInit) => fetch(url, init),
  handleUnauthorized: vi.fn(),
}));
vi.mock('@/features/chat/use-mention-members', () => ({ useMentionMembers: () => [] }));
vi.mock('@/features/devices/use-device-conversation', () => ({ useDeviceConversation: () => ({ deviceName: null }) }));

const pointer = (user = 'owner'): string => `bob:routines:conversation:${user}`;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const saved = (id = 'routine-chat'): object => ({ id, title: 'Morning recap', messages: [
  { id: 'user-1', role: 'user', position: 0, versions: [{ selected: true, parts: [{ type: 'text', text: 'Summarize my email daily' }] }] },
  { id: 'answer-1', role: 'assistant', position: 1, versions: [{ selected: true, parts: [{ type: 'text', text: 'What time works for you?' }] }] },
] });
function stream(text: string, id = 'routine-chat'): Response {
  const chunks = [
    { type: 'start', messageId: crypto.randomUUID() },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', messageMetadata: { conversationId: id } },
  ];
  return new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
}
function view(userId = 'owner', onTurnFinished = vi.fn()): ReactElement {
  return <Theme theme={neutralTheme}><RoutineConversation key={userId} userId={userId} onTurnFinished={onTurnFinished} /></Theme>;
}
async function send(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByRole('combobox', { name: 'Message input' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => { sessionStorage.clear(); resetDrafts(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('only sends after an explicit submit, keeps clarification in the same private conversation, and refreshes results', async () => {
  let turns = 0;
  const request = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
    if (String(url) === '/api/chat') return stream(++turns === 1 ? 'What time works for you?' : 'Your recap is scheduled.');
    return json(saved());
  });
  vi.stubGlobal('fetch', request);
  const finished = vi.fn();
  render(view('owner', finished));
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByText('Plan my week')).toBeNull();
  await send('Summarize my email daily');
  await screen.findByText('What time works for you?');
  await waitFor(() => expect(sessionStorage.getItem(pointer())).toBe('routine-chat'));
  await send('8 AM in America/Los_Angeles, with scheduled Gmail access');
  await screen.findByText('Your recap is scheduled.');
  const posts = request.mock.calls.filter(([url]) => String(url) === '/api/chat');
  const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/chat');
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(calls[0]?.[1]?.body))).not.toHaveProperty('id');
  expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({ id: 'routine-chat', message: { role: 'user' } });
  expect(JSON.parse(String(calls[1]?.[1]?.body))).not.toHaveProperty('spaceId');
  expect(finished).toHaveBeenCalledTimes(2);
});

it('restores the persisted transcript after navigation and keeps unsent draft text separate from main chat', async () => {
  sessionStorage.setItem(pointer(), 'routine-chat');
  setDraft('new', 'Private main chat draft');
  setDraft('routines:owner:routine-chat', 'My unfinished schedule');
  const request = vi.fn(async () => json(saved()));
  vi.stubGlobal('fetch', request);
  const first = render(view());
  await screen.findByText('What time works for you?');
  expect(screen.getByRole('combobox', { name: 'Message input' }).textContent).toBe('My unfinished schedule');
  first.unmount();
  render(view());
  await screen.findByText('What time works for you?');
  expect(screen.getByRole('combobox', { name: 'Message input' }).textContent).toBe('My unfinished schedule');
  expect(getDraft('new')).toBe('Private main chat draft');
  expect(request.mock.calls).toHaveLength(2);
});

it('does not show another account transcript or draft, including a late restore response', async () => {
  sessionStorage.setItem(pointer(), 'routine-chat');
  setDraft('routines:owner:routine-chat', 'Owner secret');
  let complete: ((response: Response) => void) | undefined;
  const request = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
  vi.stubGlobal('fetch', request);
  const instance = render(view());
  await screen.findByText('Opening your conversation…');
  instance.rerender(view('other-owner'));
  await act(async () => { complete?.(json(saved())); });
  expect(screen.queryByText('What time works for you?')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Message input' }).textContent).toBe('');
  expect(sessionStorage.getItem(pointer('other-owner'))).toBeNull();
});

it('clears a deleted or inaccessible pointer and offers a fresh composer without sending', async () => {
  sessionStorage.setItem(pointer(), 'gone-chat');
  const request = vi.fn(async () => json({}, 404));
  vi.stubGlobal('fetch', request);
  render(view());
  await screen.findByText('That conversation is no longer here. You can start a fresh one.');
  expect(sessionStorage.getItem(pointer())).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Message input' })).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps a temporarily unavailable conversation and retries without creating a replacement', async () => {
  sessionStorage.setItem(pointer(), 'routine-chat');
  const request = vi.fn(async () => json({}, 503));
  vi.stubGlobal('fetch', request);
  render(view());
  await screen.findByText("Couldn't open your routine conversation");
  expect(screen.queryByRole('combobox', { name: 'Message input' })).toBeNull();
  expect(sessionStorage.getItem(pointer())).toBe('routine-chat');
  request.mockImplementation(async () => json(saved()));
  await userEvent.click(screen.getByRole('button', { name: 'Retry conversation' }));
  await screen.findByText('What time works for you?');
  expect(request).toHaveBeenCalledTimes(2);
});

it('shows the shared chat failure and retry controls without claiming a routine was created', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unavailable' }, 503)));
  render(view());
  await send('Create my morning recap');
  await screen.findByText(`${BRAND.assistantName} couldn't finish that.`);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(sessionStorage.getItem(pointer())).toBeNull();
});
