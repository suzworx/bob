import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { AppShellMobileContext } from '@astryxdesign/core/AppShell';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { buildChatRequestBody, ChatSurface, type ChatAppBinding } from './chat-surface';
import { getDraft, resetDrafts } from './drafts';
import type { ChatSlotProps } from '../../app/shell';

// A draft typed in one test must not come back in the next one's composer.
beforeEach(resetDrafts);

const SUGGESTION_HEADINGS = ['Plan my week', "What's on today?", 'Remember something'];

// What the "Plan my week" card puts in the composer.
const PLAN_PROMPT = 'Plan my week using my tasks and events.';

// A landing card only fills the composer; sending it is a second step.
async function sendPlanFromLanding(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByText('Plan my week'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
  );
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

function textMessage(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// A v7 UI message stream: SSE frames plus the protocol header.
function uiMessageStream(chunks: unknown[]): Response {
  const frames = [...chunks.map((chunk) => JSON.stringify(chunk)), '[DONE]'];
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

const REPLY_STREAM = [
  { type: 'start', messageId: 'a1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Here is ' },
  { type: 'text-delta', id: 't1', delta: 'your week.' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', messageMetadata: { conversationId: 'c9' } },
];

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (url === '/api/spaces') return json({ spaces: [] });
    if (url === '/api/chat') return uiMessageStream(REPLY_STREAM);
    throw new Error(`unrouted fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderSurface(overrides: Partial<ChatSlotProps> & { appBinding?: ChatAppBinding } = {}): ChatSlotProps & { appBinding?: ChatAppBinding } {
  const props: ChatSlotProps & { appBinding?: ChatAppBinding } = {
    conversationId: null,
    initialMessages: [],
    userName: 'Ann',
    onConversationTouched: vi.fn(),
    onConversationCreated: vi.fn(),
    ...overrides,
  };
  render(
    <Theme theme={neutralTheme} mode="system">
      <SpacesProvider>
        <ChatSurface {...props} />
      </SpacesProvider>
    </Theme>,
  );
  return props;
}

const mobileShell = { isMobile: false, isMobileNavOpen: false, toggleMobileNav() {}, openMobileNav() {}, closeMobileNav() {}, isMobileNavEnabled: false, hasAutoToggle: true };

describe('buildChatRequestBody', () => {
  const thread = [
    textMessage('u1', 'user', 'first'),
    textMessage('a1', 'assistant', 'reply'),
    textMessage('u2', 'user', 'second'),
    textMessage('a2', 'assistant', 'reply two'),
  ];

  it('omits the id for a new conversation', () => {
    const body = buildChatRequestBody(null, thread, 'submit-message');
    expect('id' in body).toBe(false);
  });

  it('carries the id for an existing conversation', () => {
    expect(buildChatRequestBody('c1', thread, 'submit-message').id).toBe('c1');
  });

  it('sets regenerate only for regenerate-message', () => {
    expect(buildChatRequestBody('c1', thread, 'regenerate-message').regenerate).toBe(true);
    expect(buildChatRequestBody('c1', thread, 'submit-message').regenerate).toBeUndefined();
  });

  it('carries the voice workflow id for the submitted utterance only', () => {
    const workflowId = 'd9e97f70-89ad-4096-a962-a8d5e322308e';
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, 'web_voice', workflowId).workflowId).toBe(workflowId);
    expect(buildChatRequestBody('c1', thread, 'regenerate-message', undefined, 'web_voice', workflowId).workflowId).toBeUndefined();
  });

  it('sends the newest user message', () => {
    expect(buildChatRequestBody(null, thread, 'submit-message').message).toEqual({
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: 'second' }],
    });
  });

  it('is unchanged without an edit or an origin', () => {
    const plain = buildChatRequestBody('c1', thread, 'submit-message');
    expect(Object.keys(plain).sort()).toEqual(['id', 'message', 'regenerate']);
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined)).toEqual(plain);
  });

  it('adds the edit it is given, and only that', () => {
    expect(buildChatRequestBody('c1', thread, 'submit-message', { editFrom: 'a1' })).toMatchObject({
      editFrom: 'a1',
    });
    const fromStart = buildChatRequestBody('c1', thread, 'submit-message', { editFromStart: true });
    expect(fromStart.editFromStart).toBe(true);
    expect('editFrom' in fromStart).toBe(false);
  });

  it('adds the origin only when the turn was spoken', () => {
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, 'web_voice').origin).toBe(
      'web_voice',
    );
    expect('origin' in buildChatRequestBody('c1', thread, 'submit-message')).toBe(false);
  });

  const binding = { installationId: '6f1d2a3e-4b5c-4d6e-8f70-123456789abc', mode: 'run' as const };

  it('adds the app binding as the trailing argument, and only when given', () => {
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, binding).appBinding).toEqual(binding);
    expect('appBinding' in buildChatRequestBody('c1', thread, 'submit-message')).toBe(false);
  });

  it('carries only the targeting fields of a binding, never extra ones', () => {
    const smuggled = { ...binding, owner: 'someone', tool: 'campaign.create' } as typeof binding;
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, smuggled).appBinding).toEqual(binding);
  });

  it('keeps the binding on a regenerate and on an edit', () => {
    expect(buildChatRequestBody('c1', thread, 'regenerate-message', undefined, undefined, undefined, binding)).toMatchObject({
      regenerate: true,
      appBinding: binding,
    });
    expect(buildChatRequestBody('c1', thread, 'submit-message', { editFrom: 'a1' }, undefined, undefined, binding)).toMatchObject({
      editFrom: 'a1',
      appBinding: binding,
    });
  });

  it('copies the requested channel into the binding, and drops any field beyond the targeting ones', () => {
    const instagram = { ...binding, channel: 'instagram' as const };
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, instagram).appBinding).toEqual(instagram);
    const smuggled = { ...instagram, owner: 'someone' } as typeof instagram;
    expect(buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, smuggled).appBinding).toEqual(instagram);
  });

  it('has no channel key when all channels are requested', () => {
    const body = buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, binding);
    expect(Object.keys(body.appBinding as object).sort()).toEqual(['installationId', 'mode']);
  });

  it('keeps the channel on a regenerate and on an edit', () => {
    const linkedin = { ...binding, channel: 'linkedin' as const };
    expect(buildChatRequestBody('c1', thread, 'regenerate-message', undefined, undefined, undefined, linkedin)).toMatchObject({
      regenerate: true,
      appBinding: linkedin,
    });
    expect(buildChatRequestBody('c1', thread, 'submit-message', { editFrom: 'a1' }, undefined, undefined, linkedin)).toMatchObject({
      editFrom: 'a1',
      appBinding: linkedin,
    });
  });

  it('copies the requested campaign beside the channel without adding an id or changing copy', () => {
    const campaign = { ...binding, channel: 'instagram' as const, campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc' };
    const original = textMessage('u-new', 'user', 'Spring  sale, teh post');
    const body = buildChatRequestBody(null, [original], 'submit-message', undefined, undefined, undefined, campaign);
    expect(body.appBinding).toEqual(campaign);
    expect(body.message).toEqual(original);
    expect(body).not.toHaveProperty('id');
  });

  it('copies only known binding fields alongside a requested campaign', () => {
    const campaign = { ...binding, campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc' };
    const smuggled = { ...campaign, owner: 'someone', grant: true, campaign: {}, tool: 'campaign.create', context: {}, approval: true };
    const body = buildChatRequestBody('c1', thread, 'submit-message', undefined, undefined, undefined, smuggled);
    expect(body.appBinding).toEqual(campaign);
    expect(Object.keys(body.appBinding as object).sort()).toEqual(['campaignId', 'installationId', 'mode']);
  });

  it('omits a campaign target when only the original message contains its UUID', () => {
    const original = textMessage('u-new', 'user', 'Use a3c14d67-7e9f-4a82-8b03-123456789abc,  teh one');
    const body = buildChatRequestBody(null, [original], 'submit-message', undefined, undefined, undefined, binding);
    expect(body.appBinding).toEqual(binding);
    expect(body.appBinding).not.toHaveProperty('campaignId');
    expect(body.message).toEqual(original);
  });

  it.each(['posts', 'campaign'] as const)('carries the selected %s workflow beside the saved target and unchanged rough copy', (intent) => {
    const requested = { ...binding, channel: 'instagram' as const, campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc', intent };
    const original = textMessage('u-workflow', 'user', 'Spring  sale, teh post');
    const body = buildChatRequestBody(null, [original], 'submit-message', undefined, undefined, undefined, requested);
    expect(body.appBinding).toEqual(requested);
    expect(body.message).toEqual(original);
    expect(body).not.toHaveProperty('id');
  });

  it('omits run intent when the mounted binding switches to Refine app', () => {
    const stalePreference = { ...binding, mode: 'refine' as const, intent: 'posts' as const };
    const original = textMessage('u-refine', 'user', 'rough  copy');
    const body = buildChatRequestBody('c1', [original], 'submit-message', undefined, undefined, undefined, stalePreference);
    expect(body.appBinding).toEqual({ installationId: binding.installationId, mode: 'refine' });
    expect(body.message).toEqual(original);
  });
});

describe('ChatSurface', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the landing for an empty conversation', async () => {
    renderSurface();
    expect(await screen.findByText('Hi, Ann')).toBeTruthy();
    expect(screen.getByText('Where should we start?')).toBeTruthy();
    for (const heading of SUGGESTION_HEADINGS) expect(screen.getByText(heading)).toBeTruthy();
    // P0 composer contract: one placeholder for every chat.
    expect(screen.getByText('Ask Bob anything')).toBeTruthy();
  });

  it('renders the restored thread with Markdown and a tool call', async () => {
    renderSurface({
      initialMessages: [
        textMessage('u1', 'user', 'hello @ann'),
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'text', text: '**bold**' },
            { type: 'tool-getWeather', toolCallId: 't1', state: 'output-available', input: {}, output: {} },
          ],
        } as UIMessage,
      ],
    });
    expect(await screen.findByText(/hello/)).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    // Plain words, never the raw tool name.
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.queryByText('getWeather')).toBeNull();
  });

  it('posts a clicked prompt to /api/chat and hands the new conversation up', async () => {
    const user = userEvent.setup();
    const props = renderSurface();
    await sendPlanFromLanding(user);

    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/chat');
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect('id' in body).toBe(false);
    expect(body.regenerate).toBeUndefined();
    expect(body.message).toEqual({
      id: expect.any(String),
      role: 'user',
      parts: [{ type: 'text', text: PLAN_PROMPT }],
    });

    await waitFor(() => expect(props.onConversationCreated).toHaveBeenCalledWith('c9', expect.any(Array)));
    const handedUp = vi.mocked(props.onConversationCreated).mock.calls[0][1];
    expect(handedUp.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(handedUp[1].parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Here is your week.' }),
    );
    expect(props.onConversationTouched).toHaveBeenCalled();
  });

  it('sends the app binding on a fresh send, and no binding when the surface has none', async () => {
    const binding = { installationId: '6f1d2a3e-4b5c-4d6e-8f70-123456789abc', mode: 'refine' as const };
    const sent = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/chat');
    const user = userEvent.setup();
    renderSurface({ appBinding: binding });
    await sendPlanFromLanding(user);
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect((JSON.parse(String(sent()[0][1]?.body)) as Record<string, unknown>).appBinding).toEqual(binding);
  });

  it('sends no app binding from a surface that was given none', async () => {
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/chat')).toBe(true));
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/chat');
    expect('appBinding' in (JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>)).toBe(false);
  });

  it('fills the composer from a suggestion without sending, and Send then sends it', async () => {
    const user = userEvent.setup();
    renderSurface();
    const chatCalls = (): unknown[] =>
      vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/chat');
    const box = await screen.findByRole('combobox', { name: 'Message input' });

    await user.click(await screen.findByText('Plan my week'));
    await waitFor(() => expect(box.textContent).toBe(PLAN_PROMPT));
    expect(document.activeElement).toBe(box);
    // Filled, not sent: still the landing, and no request has been made.
    expect(screen.getByText('Hi, Ann')).toBeTruthy();
    expect(chatCalls()).toHaveLength(0);

    // A second chip replaces what the first one put there.
    await user.click(screen.getByText('Remember something'));
    await waitFor(() => expect(box.textContent).toBe('Remember this for me:'));
    expect(chatCalls()).toHaveLength(0);

    await user.click(screen.getByText('Plan my week'));
    await waitFor(() => expect(box.textContent).toBe(PLAN_PROMPT));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    expect(chatCalls()).toHaveLength(1);
    const body = JSON.parse(String((chatCalls()[0] as [unknown, RequestInit])[1].body)) as {
      message: { parts: unknown[] };
    };
    expect(body.message.parts).toEqual([{ type: 'text', text: PLAN_PROMPT }]);
  });

  it('looks members up once however many messages the thread holds', async () => {
    const space = {
      id: 's1',
      kind: 'group',
      name: 'Home',
      role: 'owner',
      membership_revision: 1,
      created_at: 0,
      updated_at: 0,
    };
    const ann = {
      user_id: 'u1',
      role: 'owner',
      joined_at: 0,
      display_name: 'Ann',
      handle: 'ann',
      email: 'ann@example.com',
    };

    // Renders a thread with `userMessages` exchanges and returns the paths of
    // the member-list requests it made once the space and member fetches settled
    // (the stored @ann has become a chip, which needs the loaded members).
    const memberRequests = async (userMessages: number): Promise<string[]> => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url === '/api/spaces') return json({ spaces: [space] });
        if (url.endsWith('/members')) {
          return json({ members: url === '/api/spaces/s1/members' ? [ann] : [] });
        }
        throw new Error(`unrouted fetch: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const initialMessages = Array.from({ length: userMessages }, (_, index) => [
        textMessage(`u${index}`, 'user', `hello @ann ${index}`),
        textMessage(`a${index}`, 'assistant', `reply ${index}`),
      ]).flat();
      renderSurface({ initialMessages });
      const paths = (): string[] => fetchMock.mock.calls.map(([input]) => String(input));
      await waitFor(() => expect(paths()).toContain('/api/spaces/s1/members'));
      expect((await screen.findAllByText('Ann')).length).toBeGreaterThan(0);
      const requested = paths().filter((path) => path.endsWith('/members'));
      cleanup();
      return requested;
    };

    const one = await memberRequests(1);
    const three = await memberRequests(3);
    // The thread growing adds no member requests, and useMentionMembers adds
    // none of its own: the only one is SpacesProvider's, for the one space.
    expect(one).toEqual(['/api/spaces/s1/members']);
    expect(three).toEqual(['/api/spaces/s1/members']);
  });

  it('stops the request and stays silent when unmounted mid-reply', async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    const frame = (chunk: unknown): Uint8Array =>
      encoder.encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
    // The /api/chat reply is a stream the test holds open: the first chunks go
    // out at once, the rest (with the finish metadata) only when told to.
    const held: { signal?: AbortSignal | null; stream?: ReadableStreamDefaultController<Uint8Array> } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/spaces') return json({ spaces: [] });
        if (url !== '/api/chat') throw new Error(`unrouted fetch: ${url}`);
        held.signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            held.stream = controller;
            for (const chunk of REPLY_STREAM.slice(0, 3)) controller.enqueue(frame(chunk));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        });
      }),
    );

    const props = renderSurface();
    await sendPlanFromLanding(user);
    await waitFor(() => expect(held.signal).toBeTruthy());

    // The shell unmounts the surface when the reader switches conversation.
    cleanup();
    expect(held.signal?.aborted).toBe(true);

    // The reply ending now must not pull the reader back to this chat.
    for (const chunk of [...REPLY_STREAM.slice(3), '[DONE]']) held.stream?.enqueue(frame(chunk));
    held.stream?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(props.onConversationCreated).not.toHaveBeenCalled();
    expect(props.onConversationTouched).not.toHaveBeenCalled();
  });

  // #466: a /api/chat reply held open mid-stream; /api/chat/stop answers or fails.
  const holdChat = (stopFails = false) => {
    const encoder = new TextEncoder();
    const held: { signal?: AbortSignal | null; sentId?: string } = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === '/api/spaces') return json({ spaces: [] });
      if (url === '/api/chat/stop') {
        if (stopFails) throw new TypeError('Failed to fetch');
        return json({ stopped: true });
      }
      if (url !== '/api/chat') throw new Error(`unrouted fetch: ${url}`);
      held.signal = init?.signal;
      held.sentId = (JSON.parse(String(init?.body)) as { message: { id: string } }).message.id;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of REPLY_STREAM.slice(0, 3)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const stopCalls = (): Array<[input: RequestInfo | URL, init?: RequestInit]> =>
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/chat/stop');
    return { held, stopCalls };
  };

  for (const stopFails of [false, true]) {
    it(`Stop tells the server once, by the sent message id, then stops${stopFails ? ' (POST fails, silently)' : ''}`, async () => {
      const user = userEvent.setup();
      const { held, stopCalls } = holdChat(stopFails);
      renderSurface();
      await sendPlanFromLanding(user);
      await waitFor(() => expect(held.signal).toBeTruthy());
      await user.click(await screen.findByRole('button', { name: /stop/i }));
      await waitFor(() => expect(held.signal?.aborted).toBe(true));
      expect(stopCalls()).toHaveLength(1);
      expect(stopCalls()[0][1]?.method).toBe('POST');
      expect(JSON.parse(String(stopCalls()[0][1]?.body))).toEqual({ messageId: held.sentId });
      expect(screen.queryByRole('alert')).toBeNull();
    });
  }

  it('leaving mid-reply (unmount) stops the stream without telling the server to stop', async () => {
    const user = userEvent.setup();
    const { held, stopCalls } = holdChat();
    renderSurface();
    await sendPlanFromLanding(user);
    await waitFor(() => expect(held.signal).toBeTruthy());
    cleanup();
    expect(held.signal?.aborted).toBe(true);
    expect(stopCalls()).toHaveLength(0);
  });
});

// One canned /api/chat stream per request, in order; the last one repeats.
function stubChat(streams: unknown[][]): { bodies: () => Record<string, unknown>[] } {
  let call = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (url === '/api/spaces') return json({ spaces: [] });
    if (url === '/api/chat') return uiMessageStream(streams[Math.min(call++, streams.length - 1)]);
    throw new Error(`unrouted fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    bodies: () =>
      fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/chat')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>),
  };
}

function replyStream(text: string, messageId: string, before: unknown[] = []): unknown[] {
  return [
    { type: 'start', messageId },
    ...before,
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', messageMetadata: { conversationId: 'c9' } },
  ];
}

const EXCHANGES = [
  textMessage('u1', 'user', 'first question'),
  textMessage('a1', 'assistant', 'reply one'),
  textMessage('u2', 'user', 'second question'),
  textMessage('a2', 'assistant', 'reply two'),
];

describe('ChatSurface message extras', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the reasoning disclosure once the reply has streamed', async () => {
    stubChat([
      replyStream('Here is your week.', 'a1', [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Checking the calendar' },
        { type: 'reasoning-end', id: 'r1' },
      ]),
    ]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByRole('button', { name: /Thought for/ })).toBeTruthy();
    expect(document.body.textContent).toContain('Here is your week.');
  });

  it('renders the local-stub notice from a data-stub part', async () => {
    stubChat([replyStream('Stubbed.', 'a1', [{ type: 'data-stub', data: { stub: true } }])]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText('System test mode: this response is a local stub.')).toBeTruthy();
  });

  it('notes a message whose origin metadata is device', async () => {
    stubChat([replyStream('unused', 'a9')]);
    const spoken = { ...textMessage('u1', 'user', 'hello'), metadata: { origin: 'device' } } as UIMessage;
    renderSurface({
      conversationId: 'c1',
      initialMessages: [spoken, textMessage('a1', 'assistant', 'hi there')],
    });
    expect(await screen.findByText('via your device')).toBeTruthy();
    expect(screen.queryByText(/Cardputer/)).toBeNull();
  });

  it('copies a reply and shows Copied', async () => {
    stubChat([replyStream('unused', 'a9')]);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES.slice(0, 2) });
    await user.click(await screen.findByRole('button', { name: 'Copy response' }));
    expect(writeText).toHaveBeenCalledWith('reply one');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('keeps the conversation title visible above the transcript', async () => {
    stubChat([replyStream('unused', 'a9')]);
    const props = { conversationId: 'c1', conversationTitle: 'Weekend plans', initialMessages: EXCHANGES.slice(0, 2) };
    renderSurface(props);
    expect(await screen.findByRole('heading', { level: 1, name: 'Weekend plans' })).toBeTruthy();
  });

  it('shows a toast when copying fails', async () => {
    stubChat([replyStream('unused', 'a9')]);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES.slice(0, 2) });
    await user.click(await screen.findByRole('button', { name: 'Copy response' }));
    const notice = await screen.findByText("Couldn't copy. Select the text to copy it yourself.");
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });
});

describe('ChatSurface regenerate, versions and edit', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers regenerate on the last reply only, and no selector for one version', async () => {
    stubChat([replyStream('unused', 'a9')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    expect(await screen.findAllByRole('button', { name: 'Regenerate reply' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Previous version' })).toBeNull();
    expect(screen.queryByText(/\d of \d/)).toBeNull();
  });

  it('regenerates the last reply and then offers both versions', async () => {
    const chat = stubChat([replyStream('A second take.', 'a3')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await user.click(await screen.findByRole('button', { name: 'Regenerate reply' }));

    expect(await screen.findByText('2 of 2')).toBeTruthy();
    expect(chat.bodies()).toHaveLength(1);
    expect(chat.bodies()[0].regenerate).toBe(true);
    expect(chat.bodies()[0].message).toEqual({
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: 'second question' }],
    });
    expect(document.body.textContent).toContain('A second take.');
    expect(document.body.textContent).not.toContain('reply two');

    await user.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(document.body.textContent).toContain('reply two');
    expect(document.body.textContent).not.toContain('A second take.');
  });

  const binding = { installationId: '6f1d2a3e-4b5c-4d6e-8f70-123456789abc', mode: 'run' as const };

  it('keeps the app binding on a regenerate', async () => {
    const chat = stubChat([replyStream('A second take.', 'a3')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: binding });
    await user.click(await screen.findByRole('button', { name: 'Regenerate reply' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ regenerate: true, appBinding: binding });
  });

  it('keeps the app binding on an edit and resend', async () => {
    const chat = stubChat([replyStream('Fresh answer.', 'a9')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: binding });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    await user.click(edits[1]);
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    await user.type(box, 'a sharper question');
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ editFrom: expect.any(String), appBinding: binding });
  });

  it('truncates the thread at an edited message and sends the new text', async () => {
    const chat = stubChat([replyStream('Fresh answer.', 'a9')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    await user.click(edits[1]);
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    await user.type(box, 'a sharper question');
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));

    await waitFor(() => expect(document.body.textContent).toContain('Fresh answer.'));
    expect(chat.bodies()).toHaveLength(1);
    expect(chat.bodies()[0].message).toEqual({
      id: expect.any(String),
      role: 'user',
      parts: [{ type: 'text', text: 'a sharper question' }],
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('first question');
    expect(text).toContain('reply one');
    expect(text).toContain('a sharper question');
    expect(text).not.toContain('second question');
    expect(text).not.toContain('reply two');
  });

  it('sends nothing when the edit is unchanged', async () => {
    const chat = stubChat([replyStream('unused', 'a9')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    await user.click(edits[1]);
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));
    expect(chat.bodies()).toHaveLength(0);
    expect(document.body.textContent).toContain('reply two');
  });
});

// /api/chat answers one canned Response per request, in order (the last one
// repeats). GET /api/conversations/c1 is the read-back the surface makes after
// a clean turn; `conversation` gets the 1-based number of that read.
function stubTurns(
  chats: Array<() => Response>,
  conversation: (read: number) => Response = () => json({ messages: [{ role: 'assistant' }] }),
): { bodies: () => Record<string, unknown>[]; reads: () => number } {
  let call = 0;
  let reads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === '/api/spaces') return json({ spaces: [] });
    if (url === '/api/chat') return chats[Math.min(call++, chats.length - 1)]();
    if (url === '/api/conversations/c1') {
      reads += 1;
      return conversation(reads);
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    bodies: () =>
      fetchMock.mock.calls
        .filter(([input]) => String(input) === '/api/chat')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>),
    reads: () => reads,
  };
}

const goodReply = (messageId: string) => (): Response =>
  uiMessageStream(replyStream('Here is your week.', messageId));
const droppedReply = (): Response =>
  uiMessageStream([
    { type: 'start', messageId: 'a1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Half of your ' },
    { type: 'error', errorText: 'upstream closed' },
  ]);
const refusedReply = (): Response => new Response('boom', { status: 500 });

const DROPPED = 'The connection dropped mid-reply.';
const NOT_COMPLETED = "Bob couldn't finish that.";
const OUT_OF_CREDIT = 'Bob needs a rest: the usage limit is reached.';

async function editAndResend(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Edit and resend this message' }));
  const box = screen.getByRole('textbox', { name: 'Edit your message' });
  await user.clear(box);
  await user.type(box, text);
  await user.click(screen.getByRole('button', { name: 'Send edited message' }));
}

describe('ChatSurface failed turns', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('names a connection dropped after text streamed, and Retry regenerates', async () => {
    const chat = stubTurns([droppedReply, goodReply('a2')]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);

    expect(await screen.findByText(DROPPED)).toBeTruthy();
    expect(screen.queryByText(NOT_COMPLETED)).toBeNull();
    expect(screen.queryByText('The reply could not be completed. Try again.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    expect(screen.queryByText(DROPPED)).toBeNull();
    expect(document.body.textContent).not.toContain('Half of your');
    expect(chat.bodies()).toHaveLength(2);
    expect(chat.bodies()[1].regenerate).toBe(true);
    expect(chat.bodies()[1].message).toEqual({
      id: expect.any(String),
      role: 'user',
      parts: [{ type: 'text', text: PLAN_PROMPT }],
    });
  });

  it('reports a plain failure when the turn errors before any text', async () => {
    const chat = stubTurns([refusedReply]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);

    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(DROPPED)).toBeNull();
    expect(chat.bodies()).toHaveLength(1);
  });

  it.each([
    ['before the stream (503)', (): Response => new Response(JSON.stringify({ error: { code: 'out_of_credit', message: 'The AI service is out of credit.' } }), { status: 503 })],
    ['mid-stream', (): Response => uiMessageStream([{ type: 'start', messageId: 'a1' }, { type: 'error', errorText: 'out_of_credit' }])],
  ])('#1041: says plainly the service is out of credit when the budget is spent %s', async (_when, reply) => {
    stubTurns([reply]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);

    expect(await screen.findByText(OUT_OF_CREDIT)).toBeTruthy();
    expect(screen.queryByText(NOT_COMPLETED)).toBeNull();
    // A Retry would only fail again: it points at usage instead.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'See usage' })).toBeTruthy();
  });

  it('#1396: Retry after a refused send resends the exact message, not a regenerate', async () => {
    const chat = stubTurns([refusedReply, goodReply('a3')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), 'the typed text');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(2));
    const [first, second] = chat.bodies();
    expect(second).not.toHaveProperty('regenerate');
    expect(second.resend).toBe(true);
    expect(second.message).toEqual(first.message);
    expect(second.message).toMatchObject({ parts: [{ type: 'text', text: 'the typed text' }] });
    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
  });

  it('#1396: Retry with no conversation yet resends rather than regenerating', async () => {
    const chat = stubTurns([refusedReply, goodReply('a2')]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(2));
    expect(chat.bodies()[1]).not.toHaveProperty('regenerate');
    expect(chat.bodies()[1]).not.toHaveProperty('id');
    expect(chat.bodies()[1].resend).toBe(true);
    expect(chat.bodies()[1].message).toEqual(chat.bodies()[0].message);
  });

  it('#1396: a second Retry still resends the same message', async () => {
    const chat = stubTurns([refusedReply, refusedReply, goodReply('a2')]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(2));
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(3));
    expect(chat.bodies()[2].resend).toBe(true);
    expect(chat.bodies()[2].message).toEqual(chat.bodies()[0].message);
  });

  it('#1396: shows the kind reason the server gave for refusing the turn, and keeps Retry', async () => {
    const reason = 'That app is no longer available. Open My Apps to choose an active app.';
    stubTurns([(): Response => new Response(JSON.stringify({ error: { code: 'not_found', message: reason } }), { status: 404 })]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.queryByText(NOT_COMPLETED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('#1396: never shows a server message outside the kind refusals', async () => {
    stubTurns([(): Response => new Response(JSON.stringify({ error: { code: 'store_error', message: 'internal detail' } }), { status: 500 })]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    expect(screen.queryByText('internal detail')).toBeNull();
  });

  it('#1396: shows the true reason when the app is paused', async () => {
    const reason = 'Marketing is paused. Resume it to keep going; your text is still here.';
    stubTurns([(): Response => new Response(JSON.stringify({ error: { code: 'app_paused', message: reason } }), { status: 409 })]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(reason)).toBeTruthy();
  });

  it('#1396: tells the host whether the finished turn succeeded', async () => {
    stubTurns([refusedReply, goodReply('a2')]);
    const user = userEvent.setup();
    const props = renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    await waitFor(() => expect(props.onConversationTouched).toHaveBeenLastCalledWith({ succeeded: false }));
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'Plan my month');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(props.onConversationTouched).toHaveBeenLastCalledWith({ succeeded: true }));
  });

  it('clears the failure notice when the reader sends again', async () => {
    stubTurns([refusedReply, goodReply('a2')]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();

    // The failed first turn never created a conversation, so its message has
    // nothing to edit against (see "edit anchors" below); sending again is typed.
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'Plan my month');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    expect(screen.queryByText(NOT_COMPLETED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

const UNANSWERED = 'No reply was received for your last message.';

describe('ChatSurface reopened on an unanswered message', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says no reply came, and Retry asks once for the reply to that message', async () => {
    const chat = stubTurns([goodReply('a3')]);
    const user = userEvent.setup();
    renderSurface({
      conversationId: 'c1',
      initialMessages: [...EXCHANGES, textMessage('u3', 'user', 'third question')],
    });

    expect(await screen.findByText(UNANSWERED)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    expect(screen.queryByText(UNANSWERED)).toBeNull();
    expect(chat.bodies()).toHaveLength(1);
    expect(chat.bodies()[0].regenerate).toBe(true);
    expect(chat.bodies()[0].message).toEqual({
      id: 'u3',
      role: 'user',
      parts: [{ type: 'text', text: 'third question' }],
    });
    expect(document.body.textContent).toContain('reply two');
  });

  it('shows nothing for a conversation that ends on a reply', async () => {
    stubTurns([goodReply('a3')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await screen.findByText('reply two');
    expect(screen.queryByText(UNANSWERED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('leaves a live failure to its own notice, with one Retry', async () => {
    stubTurns([refusedReply]);
    const user = userEvent.setup();
    renderSurface();
    await sendPlanFromLanding(user);

    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    expect(screen.queryByText(UNANSWERED)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });
});

const SAVE_FAILED = 'The reply could not be saved.';
const withoutAssistant = (): Response => json({ messages: [{ role: 'user' }] });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('ChatSurface save check', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('flags a reply the server did not store, and Dismiss removes the notice', async () => {
    const chat = stubTurns([goodReply('a1')], withoutAssistant);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);

    const notice = await screen.findByText(SAVE_FAILED);
    expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByText(/retry saving/i)).toBeNull();
    expect(chat.reads()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it('flags the reply too when the read-back request fails', async () => {
    stubTurns([goodReply('a1')], () => new Response('nope', { status: 500 }));
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);
    expect(await screen.findByText(SAVE_FAILED)).toBeTruthy();
  });

  it('shows no notice when the stored conversation has an assistant message', async () => {
    const chat = stubTurns([goodReply('a1')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);
    await waitFor(() => expect(chat.reads()).toBe(1));
    await settle();
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it('does not read the conversation back after a failed turn', async () => {
    const chat = stubTurns([refusedReply]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    await settle();
    expect(chat.reads()).toBe(0);
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });

  it('clears the save notice when the reader sends again', async () => {
    const chat = stubTurns([goodReply('a1'), goodReply('a2')], (read) =>
      read === 1 ? withoutAssistant() : json({ messages: [{ role: 'assistant' }] }),
    );
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);
    expect(await screen.findByText(SAVE_FAILED)).toBeTruthy();

    await editAndResend(user, 'Plan my month');
    await waitFor(() => expect(chat.reads()).toBe(2));
    await settle();
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

// The server stores a reply under an id of its own, not the streamed one, so
// the check compares counts: the read-back must hold as many assistant replies
// as the thread shows. `stored(n)` is a conversation with n exchanges.
const stored = (exchanges: number) => (): Response =>
  json({
    messages: Array.from({ length: exchanges }, (_, index) => [
      { id: `su${index}`, role: 'user' },
      { id: `sa${index}`, role: 'assistant' },
    ]).flat(),
  });

async function sendFollowUp(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(await screen.findByRole('combobox', { name: 'Message input' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

describe('ChatSurface save check in an established conversation', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('flags a lost newest reply that older stored replies would otherwise mask', async () => {
    // The thread shows three replies after this turn; only two are stored.
    const chat = stubTurns([goodReply('a3')], stored(2));
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await sendFollowUp(user, 'and then?');
    expect(await screen.findByText(SAVE_FAILED)).toBeTruthy();
    expect(chat.reads()).toBe(1);
  });

  it('stays quiet when the newest reply was stored', async () => {
    const chat = stubTurns([goodReply('a3')], stored(3));
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await sendFollowUp(user, 'and then?');
    await waitFor(() => expect(chat.reads()).toBe(1));
    await settle();
    expect(document.body.textContent).toContain('Here is your week.');
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
  });
});

const droppedRegeneration = (): Response =>
  uiMessageStream([
    { type: 'start', messageId: 'a3' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Half of your ' },
    { type: 'error', errorText: 'upstream closed' },
  ]);

describe('ChatSurface after a failed regenerate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not offer versions, and a normal send afterwards does not either', async () => {
    const chat = stubTurns([droppedRegeneration, goodReply('a4')], stored(4));
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await user.click(await screen.findByRole('button', { name: 'Regenerate reply' }));
    expect(await screen.findByText(DROPPED)).toBeTruthy();
    await settle();
    expect(screen.queryByText(/\d of \d/)).toBeNull();

    await sendFollowUp(user, 'and then?');
    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    await settle();
    expect(chat.bodies()).toHaveLength(2);
    expect(screen.queryByText(/\d of \d/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous version' })).toBeNull();
  });
});

describe('ChatSurface attachments', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const chatBody = (): { message: { parts: Array<Record<string, unknown>> } } => {
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/chat');
    expect(call).toBeDefined();
    return JSON.parse(String(call?.[1]?.body)) as { message: { parts: Array<Record<string, unknown>> } };
  };

  it('posts an image-only message to /api/chat as a data-URL file part', async () => {
    const user = userEvent.setup();
    renderSurface();
    await user.upload(
      await screen.findByLabelText('Upload files'),
      new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }),
    );
    await screen.findByText('cat.png');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    expect(chatBody().message.parts).toContainEqual({
      type: 'file',
      mediaType: 'image/png',
      filename: 'cat.png',
      url: 'data:image/png;base64,AQID',
    });
  });

  it('posts the typed text and the image together', async () => {
    const user = userEvent.setup();
    renderSurface();
    await user.upload(
      await screen.findByLabelText('Upload files'),
      new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }),
    );
    await screen.findByText('cat.png');
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'what is this');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(document.body.textContent).toContain('Here is your week.'));
    const { parts } = chatBody().message;
    expect(parts).toContainEqual({ type: 'text', text: 'what is this' });
    expect(parts).toContainEqual(expect.objectContaining({ type: 'file', filename: 'cat.png' }));
  });
});

// What the shell does when a new chat's first reply creates the conversation:
// it seeds the exchange and passes the id back to the SAME surface (no new key).
describe('ChatSurface adopting the conversation it creates', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function AdoptingSurface(): ReactElement {
    const [adopted, setAdopted] = useState<{ id: string | null; messages: UIMessage[] }>({
      id: null,
      messages: [],
    });
    return (
      <>
        <output aria-label="Adopted id">{adopted.id ?? ''}</output>
        <ChatSurface
          conversationId={adopted.id}
          initialMessages={adopted.messages}
          userName="Ann"
          onConversationTouched={() => {}}
          onConversationCreated={(id, messages) => setAdopted({ id, messages })}
        />
      </>
    );
  }

  it('keeps the streamed exchange on screen and posts the new id on the next turn', async () => {
    let replies = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (url === '/api/spaces') return json({ spaces: [] });
      if (url === '/api/conversations/c9') return json({ messages: [{ role: 'assistant' }] });
      if (url !== '/api/chat') throw new Error(`unrouted fetch: ${url}`);
      replies += 1;
      const id = `a${replies}`;
      return uiMessageStream(REPLY_STREAM.map((chunk) => (chunk.type === 'start' ? { ...chunk, messageId: id } : chunk)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <Theme theme={neutralTheme} mode="system">
        <SpacesProvider>
          <AdoptingSurface />
        </SpacesProvider>
      </Theme>,
    );

    await sendPlanFromLanding(user);
    // Once the id has come back in, useChat has recreated its store under it.
    await waitFor(() => expect(screen.getByLabelText('Adopted id').textContent).toBe('c9'));
    expect(screen.queryByText('Hi, Ann')).toBeNull();
    expect(document.body.textContent).toContain(PLAN_PROMPT);
    expect(document.body.textContent).toContain('Here is your week.');

    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent?.match(/Here is your week\./g)).toHaveLength(2));
    const bodies = fetchMock.mock.calls
      .filter(([input]) => String(input) === '/api/chat')
      .map(([, init]) => JSON.parse(String(init?.body)) as { id?: string });
    expect(bodies).toHaveLength(2);
    expect('id' in bodies[0]).toBe(false);
    expect(bodies[1].id).toBe('c9');
    expect(document.body.textContent).toContain('and then?');
  });
});

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

async function editUserMessage(
  user: ReturnType<typeof userEvent.setup>,
  nth: number,
  text: string,
): Promise<void> {
  const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
  await user.click(edits[nth]);
  const box = screen.getByRole('textbox', { name: 'Edit your message' });
  await user.clear(box);
  await user.type(box, text);
  await user.click(screen.getByRole('button', { name: 'Send edited message' }));
}

// An edit is stored, not just drawn: the request names the last message kept
// (editFrom), or editFromStart for the first message, so a reload does not bring
// the edited-away tail back.
describe('ChatSurface edit anchors', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts editFrom with the id of the message before the edited one', async () => {
    const chat = stubTurns([goodReply('a9')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await editUserMessage(userEvent.setup(), 1, 'a sharper question');
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    const [body] = chat.bodies();
    expect(body.id).toBe('c1');
    expect(body.editFrom).toBe('a1');
    expect(body).not.toHaveProperty('editFromStart');
    expect(body).not.toHaveProperty('regenerate');
  });

  it('posts editFromStart when the first message is edited', async () => {
    const chat = stubTurns([goodReply('a9')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await editUserMessage(userEvent.setup(), 0, 'a different opening');
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    const [body] = chat.bodies();
    expect(body.editFromStart).toBe(true);
    expect(body).not.toHaveProperty('editFrom');
  });

  it('posts no edit and no origin for a typed turn', async () => {
    const chat = stubTurns([goodReply('a9')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    const [body] = chat.bodies();
    for (const key of ['editFrom', 'editFromStart', 'origin', 'regenerate']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('disables editing before the conversation has an id', async () => {
    stubTurns([goodReply('a9')]);
    renderSurface({ conversationId: null, initialMessages: EXCHANGES });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    expect(edits.map(isDisabled)).toEqual([true, true]);
  });

  it('does not anchor an edit on a reply streamed in this session', async () => {
    const chat = stubTurns([goodReply('a1'), goodReply('a2')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1' });
    await sendPlanFromLanding(user);
    await waitFor(() =>
      expect(isDisabled(screen.getByRole('button', { name: 'Edit and resend this message' }))).toBe(false),
    );
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'and then?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    // The first message needs no anchor; the second would need the streamed reply.
    await waitFor(() => {
      const edits = screen.getAllByRole('button', { name: 'Edit and resend this message' });
      expect(edits.map(isDisabled)).toEqual([false, true]);
    });
    expect(chat.bodies()).toHaveLength(2);
  });

  it('#1396: a refused edit keeps its text and Retry sends the same edit again', async () => {
    const chat = stubTurns([refusedReply, goodReply('a3')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await editUserMessage(user, 1, 'a sharper question');
    expect(await screen.findByText(NOT_COMPLETED)).toBeTruthy();
    expect(document.body.textContent).toContain('a sharper question');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(2));
    const [first, second] = chat.bodies();
    expect(second.editFrom).toBe('a1');
    expect(second).not.toHaveProperty('regenerate');
    expect(second).not.toHaveProperty('resend');
    expect(second.message).toEqual(first.message);
  });

  it('does not replay an edit when the edited turn is retried', async () => {
    const chat = stubTurns([droppedReply, goodReply('a3')]);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await editUserMessage(user, 1, 'a sharper question');
    expect(await screen.findByText(DROPPED)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(2));
    expect(chat.bodies()[0].editFrom).toBe('a1');
    expect(chat.bodies()[1].regenerate).toBe(true);
    expect(chat.bodies()[1]).not.toHaveProperty('editFrom');
  });
});

// The conversation opens on its latest window; the shell hands the rest over as
// earlierMessages, oldest first, and the surface adds a page of it per press.
const LOAD_EARLIER = { name: 'Load earlier messages' };
const earlierThread = (count: number): UIMessage[] =>
  Array.from({ length: count }, (_, n) =>
    textMessage(`e${n}`, n % 2 === 0 ? 'user' : 'assistant', `earlier ${n}`),
  );
const earlierRows = (): number => screen.queryAllByText(/^earlier \d+$/).length;

// jsdom has no IntersectionObserver, which ChatMessageList watches its top with
// once it has a scrollToTopAction. This one never sees the top, so only the
// button loads a page.
class TopNeverVisible {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

describe('ChatSurface earlier messages', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', TopNeverVisible);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers no button when nothing is earlier', async () => {
    stubTurns([goodReply('a9')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await screen.findByText('first question');
    expect(screen.queryByRole('button', LOAD_EARLIER)).toBeNull();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES, earlierMessages: [] });
    expect(screen.queryByRole('button', LOAD_EARLIER)).toBeNull();
  });

  it('adds the next 200 earlier messages per press, newest of them first, until none remain', {
    timeout: 30_000,
  }, async () => {
    stubTurns([goodReply('a9')]);
    const user = userEvent.setup();
    renderSurface({
      conversationId: 'c1',
      initialMessages: EXCHANGES,
      earlierMessages: earlierThread(250),
    });
    await screen.findByText('first question');
    expect(earlierRows()).toBe(0);

    await user.click(screen.getByRole('button', LOAD_EARLIER));
    expect(await screen.findByText('earlier 249')).toBeTruthy();
    expect(earlierRows()).toBe(200);
    expect(screen.getByText('earlier 50')).toBeTruthy();
    expect(screen.queryByText('earlier 49')).toBeNull();
    expect(screen.getByText('first question')).toBeTruthy();

    await user.click(screen.getByRole('button', LOAD_EARLIER));
    expect(await screen.findByText('earlier 0')).toBeTruthy();
    expect(earlierRows()).toBe(250);
    expect(screen.queryByRole('button', LOAD_EARLIER)).toBeNull();
  });

  it('anchors an edit of the first shown message on the last unloaded one, not on the start', async () => {
    const chat = stubTurns([goodReply('a9')]);
    renderSurface({
      conversationId: 'c1',
      initialMessages: EXCHANGES,
      earlierMessages: earlierThread(4),
    });
    await editUserMessage(userEvent.setup(), 0, 'a different opening');
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    const [body] = chat.bodies();
    expect(body.editFrom).toBe('e3');
    expect(body).not.toHaveProperty('editFromStart');
  });

  it('edits from the start once every earlier message is loaded', async () => {
    const chat = stubTurns([goodReply('a9')]);
    const user = userEvent.setup();
    renderSurface({
      conversationId: 'c1',
      initialMessages: EXCHANGES,
      earlierMessages: earlierThread(4),
    });
    await user.click(await screen.findByRole('button', LOAD_EARLIER));
    await screen.findByText('earlier 0');
    // "earlier 0" is now the first message, and the first user message shown.
    await editUserMessage(user, 0, 'a different opening');
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0].editFromStart).toBe(true);
    expect(chat.bodies()[0]).not.toHaveProperty('editFrom');
  });
});

describe('ChatSurface drafts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the composer text under the conversation id', async () => {
    stubTurns([goodReply('a9')]);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    await userEvent.setup().type(await screen.findByRole('combobox', { name: 'Message input' }), 'later');
    expect(getDraft('c1')).toBe('later');
    expect(getDraft('new')).toBe('');
  });

  it('keeps the composer text of a new chat under "new"', async () => {
    stubTurns([goodReply('a9')]);
    renderSurface();
    await userEvent.setup().type(await screen.findByRole('combobox', { name: 'Message input' }), 'a new idea');
    expect(getDraft('new')).toBe('a new idea');
  });
});

// One ChatSurface tree; rerender changes its props in place, as the shell does for a mounted surface.
function surfaceTree(props: Partial<ChatSlotProps> & { appBinding?: ChatAppBinding; draftKey?: string }): ReactElement {
  return (
    <Theme theme={neutralTheme} mode="system">
      <SpacesProvider>
        <ChatSurface conversationId="c1" initialMessages={[]} userName="Ann" onConversationTouched={vi.fn()} onConversationCreated={vi.fn()} {...props} />
      </SpacesProvider>
    </Theme>
  );
}

function mountSurface(props: Partial<ChatSlotProps> & { appBinding?: ChatAppBinding; draftKey?: string }): (next: typeof props) => void {
  const { rerender } = render(surfaceTree(props));
  return (next) => rerender(surfaceTree(next));
}

const composerBox = (): HTMLElement => screen.getByRole('combobox', { name: 'Message input' });

describe('ChatSurface app binding on a mounted surface', () => {
  const RUN_APP: ChatAppBinding = { installationId: '6f1d2a3e-4b5c-4d6e-8f70-123456789abc', mode: 'run' };
  const REFINE_APP: ChatAppBinding = { installationId: '0b7c9d4e-1a2b-4c3d-9e8f-7a6b5c4d3e2f', mode: 'refine' };
  const CAMPAIGN_CHANNEL: ChatAppBinding = { ...RUN_APP, channel: 'instagram' };
  const CAMPAIGN_A: ChatAppBinding = { ...CAMPAIGN_CHANNEL, campaignId: 'a3c14d67-7e9f-4a82-8b03-123456789abc' };
  const CAMPAIGN_B: ChatAppBinding = { ...CAMPAIGN_CHANNEL, campaignId: 'b4d25e78-8f10-4b93-9c14-123456789abc' };
  const CAMPAIGN_NEW = { ...CAMPAIGN_CHANNEL, campaignId: null };

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('captures the app before asynchronous request preparation can see a changed binding object', async () => {
    const chat = stubChat([replyStream('Captured app', 'capture-1')]);
    const binding = { ...REFINE_APP };
    mountSurface({ appBinding: binding });
    await userEvent.setup().type(await screen.findByRole('combobox', { name: 'Message input' }), 'Improve the open app');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    binding.installationId = RUN_APP.installationId;
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0].appBinding).toEqual(REFINE_APP);
  });

  it('sends each turn with the binding it is mounted with at that moment, and none once removed', async () => {
    const chat = stubChat([replyStream('ok one', 'a1'), replyStream('ok two', 'a2'), replyStream('ok three', 'a3')]);
    const user = userEvent.setup();
    const update = mountSurface({ appBinding: RUN_APP });
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), 'Plan  teh week, ok?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok one'));

    update({ appBinding: REFINE_APP });
    await user.type(composerBox(), 'Make it shorter');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok two'));

    update({});
    await user.type(composerBox(), 'Thanks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok three'));

    const [first, second, third] = chat.bodies();
    expect(first.appBinding).toEqual(RUN_APP);
    expect(first.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Plan  teh week, ok?' }] });
    expect(second.appBinding).toEqual(REFINE_APP);
    expect(second.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Make it shorter' }] });
    expect(third).not.toHaveProperty('appBinding');
    expect(Object.keys(second.appBinding as object).sort()).toEqual(['installationId', 'mode']);
  });

  it('keeps unsent rough copy when only the mode changes on the same mounted surface', async () => {
    const update = mountSurface({ draftKey: 'owner-1:app-1', appBinding: RUN_APP });
    await userEvent.setup().type(await screen.findByRole('combobox', { name: 'Message input' }), 'rough  copy, teh typo');
    update({ draftKey: 'owner-1:app-1', appBinding: REFINE_APP });
    expect(getDraft('owner-1:app-1')).toBe('rough  copy, teh typo');
    expect(composerBox().textContent).toContain('rough  copy, teh typo');
  });

  it('isolates unsent copy by owner and app, and restores each key only for its own surface', async () => {
    mountSurface({ draftKey: 'owner-1:app-1', appBinding: RUN_APP });
    await userEvent.setup().type(await screen.findByRole('combobox', { name: 'Message input' }), 'rough copy for app one');
    cleanup();

    mountSurface({ draftKey: 'owner-1:app-2', appBinding: REFINE_APP });
    expect(getDraft('owner-1:app-2')).toBe('');
    expect(composerBox().textContent).not.toContain('rough copy');
    cleanup();

    mountSurface({ draftKey: 'owner-2:app-1', appBinding: RUN_APP });
    expect(getDraft('owner-2:app-1')).toBe('');
    expect(composerBox().textContent).not.toContain('rough copy');
    cleanup();

    mountSurface({ draftKey: 'owner-1:app-1', appBinding: RUN_APP });
    await waitFor(() => expect(composerBox().textContent).toContain('rough copy for app one'));
  });

  it('follows the channel prop on each fresh send through Instagram, LinkedIn and All, keeping the typed copy', async () => {
    const IG: ChatAppBinding = { ...RUN_APP, channel: 'instagram' };
    const LI: ChatAppBinding = { ...RUN_APP, channel: 'linkedin' };
    const chat = stubChat([replyStream('ok one', 'a1'), replyStream('ok two', 'a2'), replyStream('ok three', 'a3')]);
    const user = userEvent.setup();
    const update = mountSurface({ appBinding: IG });
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), 'Spring  sale, teh post');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok one'));

    await user.type(composerBox(), 'Make it shorter');
    update({ appBinding: LI });
    expect(composerBox().textContent).toContain('Make it shorter');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok two'));

    update({ appBinding: RUN_APP });
    await user.type(composerBox(), 'Thanks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok three'));

    const [first, second, third] = chat.bodies();
    expect(first.appBinding).toEqual(IG);
    expect(first.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Spring  sale, teh post' }] });
    expect(second.appBinding).toEqual(LI);
    expect(second.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Make it shorter' }] });
    expect(Object.keys(third.appBinding as object).sort()).toEqual(['installationId', 'mode']);
    expect(third.appBinding).toEqual(RUN_APP);
  });

  it('follows the channel prop on a regenerate of a mounted thread', async () => {
    const chat = stubChat([replyStream('A second take.', 'a3')]);
    const user = userEvent.setup();
    const update = mountSurface({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: { ...RUN_APP, channel: 'instagram' } });
    update({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: { ...RUN_APP, channel: 'linkedin' } });
    await user.click(await screen.findByRole('button', { name: 'Regenerate reply' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ regenerate: true, appBinding: { ...RUN_APP, channel: 'linkedin' } });
  });

  it('follows the channel prop on an edit and resend of a mounted thread', async () => {
    const chat = stubChat([replyStream('Fresh answer.', 'a9')]);
    const user = userEvent.setup();
    const update = mountSurface({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: { ...RUN_APP, channel: 'instagram' } });
    update({ conversationId: 'c1', initialMessages: EXCHANGES, appBinding: { ...RUN_APP, channel: 'linkedin' } });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    await user.click(edits[1]);
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    await user.type(box, 'a sharper question');
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ editFrom: expect.any(String), appBinding: { ...RUN_APP, channel: 'linkedin' } });
  });

  it('follows campaign A, B and removal on fresh sends while preserving channel and original copy', async () => {
    const chat = stubChat([replyStream('ok one', 'a1'), replyStream('ok two', 'a2'), replyStream('ok three', 'a3')]);
    const user = userEvent.setup();
    const update = mountSurface({ conversationId: null, appBinding: CAMPAIGN_A });
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), 'Spring  sale, teh post');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok one'));

    await user.type(composerBox(), 'Keep  teh copy');
    update({ conversationId: null, appBinding: CAMPAIGN_B });
    expect(composerBox().textContent).toContain('Keep  teh copy');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok two'));

    update({ conversationId: null, appBinding: CAMPAIGN_CHANNEL });
    await user.type(composerBox(), 'Thanks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('ok three'));

    const [first, second, third] = chat.bodies();
    expect(first).not.toHaveProperty('id');
    expect(first.appBinding).toEqual(CAMPAIGN_A);
    expect(first.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Spring  sale, teh post' }] });
    expect(second.appBinding).toEqual(CAMPAIGN_B);
    expect(second.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Keep  teh copy' }] });
    expect(third.appBinding).toEqual(CAMPAIGN_CHANNEL);
    expect(third.appBinding).not.toHaveProperty('campaignId');
    expect(third.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Thanks' }] });
  });

  it('keeps an explicit null New campaign target on a fresh send with unchanged copy', async () => {
    const chat = stubChat([replyStream('New campaign reply.', 'a1')]);
    const user = userEvent.setup();
    const update = mountSurface({ conversationId: null, appBinding: CAMPAIGN_A });
    const original = 'Spring  sale, teh post';
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), original);
    update({ conversationId: null, appBinding: CAMPAIGN_NEW });
    expect(composerBox().textContent).toContain(original);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0].appBinding).toEqual(CAMPAIGN_NEW);
    expect(chat.bodies()[0].message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: original }] });
  });

  it.each([['campaign B', CAMPAIGN_B], ['no campaign', CAMPAIGN_CHANNEL], ['explicit New campaign', CAMPAIGN_NEW]] as const)('uses the current target on regenerate after switching to %s', async (_label, appBinding) => {
    const chat = stubChat([replyStream('A second take.', 'a3')]);
    const user = userEvent.setup();
    const update = mountSurface({ initialMessages: EXCHANGES, appBinding: CAMPAIGN_A });
    update({ initialMessages: EXCHANGES, appBinding });
    await user.click(await screen.findByRole('button', { name: 'Regenerate reply' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ regenerate: true });
    expect(chat.bodies()[0].appBinding).toEqual(appBinding);
    expect(chat.bodies()[0].message).toEqual(EXCHANGES[2]);
  });

  it.each([['campaign B', CAMPAIGN_B], ['no campaign', CAMPAIGN_CHANNEL], ['explicit New campaign', CAMPAIGN_NEW]] as const)('uses the current target on edit and resend after switching to %s', async (_label, appBinding) => {
    const chat = stubChat([replyStream('Fresh answer.', 'a9')]);
    const user = userEvent.setup();
    const update = mountSurface({ initialMessages: EXCHANGES, appBinding: CAMPAIGN_A });
    const edits = await screen.findAllByRole('button', { name: 'Edit and resend this message' });
    await user.click(edits[1]);
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    await user.type(box, 'Keep  teh edited copy');
    update({ initialMessages: EXCHANGES, appBinding });
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));

    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ editFrom: expect.any(String) });
    expect(chat.bodies()[0].appBinding).toEqual(appBinding);
    expect(chat.bodies()[0].message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Keep  teh edited copy' }] });
  });

  it('uses Posts, Campaign and omitted intent on current fresh sends while retaining exact unsent copy', async () => {
    const chat = stubChat([replyStream('workflow one', 'a1'), replyStream('workflow two', 'a2'), replyStream('workflow three', 'a3')]);
    const user = userEvent.setup();
    const posts = { ...CAMPAIGN_A, intent: 'posts' as const };
    const campaign = { ...CAMPAIGN_A, intent: 'campaign' as const };
    const update = mountSurface({ conversationId: null, appBinding: posts });
    const original = 'Spring  sale, teh post';
    await user.type(await screen.findByRole('combobox', { name: 'Message input' }), original);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('workflow one'));
    await user.type(composerBox(), original);
    update({ conversationId: null, appBinding: campaign });
    expect(composerBox().textContent).toContain(original);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('workflow two'));
    update({ conversationId: null, appBinding: CAMPAIGN_A });
    await user.type(composerBox(), original);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.body.textContent).toContain('workflow three'));
    expect(chat.bodies().map((body) => body.appBinding)).toEqual([posts, campaign, CAMPAIGN_A]);
    for (const body of chat.bodies()) {
      expect(body.message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: original }] });
    }
  });

  it.each(['posts', 'campaign'] as const)('uses the current %s intent when regenerating', async (intent) => {
    const chat = stubChat([replyStream('Current workflow reply.', 'a9')]);
    const update = mountSurface({ initialMessages: EXCHANGES, appBinding: { ...CAMPAIGN_A, intent: intent === 'posts' ? 'campaign' : 'posts' } });
    const requested = { ...CAMPAIGN_A, intent };
    update({ initialMessages: EXCHANGES, appBinding: requested });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Regenerate reply' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ regenerate: true, appBinding: requested });
    expect(chat.bodies()[0].message).toEqual(EXCHANGES[2]);
  });

  it.each(['posts', 'campaign'] as const)('uses the current %s intent on edit and resend', async (intent) => {
    const chat = stubChat([replyStream('Current edited workflow.', 'a9')]);
    const user = userEvent.setup();
    const update = mountSurface({ initialMessages: EXCHANGES, appBinding: CAMPAIGN_A });
    await user.click((await screen.findAllByRole('button', { name: 'Edit and resend this message' }))[1]);
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    await user.type(box, 'Keep  teh edited copy');
    const requested = { ...CAMPAIGN_A, intent };
    update({ initialMessages: EXCHANGES, appBinding: requested });
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));
    await waitFor(() => expect(chat.bodies()).toHaveLength(1));
    expect(chat.bodies()[0]).toMatchObject({ editFrom: expect.any(String), appBinding: requested });
    expect(chat.bodies()[0].message).toEqual({ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'Keep  teh edited copy' }] });
  });
});

const DELETE_BUTTON = { name: 'More actions for this message' };

// Delete from here sits in each user message's menu, last and destructive.
async function chooseDeleteFrom(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement): Promise<void> {
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: /Delete from here/ }));
}

function stubDelete(status: number): { deletes: () => string[] } {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url === '/api/spaces') return json({ spaces: [] });
    if (method === 'DELETE' && url.startsWith('/api/conversations/')) return new Response(null, { status });
    throw new Error(`unrouted fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    deletes: () =>
      fetchMock.mock.calls
        .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE')
        .map(([input]) => String(input)),
  };
}

describe('ChatSurface delete from here', () => {
  // jsdom has no modal <dialog>; the Astryx alert dialog calls showModal() on open.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deletes the message and everything after it on confirm', async () => {
    const { deletes } = stubDelete(204);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    const buttons = await screen.findAllByRole('button', DELETE_BUTTON);
    expect(buttons).toHaveLength(2);
    await chooseDeleteFrom(user, buttons[1]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete messages' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes()).toEqual(['/api/conversations/c1/messages/u2']);
    expect(screen.getByText('first question')).toBeTruthy();
    expect(screen.getByText('reply one')).toBeTruthy();
    expect(screen.queryByText('second question')).toBeNull();
    expect(screen.queryByText('reply two')).toBeNull();
  });

  it('shows an error toast and keeps all four messages on a 500', async () => {
    stubDelete(500);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    const buttons = await screen.findAllByRole('button', DELETE_BUTTON);
    await chooseDeleteFrom(user, buttons[1]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete messages' }));
    expect(await screen.findByText("Couldn't delete those messages.")).toBeTruthy();
    for (const text of ['first question', 'reply one', 'second question', 'reply two']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it('offers no delete action on assistant messages, and none at all for a new chat', async () => {
    stubDelete(204);
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    expect(await screen.findAllByRole('button', DELETE_BUTTON)).toHaveLength(2);
    cleanup();
    renderSurface({ conversationId: null, initialMessages: EXCHANGES });
    await screen.findByText('first question');
    expect(screen.queryByRole('button', DELETE_BUTTON)).toBeNull();
  });

  it('sends nothing and keeps the thread when the dialog is cancelled', async () => {
    const { deletes } = stubDelete(204);
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: EXCHANGES });
    const buttons = await screen.findAllByRole('button', DELETE_BUTTON);
    await chooseDeleteFrom(user, buttons[1]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deletes()).toHaveLength(0);
    for (const text of ['first question', 'reply one', 'second question', 'reply two']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });
});

// #492: the open chat's header shows what the Cardputer is in and offers the
// shared actions (useDeviceConversation) to change it.
describe('ChatSurface Cardputer header', () => {
  let serverActive: { conversation_id: string; title: string } | null;
  let putStatus: number;

  beforeEach(() => {
    serverActive = null;
    putStatus = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
        if (url === '/api/spaces') return json({ spaces: [] });
        if (url === '/api/active') return json({ active: serverActive });
        // The header control shows only once a device is paired (devices contract).
        if (url === '/api/devices' && (init?.method ?? 'GET') === 'GET') {
          return json({
            devices: [{ id: 'd1', name: 'Kitchen', model: 'bob', paired_at: 1, last_seen_at: 1, connected: false, settings: {}, pending: false, settings_supported: false, ring_settings_supported: false, wake_word_supported: false, live: { connected: false, battery_pct: null, charging: null, fw_version: null } }],
            active_conversation: serverActive ? { id: serverActive.conversation_id, title: serverActive.title } : null,
          });
        }
        if (url === '/api/devices/active-conversation' && init?.method === 'PUT') {
          if (putStatus !== 200) return new Response(JSON.stringify({ error: { code: 'no_device' } }), { status: putStatus });
          serverActive = { conversation_id: 'c1', title: 'Trip plan' };
          return json({});
        }
        throw new Error(`unrouted fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function puts(): unknown[] {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url, init]) => url === '/api/devices/active-conversation' && init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)));
  }

  const THREAD = [textMessage('u1', 'user', 'hello'), textMessage('a1', 'assistant', 'hi')];

  it('shows where the Cardputer is, and Use on device sends this conversation once', async () => {
    serverActive = { conversation_id: 'c2', title: 'Groceries' };
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: THREAD });
    expect(await screen.findByText('On Kitchen: Groceries')).toBeTruthy();
    // #667: one visible, labelled click; no menu to open first.
    await user.click(screen.getByRole('button', { name: 'Use on Kitchen' }));
    expect(await screen.findByText('Sent to Kitchen.')).toBeTruthy();
    expect(puts()).toEqual([{ conversation_id: 'c1', space_id: null }]);
    expect(screen.getByText('On Kitchen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use on Kitchen' })).toBeNull();
  });

  it('New conversation on device starts one in the main space', async () => {
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: THREAD });
    await user.click(await screen.findByRole('button', { name: 'Kitchen options' }));
    await user.click(await screen.findByRole('menuitem', { name: /^New conversation on Kitchen/ }));
    await screen.findByText('Sent to Kitchen.');
    expect(puts()).toEqual([{ conversation_id: null, space_id: null }]);
  });

  function renderPhone(): void {
    render(
      <Theme theme={neutralTheme} mode="system">
        <AppShellMobileContext value={{ ...mobileShell, isMobile: true }}>
          <SpacesProvider>
            <ChatSurface
              conversationId="c1"
              initialMessages={THREAD}
              userName="Ann"
              onConversationTouched={vi.fn()}
              onConversationCreated={vi.fn()}
            />
          </SpacesProvider>
        </AppShellMobileContext>
      </Theme>,
    );
  }

  it('on a phone with a paired device, keeps the device control above the composer', async () => {
    renderPhone();
    const use = await screen.findByRole('button', { name: 'Use on Kitchen' });
    const input = screen.getByRole('combobox', { name: 'Message input' });
    expect(Boolean(use.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('on a phone with no paired device, adds no device row', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === '/api/spaces') return json({ spaces: [] });
      if (url === '/api/active') return json({ active: null });
      if (url === '/api/devices') return json({ devices: [], active_conversation: null });
      throw new Error(`unrouted fetch: ${url}`);
    });
    renderPhone();
    await screen.findByRole('combobox', { name: 'Message input' });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/devices')).toBe(true));
    expect(screen.queryByRole('button', { name: /^Use on / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kitchen options' })).toBeNull();
  });

  it('says no Cardputer is connected', async () => {
    putStatus = 409;
    const user = userEvent.setup();
    renderSurface({ conversationId: 'c1', initialMessages: THREAD });
    await user.click(await screen.findByRole('button', { name: 'Use on Kitchen' }));
    expect(await screen.findByText('Kitchen is not connected.')).toBeTruthy();
    // Never pretends it moved.
    expect(screen.getByRole('button', { name: 'Use on Kitchen' })).toBeTruthy();
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.pathname : input.url;
}

describe('ChatSurface phone density', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The full-page chat sets one density on ChatLayout (its message inset and dock)
  // and on the message list. Phone takes the compact one; desktop keeps spacious.
  function renderOn(isMobile: boolean): void {
    vi.stubGlobal('fetch', vi.fn(async () => json({ spaces: [], devices: [], messages: [], items: [] })));
    render(
      <Theme theme={neutralTheme} mode="system">
        <AppShellMobileContext value={{ ...mobileShell, isMobile }}>
          <SpacesProvider>
            <ChatSurface {...renderProps()} />
          </SpacesProvider>
        </AppShellMobileContext>
      </Theme>,
    );
  }
  const renderProps = (): ChatSlotProps => ({
    conversationId: 'c1',
    initialMessages: EXCHANGES,
    userName: 'Ann',
    onConversationTouched: vi.fn(),
    onConversationCreated: vi.fn(),
  });

  it('gives the chat layout compact density on a phone', () => {
    renderOn(true);
    expect(document.querySelector('[data-density]')?.getAttribute('data-density')).toBe('compact');
  });

  it.each([true, false])('renders no stray code comment as text (phone: %s)', (isMobile) => {
    renderOn(isMobile);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      expect(node.textContent?.trim().startsWith('//')).toBe(false);
    }
  });

  it('keeps the chat layout spacious on desktop', () => {
    renderOn(false);
    expect(document.querySelector('[data-density]')?.getAttribute('data-density')).toBe('spacious');
  });

  it('has one header on a phone: no conversation row, Tools and Add people on the composer top row', () => {
    renderOn(true);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Tools' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add people' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });

  it('keeps the conversation header row with Tools and Add people on desktop', () => {
    renderOn(false);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tools' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add people' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });
});
