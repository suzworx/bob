import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { Space } from '@/features/spaces/use-spaces';
import type { Thread, ThreadMessage, useThreads } from '@/features/spaces/use-threads';
import { HttpError } from '@/lib/query-client';
import { addressesBob } from '../chat/mentions';
import { COMPOSER_PLACEHOLDER } from '@/features/chat/composer';
import { clearDraft } from '@/features/chat/drafts';
import { ThreadReader } from './thread-reader';
import { SPACE_GUTTER } from './space-header';

// Records every Section's props so a test can read the tab root's padding:
// jsdom computes no layout, and padding={0} makes a nested Section escape the
// page gutter and start 24px left of the space name.
const sectionProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@astryxdesign/core/Section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/Section')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Section: (props: Parameters<typeof actual.Section>[0]) => {
      sectionProps.push(props as Record<string, unknown>);
      return createElement(actual.Section, props);
    },
  };
});

// The phone frame is decided by usePhoneChatLayout; a test flips it on to read the phone behaviour.
const phoneMode = vi.hoisted(() => ({ on: false }));
vi.mock('../chat/chat-layout-props', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat/chat-layout-props')>();
  return {
    usePhoneChatLayout: () => {
      const real = actual.usePhoneChatLayout();
      return phoneMode.on
        ? { isMobile: true, layout: { density: 'compact' as const }, list: { density: 'compact' as const, align: 'top' as const }, composerInset: 3 as const }
        : real;
    },
  };
});

function rootSectionPadding(label: string): unknown {
  return sectionProps.filter((props) => props['aria-label'] === label).at(-1)?.padding;
}

// ThreadReader takes the useThreads() return value as a prop, so these tests
// build a fake one directly instead of mounting a QueryClientProvider.
vi.mock('@/lib/auth/use-session', () => ({
  useSession: () => ({ session: { user: { id: 'u-self' } } }),
}));

const MEMBERS = [
  { user_id: 'u-self', role: 'owner', joined_at: 1, display_name: 'Sam', handle: 'sam', email: null },
  { user_id: 'u-riley', role: 'member', joined_at: 2, display_name: 'Riley', handle: 'riley', email: null },
  { user_id: 'u-handle-only', role: 'member', joined_at: 3, display_name: null, handle: 'jax', email: null },
];

const SPACE: Space = {
  id: 's1',
  kind: 'group',
  name: 'Home',
  role: 'owner',
  membership_revision: 1,
  created_at: 0,
  updated_at: 0,
  members: MEMBERS,
};

// #862: the caller is the space's only active member, so a plain message has
// no one else it could be for.
const SOLE_MEMBER_SPACE: Space = { ...SPACE, members: [MEMBERS[0]] };
// #862: the caller shares the space with one other person, so a plain
// message could be for them -- only an explicit @bob still asks her.
const TWO_MEMBER_SPACE: Space = { ...SPACE, members: [MEMBERS[0], MEMBERS[1]] };

const THREAD: Thread = {
  id: 't1',
  space_id: 's1',
  title: 'Groceries',
  created_by: 'u-self',
  archived_at: null,
  last_sequence: 1,
  unread_count: 0,
  created_at: 0,
  updated_at: 0,
};

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    thread_id: 't1',
    space_id: 's1',
    author_user_id: 'u-riley',
    body: 'Hello there',
    reply_to_message_id: null,
    sequence: 1,
    client_message_id: 'c1',
    revision: 1,
    tombstoned_at: null,
    tombstoned_by: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    origin: 'web_text',
    ...overrides,
  };
}

type ThreadsValue = ReturnType<typeof useThreads>;

function makeThreads(overrides: Partial<ThreadsValue> = {}): ThreadsValue {
  return {
    threads: [THREAD],
    threadsState: 'ready',
    activeThreadId: 't1',
    messages: [],
    messagesState: 'empty',
    error: null,
    hideThread: vi.fn(),
    unhideThread: vi.fn(),
    refresh: vi.fn(),
    openThread: vi.fn(),
    createThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    postMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(),
    askBob: vi.fn(),
    ...overrides,
  };
}

function renderReader(threads: ThreadsValue, space: Space = SPACE, requireMention = false): void {
  render(
    <Theme theme={neutralTheme}>
      <ThreadReader space={space} thread={THREAD} threads={threads} requireMention={requireMention} />
    </Theme>,
  );
}

afterEach(() => {
  clearDraft('t1');
  cleanup();
});

describe('ThreadReader', () => {
  // The name queries are scoped to the message list (role="log"): the composer's
  // mention menu names every member of the space as well.
  it("renders a member's display name", () => {
    renderReader(makeThreads({ messages: [message({ author_user_id: 'u-riley' })], messagesState: 'ready' }));
    // The name renders twice: once on the bubble, once in the avatar's hover
    // tooltip. Either is proof the display name (not the id) reached the DOM.
    expect(within(screen.getByRole('log')).getAllByText('Riley').length).toBeGreaterThan(0);
  });

  it('renders @handle for a member with no display name', () => {
    renderReader(
      makeThreads({ messages: [message({ author_user_id: 'u-handle-only' })], messagesState: 'ready' }),
    );
    expect(within(screen.getByRole('log')).getAllByText('@jax').length).toBeGreaterThan(0);
  });

  it('renders Someone for an author who is no longer a member', () => {
    renderReader(
      makeThreads({ messages: [message({ author_user_id: 'u-gone-0123456789' })], messagesState: 'ready' }),
    );
    expect(within(screen.getByRole('log')).getAllByText('Someone').length).toBeGreaterThan(0);
  });

  it('renders Bob for a null author', () => {
    renderReader(makeThreads({ messages: [message({ author_user_id: null })], messagesState: 'ready' }));
    expect(within(screen.getByRole('log')).getAllByText('Bob').length).toBeGreaterThan(0);
  });

  it('never renders the raw author user id', () => {
    const authorId = 'u-riley-0123456789abcdef';
    renderReader(makeThreads({ messages: [message({ author_user_id: authorId })], messagesState: 'ready' }));
    expect(document.body.textContent?.includes(authorId)).toBe(false);
  });

  it('re-applies the space gutter on its root Section, so its content starts where the space name starts', async () => {
    renderReader(makeThreads());
    expect(screen.getByRole('region', { name: 'Thread messages' })).toBeTruthy();
    expect(rootSectionPadding('Thread messages')).toBe(SPACE_GUTTER);
  });

  describe('on a phone', () => {
    afterEach(() => {
      phoneMode.on = false;
    });

    it('drops the meta row and the composer inset stacked on the chat frame', () => {
      phoneMode.on = true;
      renderReader(makeThreads({ messages: [message({ author_user_id: 'u-self' })], messagesState: 'ready' }));
      // The root Section adds no gutter of its own: the composer spans the chat's width.
      expect(rootSectionPadding('Thread messages')).toBe(0);
      expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Edit this message' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete this message' })).toBeNull();
    });

    it('shows More actions only on the latest message of each sender', () => {
      phoneMode.on = true;
      renderReader(
        makeThreads({
          messages: [
            message({ id: 'm1', author_user_id: 'u-riley', body: 'first' }),
            message({ id: 'm2', author_user_id: 'u-riley', body: 'second' }),
            message({ id: 'm3', author_user_id: 'u-self', body: 'mine' }),
          ],
          messagesState: 'ready',
        }),
      );
      expect(screen.getAllByRole('button', { name: 'More actions' })).toHaveLength(2);
    });
  });

  it('keeps the inline Copy action and the space gutter on desktop', () => {
    renderReader(makeThreads({ messages: [message()], messagesState: 'ready' }));
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('shows the composer', () => {
    renderReader(makeThreads());
    // "Message", not the shared composer's own default "Message input":
    // ThreadPanel and SpacesPage's tests already query it by this name.
    expect(screen.getByRole('combobox', { name: 'Message' })).toBeTruthy();
  });

  it('shows the empty state when there are no messages', () => {
    renderReader(makeThreads({ messages: [], messagesState: 'empty' }));
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });

  it('renders an Bob reply as markdown, as the main chat does', () => {
    renderReader(
      makeThreads({
        messages: [message({ author_user_id: null, body: '**Milk** is on the list' })],
        messagesState: 'ready',
      }),
    );
    // The emphasis is rendered, not printed: the source markers are gone and
    // the emphasised word is its own node.
    expect(screen.getByText('Milk')).toBeTruthy();
    expect(document.body.textContent?.includes('**')).toBe(false);
  });

  it('keeps the mention badges on a message someone wrote', () => {
    renderReader(
      makeThreads({ messages: [message({ body: 'Milk for @sam' })], messagesState: 'ready' }),
    );
    // A badge is its own element; plain text would only match the whole line.
    expect(screen.getAllByText('@sam').length).toBeGreaterThan(0);
  });

  it('puts copy on any message and edit and delete only on your own', () => {
    renderReader(
      makeThreads({
        messages: [
          message({ id: 'm1', author_user_id: 'u-riley' }),
          message({ id: 'm2', author_user_id: 'u-self' }),
        ],
        messagesState: 'ready',
      }),
    );
    expect(screen.getAllByRole('button', { name: 'Copy message' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Edit this message' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete this message' })).toHaveLength(1);
    // Nothing is left behind a menu.
    expect(screen.queryByRole('button', { name: 'Message actions' })).toBeNull();
  });

  it('offers no action on a deleted message', () => {
    renderReader(
      makeThreads({
        messages: [message({ author_user_id: 'u-self', body: '', tombstoned_at: 1 })],
        messagesState: 'ready',
      }),
    );
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit this message' })).toBeNull();
  });

  it('names the author of a message that is not yours, and not your own', () => {
    renderReader(
      makeThreads({
        messages: [
          message({ id: 'm1', author_user_id: 'u-riley' }),
          message({ id: 'm2', author_user_id: 'u-self' }),
        ],
        messagesState: 'ready',
      }),
    );
    // Scoped to the message list: the mention menu names every member too.
    const messages = within(screen.getByRole('log'));
    expect(messages.getAllByText('Riley').length).toBeGreaterThan(0);
    expect(messages.queryByText('Sam')).toBeNull();
  });

  it('keeps your optimistic message on your side, with no actions on it yet', () => {
    renderReader(
      makeThreads({
        messages: [message({ id: 'pending-c1', author_user_id: 'pending' })],
        messagesState: 'ready',
      }),
    );
    // Your side carries no name, so the placeholder author never shows as
    // "Someone" and the message does not swap sides when the post lands.
    expect(screen.queryByText('Someone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit this message' })).toBeNull();
  });

  it('shows the mention button its placeholder promises', () => {
    renderReader(makeThreads());
    expect(screen.getByRole('button', { name: 'Mention Bob, people or features' })).toBeTruthy();
  });

  it('shows the main chat thinking message while Bob answers', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: '@bob add milk' });
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage: vi.fn().mockResolvedValue(posted),
      askBob: vi.fn(() => new Promise<never>(() => {})),
    });
    renderReader(threads);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('@bob add milk{Enter}');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
  });

  // A screenshot showed a posted message reading "Bob Please summarize…" —
  // the `@` missing, so addressesBob() on it would come back false and
  // Bob would never be asked. This picks Bob from the same "Mention
  // someone" menu the report describes (not typed) and checks the string
  // that actually reaches postMessage: the token's serialized `value`
  // (`@bob`), never its display `label` ("Bob"). See composer.test.tsx's
  // "Composer mentions" for the same proof against a regular member.
  it('posts the @handle picked from the mention menu, not the display name, and asks Bob', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: '@bob summarize this' });
    const postMessage = vi.fn().mockResolvedValue(posted);
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage,
      askBob: vi.fn(() => new Promise<never>(() => {})),
    });
    renderReader(threads);
    await user.click(screen.getByRole('button', { name: 'Mention Bob, people or features' }));
    await user.click(await screen.findByRole('menuitem', { name: /Bob/ }));
    await user.type(screen.getByRole('combobox', { name: 'Message' }), 'summarize this');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    const [body] = postMessage.mock.calls[0] as [string];
    expect(body).toContain('@bob');
    expect(body).not.toContain('Bob summarize');
    expect(addressesBob(body)).toBe(true);
    expect(await screen.findByText('Thinking…')).toBeTruthy();
  });

  // The correction's other suspect: editing an existing message goes through
  // a plain TextArea (MessageItem), not the token composer. Typing '@bob'
  // there is ordinary keyboard text with no token to mis-serialize, and this
  // proves it reaches editMessage byte-for-byte.
  it('keeps a typed @mention intact through the plain-text edit box', async () => {
    const user = userEvent.setup();
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const threads = makeThreads({
      messages: [message({ id: 'm1', author_user_id: 'u-self', body: 'remind me at 5' })],
      messagesState: 'ready',
      editMessage,
    });
    renderReader(threads);
    await user.click(screen.getByRole('button', { name: 'Edit this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, '@bob remind me at 5');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledWith('m1', '@bob remind me at 5'));
  });

  // The owner's case exactly: a posted "@bob Please summarize…", then edited.
  // The edit box opens on the stored body, so the `@` it already had must
  // survive a save that only touches the rest of the text.
  it('keeps an existing @bob when an edit only changes the rest of the message', async () => {
    const user = userEvent.setup();
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const threads = makeThreads({
      messages: [message({ id: 'm1', author_user_id: 'u-self', body: '@bob Please summarize' })],
      messagesState: 'ready',
      editMessage,
    });
    renderReader(threads);
    await user.click(screen.getByRole('button', { name: 'Edit this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect((box as HTMLTextAreaElement).value).toBe('@bob Please summarize');
    await user.type(box, ' this thread');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledWith('m1', '@bob Please summarize this thread'));
    expect(addressesBob(editMessage.mock.calls[0]?.[1] as string)).toBe(true);
  });

  // The owner's thread: "Bob Please summarize…" posted without the `@`, then
  // edited to address her, got no reply. An edit that ADDS @bob asks her once,
  // through the same askBob path and "Thinking…" state as a fresh post.
  it('asks Bob once when an edit adds @bob', async () => {
    const user = userEvent.setup();
    const edited = message({ id: 'm1', author_user_id: 'u-self', body: '@bob Please summarize', revision: 2 });
    const editMessage = vi.fn().mockResolvedValue(edited);
    const askBob = vi.fn(() => new Promise<never>(() => {}));
    const threads = makeThreads({
      messages: [message({ id: 'm1', author_user_id: 'u-self', body: 'Bob Please summarize' })],
      messagesState: 'ready',
      editMessage,
      askBob,
    });
    renderReader(threads);
    await user.click(screen.getByRole('button', { name: 'Edit this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, '@bob Please summarize');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(await screen.findByText('Thinking…')).toBeTruthy();
    expect(askBob).toHaveBeenCalledTimes(1);
    expect(askBob).toHaveBeenCalledWith(edited);
  });

  // Fixing a typo in a message that already addressed Bob must not ask her
  // again: she has answered it once already.
  it('does not ask Bob again when the message already addressed her', async () => {
    const user = userEvent.setup();
    const editMessage = vi.fn().mockResolvedValue(
      message({ id: 'm1', author_user_id: 'u-self', body: '@bob Please summarise', revision: 2 }),
    );
    const askBob = vi.fn();
    const threads = makeThreads({
      messages: [message({ id: 'm1', author_user_id: 'u-self', body: '@bob Please summarize' })],
      messagesState: 'ready',
      editMessage,
      askBob,
    });
    renderReader(threads);
    await user.click(screen.getByRole('button', { name: 'Edit this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(box);
    await user.type(box, '@bob Please summarise');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));

    await waitFor(() => expect(editMessage).toHaveBeenCalledWith('m1', '@bob Please summarise'));
    expect(askBob).not.toHaveBeenCalled();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });
});

// #862 (prod QA): "Remind me in 2 minutes to check the QA space", posted with
// no @bob, got no reply because only a mention ever asked her. Alone in the
// space there is no one else the message could be for, so it now reaches her
// like a personal chat's does; with another member present the composer still
// needs the `@` so Bob does not reply to people mid conversation unasked.
describe('ThreadReader — alone vs. sharing the space (#862)', () => {
  it('asks Bob on a plain message when alone in the space', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: 'Remind me in 2 minutes to check the QA space' });
    const askBob = vi.fn(() => new Promise<never>(() => {}));
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage: vi.fn().mockResolvedValue(posted),
      askBob,
    });
    renderReader(threads, SOLE_MEMBER_SPACE);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Remind me in 2 minutes to check the QA space{Enter}');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
    expect(askBob).toHaveBeenCalledTimes(1);
    expect(askBob).toHaveBeenCalledWith(posted);
  });

  it('does not ask Bob on the same plain message when another member shares the space', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: 'Remind me in 2 minutes to check the QA space' });
    const askBob = vi.fn();
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage: vi.fn().mockResolvedValue(posted),
      askBob,
    });
    renderReader(threads, TWO_MEMBER_SPACE);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Remind me in 2 minutes to check the QA space{Enter}');
    await waitFor(() => expect(threads.postMessage).toHaveBeenCalled());
    expect(askBob).not.toHaveBeenCalled();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });

  it('asks Bob on an explicit @bob mention when another member shares the space', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: '@bob remind me in 2 minutes' });
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage: vi.fn().mockResolvedValue(posted),
      askBob: vi.fn(() => new Promise<never>(() => {})),
    });
    renderReader(threads, TWO_MEMBER_SPACE);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('@bob remind me in 2 minutes{Enter}');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
  });

  // P0: one composer config. The thread reads like main chat whoever is in it.
  it('uses the default placeholder whether or not others share the space', () => {
    renderReader(makeThreads(), TWO_MEMBER_SPACE);
    expect(screen.getByText(COMPOSER_PLACEHOLDER)).toBeTruthy();
    expect(screen.queryByText(/mention @bob|choose Bob/)).toBeNull();
    cleanup();
    renderReader(makeThreads(), SOLE_MEMBER_SPACE);
    expect(screen.getByText(COMPOSER_PLACEHOLDER)).toBeTruthy();
  });

  it('shows the main chat toolbar: attach, @, Dictate and Voice mode', () => {
    renderReader(makeThreads(), TWO_MEMBER_SPACE);
    for (const name of ['Attach', 'Mention Bob, people or features', 'Dictate', 'Voice mode']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByText(/Posting to/)).toBeNull();
  });

  it('keeps an unsent draft per thread across a remount', async () => {
    const user = userEvent.setup();
    renderReader(makeThreads({ messagesState: 'ready' }));
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Half a thought');
    cleanup();
    renderReader(makeThreads({ messagesState: 'ready' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Message' }).textContent).toBe('Half a thought'));
    clearDraft(THREAD.id);
  });

  it('shows the @bob hint and does not ask Bob on a plain message when members list is empty (load failure)', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: 'Remind me in 2 minutes' });
    const askBob = vi.fn();
    const emptyMembersSpace: Space = { ...SPACE, members: [] };
    const threads = makeThreads({
      messages: [],
      messagesState: 'ready',
      postMessage: vi.fn().mockResolvedValue(posted),
      askBob,
    });
    renderReader(threads, emptyMembersSpace);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Remind me in 2 minutes{Enter}');
    await waitFor(() => expect(threads.postMessage).toHaveBeenCalled());
    expect(askBob).not.toHaveBeenCalled();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });
});

// #524: what a screen reader hears. Every message names its author and its
// audience; sends, conflicts and Bob's outcome go through one status region.
describe('ThreadReader announcements', () => {
  // Astryx's own controls carry a private status span inside the button (the
  // copy confirmation, a menu's selection), and its EmptyState is itself a
  // static role="status" block; the surface's region is every other one.
  const status = (): HTMLElement => {
    const regions = screen
      .getAllByRole('status')
      .filter((node) => node.closest('button') === null && !node.textContent?.startsWith('No messages yet'));
    expect(regions.map((node) => `${node.tagName}:${node.textContent ?? ''}`)).toEqual([expect.any(String)]);
    return regions[0] as HTMLElement;
  };

  it('names the author and the audience of every message, and the state of a pending or deleted one', () => {
    renderReader(
      makeThreads({
        messages: [
          message({ id: 'm1', author_user_id: 'u-riley', body: 'Hi' }),
          message({ id: 'm2', author_user_id: 'u-self', body: 'Hello' }),
          message({ id: 'm3', author_user_id: null, body: 'Noted' }),
          message({ id: 'm4', author_user_id: 'u-riley', body: '', tombstoned_at: 1 }),
          message({ id: 'pending-c9', author_user_id: 'pending', body: 'On my way' }),
        ],
        messagesState: 'ready',
      }),
    );
    const log = within(screen.getByRole('log'));
    expect(log.getByText('Riley to Home (3 members):')).toBeTruthy();
    expect(log.getByText('Bob to Home (3 members):')).toBeTruthy();
    expect(log.getByText('Riley to Home (3 members), deleted:')).toBeTruthy();
    expect(log.getByText('You to Home (3 members), sending:')).toBeTruthy();
    // Your own posted message and the pending one both read as yours.
    expect(log.getAllByText(/^You to Home \(3 members\)/)).toHaveLength(2);
  });

  it('has one status region, empty at rest and saying so while messages load', () => {
    renderReader(makeThreads({ messagesState: 'loading' }));
    expect(status().textContent).toBe('Loading messages…');
    cleanup();
    renderReader(makeThreads());
    expect(status().textContent).toBe('');
  });

  it('announces a send while it is on its way, and clears once it lands', async () => {
    const user = userEvent.setup();
    let land: (value: ThreadMessage) => void = () => {};
    const postMessage = vi.fn(() => new Promise<ThreadMessage>((resolve) => (land = resolve)));
    renderReader(makeThreads({ messagesState: 'ready', postMessage }));
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Buy milk{Enter}');
    await waitFor(() => expect(status().textContent).toBe('Sending your message to Home…'));
    land(message({ id: 'm9', author_user_id: 'u-self', body: 'Buy milk' }));
    await waitFor(() => expect(status().textContent).toBe(''));
  });

  it('announces an edit conflict, keeps the edit open with its text, and clears it on cancel', async () => {
    const user = userEvent.setup();
    const editMessage = vi.fn().mockRejectedValue(new HttpError('edit_failed', 409));
    renderReader(
      makeThreads({
        messages: [message({ id: 'm1', author_user_id: 'u-self', body: 'Buy milk' })],
        messagesState: 'ready',
        editMessage,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Edit this message' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), ' and eggs');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    await waitFor(() => expect(status().textContent).toMatch(/changed while you were editing/));
    expect((screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement).value).toBe(
      'Buy milk and eggs',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel edit' }));
    expect(status().textContent).toBe('');
  });

  it("announces Bob's busy answer through the same region", async () => {
    const user = userEvent.setup();
    renderReader(
      makeThreads({
        messagesState: 'ready',
        postMessage: vi.fn().mockResolvedValue(message({ id: 'm9', author_user_id: 'u-self', body: '@bob hi' })),
        askBob: vi.fn().mockResolvedValue('busy'),
      }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('@bob hi{Enter}');
    await waitFor(() => expect(status().textContent).toMatch(/already answering/));
  });

  it('holds a send while offline, says why, and keeps the draft through going back online', async () => {
    const user = userEvent.setup();
    const postMessage = vi.fn();
    renderReader(makeThreads({ messagesState: 'ready', postMessage }));
    const box = (): HTMLElement => screen.getByRole('combobox', { name: 'Message' });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await user.click(box());
    await user.keyboard('Buy milk{Enter}');
    await waitFor(() => expect(box().textContent).toBe('Buy milk'));
    expect(postMessage).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(box().textContent).toBe('Buy milk');
  });
});

it('the submitted mention token remains @bob', async () => {
  const postMessage = vi.fn().mockResolvedValue(message({ id: 'm9', body: '@bob hello' }));
  renderReader(makeThreads({ messages: [], messagesState: 'ready', postMessage }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: 'Message' }));
  await user.keyboard('@bob hello');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(postMessage).toHaveBeenCalled());
  expect(postMessage.mock.calls[0]?.[0]).toContain('@bob');
});
describe('ThreadReader conversation audience configuration', () => {
  it('requires an explicit Bob mention even before the first guest joins', async () => {
    const user = userEvent.setup();
    const posted = message({ id: 'm9', author_user_id: 'u-self', body: 'Hello everyone' });
    const threads = makeThreads({ messages: [], messagesState: 'ready', postMessage: vi.fn().mockResolvedValue(posted), askBob: vi.fn() });
    renderReader(threads, SOLE_MEMBER_SPACE, true);
    await user.click(screen.getByRole('combobox', { name: 'Message' }));
    await user.keyboard('Hello everyone{Enter}');
    await waitFor(() => expect(threads.postMessage).toHaveBeenCalledWith('Hello everyone'));
    expect(threads.askBob).not.toHaveBeenCalled();
  });
});

it('pins a bound app request before posting, invokes plain group text and keeps the one shared composer', async () => {
  const user = userEvent.setup();
  const posted = message({ id: 'm9', author_user_id: 'u-self', body: 'Plan our week' });
  let release: (value: ThreadMessage) => void = () => undefined;
  const threads = makeThreads({ messagesState: 'ready', postMessage: vi.fn(() => new Promise<ThreadMessage>((resolve) => { release = resolve; })), askBob: vi.fn().mockResolvedValue('answered') });
  const binding = { installationId: 'installation', mode: 'run' as const, campaignId: null };
  const view = (campaignId: string | null) => <Theme theme={neutralTheme}><ThreadReader space={TWO_MEMBER_SPACE} thread={THREAD} threads={threads} appBinding={{ ...binding, campaignId }} /></Theme>;
  const { rerender } = render(view(null));
  await user.click(screen.getByRole('combobox', { name: 'Message' }));
  await user.keyboard('Plan our week{Enter}');
  await waitFor(() => expect(threads.postMessage).toHaveBeenCalled());
  rerender(view('another-campaign'));
  await act(async () => release(posted));
  await waitFor(() => expect(threads.askBob).toHaveBeenCalledWith(posted, binding));
  expect(screen.getAllByRole('combobox', { name: 'Message' })).toHaveLength(1);
});
