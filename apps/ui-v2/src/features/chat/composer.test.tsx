import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef, type ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShellMobileContext } from '@astryxdesign/core/AppShell';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Composer } from './composer';
import { addressesBob } from './mentions';
import { integrationMentions } from './platform-mentions';
import { getDraft, resetDrafts, setDraft } from './drafts';

const mobileDefaults = {
  isMobile: false,
  isMobileNavOpen: false,
  toggleMobileNav: () => {},
  openMobileNav: () => {},
  closeMobileNav: () => {},
  isMobileNavEnabled: false,
  hasAutoToggle: true,
};

afterEach(() => {
  cleanup();
  resetDrafts();
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <Theme theme={neutralTheme} mode="system">
      <Composer busy={false} members={[]} onSend={onSend} onStop={vi.fn()} {...overrides} />
    </Theme>,
  );
  return { onSend };
}

function image(name = 'cat.png', size = 8, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type });
}

const picker = (): HTMLInputElement => screen.getByLabelText('Upload files') as HTMLInputElement;
// applyAccept: false lets a wrong-type file reach the input's change handler,
// as it does from a paste, a drop or a picker set to "All files".
const newUser = (): ReturnType<typeof userEvent.setup> => userEvent.setup({ applyAccept: false });

describe('Composer attachments', () => {
  it('focuses the existing composer without replacing its unsent text or attachments', async () => {
    const focusRef = createRef<(() => void) | null>();
    const user = newUser();
    const { onSend } = renderComposer({ draftKey: 'bound-app', focusRef });
    const input = screen.getByRole('combobox', { name: 'Message input' });
    await user.type(input, 'Keep my app idea');
    await user.upload(picker(), image('idea.png'));
    await screen.findByText('idea.png');
    screen.getByRole('button', { name: 'Attach' }).focus();
    await waitFor(() => expect(focusRef.current).toBeTypeOf('function'));
    act(() => focusRef.current?.());
    expect(document.activeElement).toBe(input);
    expect(input.textContent).toBe('Keep my app idea');
    expect(getDraft('bound-app')).toBe('Keep my app idea');
    expect(screen.getByText('idea.png')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    cleanup();
    expect(focusRef.current).toBeNull();
  });
  it('offers Attach with images, PDF, Word and plain text', () => {
    renderComposer();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();
    expect(picker().accept).toBe('image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.txt,.doc,.docx');
    expect(picker().multiple).toBe(true);
  });

  it.each([
    ['notes.pdf', 'application/pdf'], ['notes.doc', 'application/msword'],
    ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['notes.txt', 'text/plain'],
  ])('stages and sends %s as a named document without an image preview', async (filename, mediaType) => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.upload(picker(), new File(['document'], filename, { type: mediaType }));
    expect(await screen.findByText(filename)).toBeTruthy();
    expect(document.querySelector('img[src^="data:"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ type: 'file', filename, mediaType })]);
  });

  it('stages a picked image with its filename, a thumbnail and a remove control', async () => {
    const user = newUser();
    renderComposer();
    await user.upload(picker(), image('cat.png'));
    expect(await screen.findByText('cat.png')).toBeTruthy();
    expect(document.querySelector('img[src^="data:image/png;base64,"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove cat.png' })).toBeTruthy();
  });

  it('removes a staged image', async () => {
    const user = newUser();
    renderComposer();
    await user.upload(picker(), [image('a.png'), image('b.png')]);
    await screen.findByText('b.png');
    await user.click(screen.getByRole('button', { name: 'Remove a.png' }));
    await waitFor(() => expect(screen.queryByText('a.png')).toBeNull());
    expect(screen.getByText('b.png')).toBeTruthy();
  });

  it('shows a wrong type as an alert, stages nothing, and a good pick clears it', async () => {
    const user = newUser();
    renderComposer();
    await user.upload(picker(), image('archive.zip', 8, 'application/zip'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image.');
    expect(screen.queryByText('archive.zip')).toBeNull();

    await user.upload(picker(), image('ok.png'));
    expect(await screen.findByText('ok.png')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a fifth image with the count message and keeps the four', async () => {
    const user = newUser();
    renderComposer();
    await user.upload(picker(), [1, 2, 3, 4].map((n) => image(`f${n}.png`)));
    await screen.findByText('f4.png');
    await user.upload(picker(), image('f5.png'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'At most 4 files can be attached to one message.',
    );
    expect(screen.queryByText('f5.png')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(4);
  });

  it('refuses overlapping batches that would together pass four images', async () => {
    renderComposer();
    const batch = (prefix: string): File[] => [1, 2, 3].map((n) => image(`${prefix}${n}.png`));
    // Both batches arrive before either has been read, as a paste does while a
    // picker batch is still loading, so each one meets an empty tray.
    fireEvent.change(picker(), { target: { files: batch('a') } });
    fireEvent.change(picker(), { target: { files: batch('b') } });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'At most 4 files can be attached to one message.',
    );
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3);
  });

  it('refuses an image over 4 MB with the size message', async () => {
    const user = newUser();
    renderComposer();
    await user.upload(picker(), image('huge.png', 4 * 1024 * 1024 + 1));
    expect((await screen.findByRole('alert')).textContent).toContain('That file is larger than 4 MB.');
    expect(screen.queryByText('huge.png')).toBeNull();
  });
});

describe('Composer send with attachments', () => {
  const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' });

  it('keeps Send disabled with no text and no files, and enables it for a staged image', async () => {
    const user = newUser();
    renderComposer();
    expect(sendButton().hasAttribute('disabled')).toBe(true);
    await user.upload(picker(), image('cat.png'));
    await screen.findByText('cat.png');
    expect(sendButton().hasAttribute('disabled')).toBe(false);
  });

  it('sends an image with no text as an image-only turn and clears the staged file', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.upload(picker(), image('cat.png'));
    await screen.findByText('cat.png');
    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('', [
      {
        type: 'file',
        mediaType: 'image/png',
        filename: 'cat.png',
        url: expect.stringMatching(/^data:image\/png;base64,/),
      },
    ]);
    await waitFor(() => expect(screen.queryByText('cat.png')).toBeNull());
  });

  it('sends a staged image on Enter with an empty message box', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.upload(picker(), image('cat.png'));
    await screen.findByText('cat.png');
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), '{Enter}');
    expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ filename: 'cat.png' })]);
  });

  it('sends the typed text together with the staged image', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.upload(picker(), image('cat.png'));
    await screen.findByText('cat.png');
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'what is this');
    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('what is this', [expect.objectContaining({ filename: 'cat.png' })]);
  });

  it('sends plain text with no files argument', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.type(screen.getByRole('combobox', { name: 'Message input' }), 'hello');
    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('refuses a send over 8 MB together and keeps the staged files', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    // Three 3 MB images are each inside the 4 MB bound but come to 9 MB.
    const big = [1, 2, 3].map((n) => image(`big${n}.png`, 3 * 1024 * 1024));
    await user.upload(picker(), big);
    await screen.findByText('big3.png');
    await user.click(sendButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Those files come to more than 8 MB together. Remove one and send again.',
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(3);
  });

  it('stages an image pasted into the message box', async () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    const file = image('pasted.png');
    fireEvent.paste(box, {
      clipboardData: { files: [file], items: [], types: ['Files'], getData: () => '' },
    });
    expect(await screen.findByText('pasted.png')).toBeTruthy();
  });

  it('stages an image dropped on the message box', async () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    const file = image('dropped.png');
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(await screen.findByText('dropped.png')).toBeTruthy();
  });

  it('shows the accept error for a dropped wrong type and stages nothing', async () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    const file = image('archive.zip', 8, 'application/zip');
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [file] } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image.');
    expect(screen.queryByText('archive.zip')).toBeNull();
  });

  it('shows the size error for a dropped oversized image', async () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    const file = image('huge.png', 4 * 1024 * 1024 + 1);
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [file] } });
    expect((await screen.findByRole('alert')).textContent).toContain('That file is larger than 4 MB.');
    expect(screen.queryByText('huge.png')).toBeNull();
  });

  it('prevents default only for a drag that carries files', () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    expect(fireEvent.dragOver(box, { dataTransfer: { types: ['Files'], files: [] } })).toBe(false);
    expect(fireEvent.dragOver(box, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
  });

  it('shows the accept error for a pasted wrong type', async () => {
    renderComposer();
    const box = screen.getByRole('combobox', { name: 'Message input' });
    const file = image('archive.zip', 8, 'application/zip');
    fireEvent.paste(box, {
      clipboardData: { files: [file], items: [], types: ['Files'], getData: () => '' },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image.');
    expect(screen.queryByText('archive.zip')).toBeNull();
  });
});

describe('Composer drafts', () => {
  const box = (): HTMLElement => screen.getByRole('combobox', { name: 'Message input' });

  it('saves what is typed under its draft key', async () => {
    const user = newUser();
    renderComposer({ draftKey: 'c1' });
    await user.type(box(), 'half a thou');
    expect(getDraft('c1')).toBe('half a thou');
  });

  it('puts the draft back when it mounts', async () => {
    setDraft('c1', 'where I left off');
    renderComposer({ draftKey: 'c1' });
    await waitFor(() => expect(box().textContent).toBe('where I left off'));
    // Restoring is not typing: it saves the same text and nothing else.
    expect(getDraft('c1')).toBe('where I left off');
  });

  it('restores only its own key', async () => {
    setDraft('c2', 'for another conversation');
    renderComposer({ draftKey: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(box().textContent).toBe('');
  });

  it('clears the draft when the text is sent', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ draftKey: 'c1' });
    await user.type(box(), 'send me');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('send me');
    expect(getDraft('c1')).toBe('');
  });

  it('keeps the draft when a turn is in flight and nothing is sent', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ draftKey: 'c1', busy: true });
    await user.type(box(), 'not yet{Enter}');
    await waitFor(() => expect(getDraft('c1')).toBe('not yet'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('saves nothing without a draft key', async () => {
    const user = newUser();
    renderComposer();
    await user.type(box(), 'anonymous');
    expect(getDraft('new')).toBe('');
  });

  it('saves to the new key after the key moves under a mounted composer', async () => {
    const user = newUser();
    const onSend = vi.fn();
    const tree = (draftKey: string): ReturnType<typeof Composer> => (
      <Composer busy={false} draftKey={draftKey} members={[]} onSend={onSend} onStop={vi.fn()} />
    );
    const { rerender } = render(<Theme theme={neutralTheme} mode="system">{tree('new')}</Theme>);
    await user.type(box(), 'typed while creating');
    rerender(<Theme theme={neutralTheme} mode="system">{tree('c9')}</Theme>);
    await user.type(box(), '!');
    expect(getDraft('c9')).toBe('typed while creating!');
  });
});

// A screenshot showed a posted message reading "Bob Please summarize…" — the
// `@` missing, so a reader's addressesBob() check on the posted text would
// come back false. These pin the mention menu to the serialized @handle (the
// token's `value`), never the display name shown in its `label`.
describe('Composer mentions', () => {
  it('refreshes an open mention search when accounts arrive without another keystroke', async () => {
    const onSend = vi.fn();
    const tree = (members: Parameters<typeof Composer>[0]['members']): ReactElement =>
      <Theme theme={neutralTheme} mode="system"><Composer members={members} onSend={onSend} /></Theme>;
    const view = render(tree([]));
    const input = screen.getByRole('combobox', { name: 'Message input' });
    await newUser().type(input, '@Work');
    expect(await screen.findByText('No matches. Try Bob, a feature or a connected account.')).toBeTruthy();
    fireEvent.compositionStart(input);
    view.rerender(tree(integrationMentions([{ id: 'private', email: 'work@example.test', customName: 'Work Gmail',
      name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false }])));
    expect(screen.queryByRole('option', { name: (name) => name.startsWith('Work Gmail') && !name.startsWith('Work Gmail.') })).toBeNull();
    fireEvent.compositionEnd(input);
    view.rerender(tree(integrationMentions([{ id: 'private', email: 'work@example.test', customName: 'Work Gmail',
      name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false }])));
    expect(await screen.findByRole('option', { name: (name) => name.startsWith('Work Gmail') && !name.startsWith('Work Gmail.') })).toBeTruthy();
    expect(input.textContent).toContain('@Work');
    expect(document.activeElement).toBe(input);
    expect(onSend).not.toHaveBeenCalled();
    await newUser().keyboard('{Escape}');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    view.rerender(tree([]));
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.textContent).toContain('@Work');
  });
  const RILEY = { user_id: 'u1', role: 'member', display_name: 'Riley Chen', handle: 'riley', email: null };
  const BOB = { user_id: 'bob', role: 'assistant', display_name: 'Bob', handle: 'bob', email: null };
  const box = (): HTMLElement => screen.getByRole('combobox', { name: 'Message input' });

  // Picks from the Mention Bob, people or features menu and waits for the token to land in the
  // box: it goes in one frame after the pick, once the menu has let go of focus.
  async function pick(user: ReturnType<typeof newUser>, name: RegExp, handle: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Mention Bob, people or features' }));
    await user.click(await screen.findByRole('menuitem', { name }));
    await waitFor(() => expect(box().querySelector(`[data-astryx-token-value="@${handle}"]`)).not.toBeNull());
  }

  // Types where focus and the caret already are, as a reader carrying on after
  // a pick does; clicking the box first would move the caret itself.
  const typeOn = (user: ReturnType<typeof newUser>, text: string): Promise<void> =>
    user.type(box(), text, { skipClick: true });

  async function sentBody(user: ReturnType<typeof newUser>, onSend: ReturnType<typeof vi.fn>): Promise<string> {
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledTimes(1);
    return (onSend.mock.calls[0] as [string])[0];
  }

  it('offers the assistant and platform features when there are no space members', async () => {
    const user = newUser();
    const { onSend } = renderComposer();
    await user.click(screen.getByRole('button', { name: 'Mention Bob, people or features' }));
    expect(screen.getByRole('menuitem', { name: /^Bob/ })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: /^Routines/ }));
    await waitFor(() => expect(box().querySelector('[data-astryx-token-value="@{feature:Routines:/routines}"]')).not.toBeNull());
    expect(onSend).not.toHaveBeenCalled();
    expect(await sentBody(user, onSend)).toBe('@{feature:Routines:/routines}');
  });

  it('keeps the chosen account readable in the submitted integration reference', async () => {
    const user = newUser();
    const members = integrationMentions([{ id: 'never-show-id', email: 'mine@example.test', name: null, selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false }]);
    const { onSend } = renderComposer({ members });
    await user.click(screen.getByRole('button', { name: 'Mention Bob, people or features' }));
    await user.click(screen.getByRole('menuitem', { name: (name) => name.startsWith('Gmail') && !name.startsWith('Gmail.') }));
    await waitFor(() => expect(box().querySelector('[data-astryx-token-value="@{integration:Gmail:mine@example.test}"]')).not.toBeNull());
    expect(onSend).not.toHaveBeenCalled();
    await typeOn(user, 'summarize daily');
    expect(await sentBody(user, onSend)).toBe('@{integration:Gmail:mine@example.test} summarize daily');
  });

  it('selects a named integration action without sending until the reader submits', async () => {
    const user = newUser();
    const members = integrationMentions([{ id: 'private', email: 'work@example.test', customName: 'WorkGmail', name: null,
      selected: true, createdAt: 1, access: ['gmail.read'], needsReconnect: false }]);
    const { onSend } = renderComposer({ members });
    await user.type(box(), '@WorkGmail.search');
    await user.click(await screen.findByRole('option', { name: /^WorkGmail\.search/ }));
    await waitFor(() => expect(box().querySelector('[data-astryx-token-value="@{integration:Gmail.search:work@example.test}"]')).not.toBeNull());
    expect(onSend).not.toHaveBeenCalled();
    expect(await sentBody(user, onSend)).toBe('@{integration:Gmail.search:work@example.test}');
  });

  it('sends the picked member\'s @handle, not their display name', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ members: [RILEY] });
    await pick(user, /Riley Chen/, 'riley');
    await user.type(box(), ' are you free');
    const sent = await sentBody(user, onSend);
    expect(sent).toContain('@riley');
    expect(sent).not.toContain('Riley Chen');
  });

  it('sends @bob, not "Bob", when the assistant is picked, so Bob is asked', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ members: [RILEY, BOB] });
    await pick(user, /^Bob/, 'bob');
    await user.type(box(), ' Please summarize');
    const sent = await sentBody(user, onSend);
    expect(sent).toContain('@bob');
    expect(sent).not.toMatch(/(^|[^@])Bob Please/);
    expect(addressesBob(sent)).toBe(true);
  });

  // CI caught "Please summarize@bob": the menu took the caret back after the
  // pick, so the typing landed before the token and Bob was not addressed.
  it('leaves the caret after a picked member, one space before what is typed', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ members: [RILEY] });
    await pick(user, /Riley Chen/, 'riley');
    expect(document.activeElement).toBe(box());
    await typeOn(user, ' are you free');
    expect(await sentBody(user, onSend)).toBe('@riley are you free');
  });

  it('leaves the caret after a picked Bob, so the message addresses Bob', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ members: [RILEY, BOB] });
    await pick(user, /^Bob/, 'bob');
    await typeOn(user, 'Please summarize');
    const sent = await sentBody(user, onSend);
    expect(sent).toBe('@bob Please summarize');
    expect(addressesBob(sent)).toBe(true);
  });

  it('puts a mention picked after typing at the caret, one space after the text', async () => {
    const user = newUser();
    const { onSend } = renderComposer({ members: [RILEY, BOB] });
    await user.type(box(), 'Thanks');
    await pick(user, /^Bob/, 'bob');
    await typeOn(user, 'please summarize');
    const sent = await sentBody(user, onSend);
    expect(sent).toBe('Thanks @bob please summarize');
    expect(addressesBob(sent)).toBe(true);
  });
});

// P0 shell-chat "Composer > Mic button": two clear controls, never blocked by a reply.
describe('Composer voice controls', () => {
  const voice = (state: 'off' | 'listening' = 'off') => ({
    state,
    micLive: state === 'listening',
    start: vi.fn(),
    stop: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    onPointerDown: vi.fn(),
  });
  const enabled = (button: HTMLElement): boolean =>
    !(button as HTMLButtonElement).disabled && button.getAttribute('aria-disabled') !== 'true';

  it('offers Dictate and Voice mode as two buttons, both usable while a reply streams', async () => {
    const mode = voice();
    renderComposer({ busy: true, voice: mode });
    const dictate = screen.getByRole('button', { name: 'Dictate' });
    const voiceMode = screen.getByRole('button', { name: 'Voice mode' });
    expect(enabled(dictate)).toBe(true);
    expect(enabled(voiceMode)).toBe(true);
    await userEvent.setup().click(voiceMode);
    expect(mode.start).toHaveBeenCalledTimes(1);
    // Pointer-down cuts a spoken reply off (barge-in).
    expect(mode.onPointerDown).toHaveBeenCalled();
  });

  it('turns Voice mode into End voice mode while it is on', async () => {
    const mode = voice('listening');
    renderComposer({ voice: mode });
    await userEvent.setup().click(screen.getByRole('button', { name: 'End voice mode' }));
    expect(mode.stop).toHaveBeenCalledTimes(1);
  });

  it('dictates into the box without sending', async () => {
    const tracks = [{ stop: vi.fn() }];
    class Recorder {
      static last: Recorder | null = null;
      state = 'inactive';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        Recorder.last = this;
      }
      start(): void {
        this.state = 'recording';
      }
      stop(): void {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) },
      configurable: true,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ text: 'buy milk' }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const { onSend } = renderComposer();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await user.click(await screen.findByRole('button', { name: 'Stop dictating' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Message input' }).textContent).toContain('buy milk'));
    expect(onSend).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('hides each control by its contract prop', () => {
    renderComposer({ voice: voice(), canDictate: false, canVoiceMode: false, canAttach: false });
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Voice mode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
  });

  it('says "Ask Bob anything" (the brand\'s assistant) by default', () => {
    renderComposer();
    expect(screen.getByText(/^Ask (Bob|Bob) anything$/)).toBeTruthy();
  });
});

describe('Composer on a phone', () => {
  function renderOn(isMobile: boolean) {
    render(
      <Theme theme={neutralTheme} mode="system">
        <AppShellMobileContext value={{ ...mobileDefaults, isMobile }}>
          <Composer busy={false} members={[]} onSend={vi.fn()} onStop={vi.fn()} voice={{ state: 'off', micLive: false, start: vi.fn(), stop: vi.fn(), mute: vi.fn(), unmute: vi.fn(), onPointerDown: vi.fn() }} />
        </AppShellMobileContext>
      </Theme>,
    );
    return screen.getByRole('combobox', { name: 'Message input' });
  }

  it('puts Attach, @, Voice mode and the caller\'s actions on the top row, with no More options menu', () => {
    render(
      <Theme theme={neutralTheme} mode="system">
        <AppShellMobileContext value={{ ...mobileDefaults, isMobile: true }}>
          <Composer
            busy={false}
            members={[]}
            onSend={vi.fn()}
            onStop={vi.fn()}
            voice={{ state: 'off', micLive: false, start: vi.fn(), stop: vi.fn(), mute: vi.fn(), unmute: vi.fn(), onPointerDown: vi.fn() }}
            phoneActions={<button type="button">Tools</button>}
          />
        </AppShellMobileContext>
      </Theme>,
    );
    for (const name of ['Attach', 'Mention Bob, people or features', 'Voice mode', 'Tools']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lists the @ menu\'s members from the top-row Mention button and picking one inserts its token, not a raw "@"', async () => {
    const riley = { user_id: 'u1', role: 'member', display_name: 'Riley Chen', handle: 'riley', email: null };
    render(
      <Theme theme={neutralTheme} mode="system">
        <AppShellMobileContext value={{ ...mobileDefaults, isMobile: true }}>
          <Composer busy={false} members={[riley]} onSend={vi.fn()} onStop={vi.fn()} />
        </AppShellMobileContext>
      </Theme>,
    );
    const user = newUser();
    await user.click(screen.getByRole('button', { name: 'Mention Bob, people or features' }));
    expect(await screen.findByRole('menuitem', { name: /^Bob/ })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: /Riley Chen/ }));
    const input = screen.getByRole('combobox', { name: 'Message input' });
    await waitFor(() => expect(input.querySelector('[data-astryx-token-value="@riley"]')).not.toBeNull());
  });

  it('shows the mic when the box is empty and Send once there is text', async () => {
    const input = renderOn(true);
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await newUser().type(input, 'hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
  });

  it('keeps the Dictate button named but tooltip-free on a phone', () => {
    renderOn(true);
    const mic = screen.getByRole('button', { name: 'Dictate' });
    expect(mic.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the Attach button named but tooltip-free on a phone', () => {
    renderOn(true);
    const attach = screen.getByRole('button', { name: 'Attach' });
    expect(attach.getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps Attach and @ above the input on desktop, with no More options menu', () => {
    const input = renderOn(false);
    const attach = screen.getByRole('button', { name: 'Attach' });
    expect(Boolean(attach.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });
});
