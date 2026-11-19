import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { AppShellMobileContext } from '@astryxdesign/core/AppShell';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { DeviceNameProvider, MessageView } from './message-view';
import { BRAND } from '@/lib/brand';
import { thoughtLabel } from './reasoning';
import { sendReplyFeedback } from '@/features/metrics/reply-feedback';

vi.mock('@/features/metrics/reply-feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/metrics/reply-feedback')>()),
  sendReplyFeedback: vi.fn(async () => undefined),
}));

const spacesHook = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/features/spaces/use-spaces', () => ({ useOptionalSpaces: () => spacesHook.value }));

type Props = Partial<ComponentProps<typeof MessageView>> & { message: UIMessage };

function Harness(props: Props): ReactElement {
  return (
    <Theme theme={neutralTheme} mode="system">
      <MessageView isStreaming={false} mentionTokens={[]} {...props} />
    </Theme>
  );
}

function assistant(parts: UIMessage['parts'], metadata?: unknown): UIMessage {
  return { id: 'a1', role: 'assistant', parts, ...(metadata ? { metadata } : {}) } as UIMessage;
}

const reply = assistant([{ type: 'text', text: 'Here is your week.' }]);
const question: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Plan my week' }] };

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';

afterEach(() => {
  cleanup();
  vi.mocked(sendReplyFeedback).mockClear();
  spacesHook.value = null;
});

describe('reasoning', () => {
  it('reads Thinking... while streaming and Thought for once finished', () => {
    const streaming = assistant([{ type: 'reasoning', text: 'hmm', state: 'streaming' }]);
    const { rerender } = render(<Harness message={streaming} isStreaming />);
    const trigger = screen.getByRole('button', { name: 'Thinking...' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    const done = assistant([
      { type: 'reasoning', text: 'hmm', state: 'done' },
      { type: 'text', text: 'Answer' },
    ]);
    rerender(<Harness message={done} />);
    expect(screen.getByRole('button', { name: /Thought for/ })).toBeTruthy();
  });

  it('words the duration', () => {
    expect(thoughtLabel(true, null)).toBe('Thinking...');
    expect(thoughtLabel(false, 1)).toBe('Thought for a few seconds');
    expect(thoughtLabel(false, 5)).toBe('Thought for 5 seconds');
  });
});

describe('sent time', () => {
  // 09:05 today, local time, so the time-only format applies.
  const today = new Date();
  today.setHours(9, 5, 0, 0);

  it("shows the time a message was sent under the reader's message and the reply", () => {
    render(<Harness message={{ ...question, metadata: { createdAt: today.getTime() } } as UIMessage} />);
    expect(document.body.textContent).toMatch(/9:05/);
    cleanup();
    render(<Harness message={assistant(reply.parts, { createdAt: today.getTime() })} />);
    expect(document.body.textContent).toMatch(/9:05/);
  });

  it('shows no time when none is known', () => {
    render(<Harness message={question} />);
    expect(document.body.textContent).not.toMatch(/\d:\d\d/);
  });
});

describe('badges and stub', () => {
  it('renders the local-stub notice', () => {
    render(<Harness message={assistant([{ type: 'data-stub', data: {} }])} />);
    expect(screen.getByText('System test mode: this response is a local stub.')).toBeTruthy();
  });

  // P1 shell-chat "Origin note": the device's own name, never a hard-coded model, and no live region.
  it('notes a message sent from the device by the device name, and no other', () => {
    render(
      <DeviceNameProvider value="Kitchen Bob">
        <Harness message={assistant(reply.parts, { origin: 'device' })} />
      </DeviceNameProvider>,
    );
    expect(screen.getByText('via Kitchen Bob')).toBeTruthy();
    expect(screen.queryByText(/Cardputer/)).toBeNull();
    expect(screen.getByText('via Kitchen Bob').closest('[role="status"]')).toBeNull();
    cleanup();
    render(<Harness message={assistant(reply.parts, { origin: 'device' })} />);
    expect(screen.getByText('via your device')).toBeTruthy();
    cleanup();
    render(<Harness message={reply} />);
    expect(screen.queryByText(/^via /)).toBeNull();
  });

  it('notes a message spoken to the web mic as spoken, apart from one via the device', () => {
    render(<Harness message={{ ...question, metadata: { origin: 'web_voice' } } as UIMessage} />);
    expect(screen.getByText('spoken')).toBeTruthy();
    expect(screen.queryByText(/^via /)).toBeNull();
    cleanup();
    render(<Harness message={assistant(reply.parts, { origin: 'web_voice' })} />);
    expect(screen.getByText('spoken')).toBeTruthy();
    cleanup();
    render(<Harness message={{ ...question, metadata: { origin: 'device' } } as UIMessage} />);
    expect(screen.queryByText('spoken')).toBeNull();
    expect(screen.getByText('via your device')).toBeTruthy();
    cleanup();
    render(<Harness message={{ ...question, metadata: { origin: 'web_text' } } as UIMessage} />);
    expect(screen.queryByText('spoken')).toBeNull();
    expect(screen.queryByText(/^via /)).toBeNull();
  });

});

describe('assistant avatar', () => {
  it('shows the Bob brand mark beside a reply and none beside a question', () => {
    render(<Harness message={reply} />);
    expect(screen.getByRole('img', { name: 'Bob' }).getAttribute('viewBox')).toBe('0 0 24 24');
    cleanup();
    render(<Harness message={question} />);
    expect(screen.queryByRole('img', { name: 'Bob' })).toBeNull();
  });
});

describe('attachments on a user message', () => {
  const catPng = {
    type: 'file',
    mediaType: 'image/png',
    filename: 'cat.png',
    url: 'data:image/png;base64,AQID',
  } as const;
  const notes = { type: 'file', mediaType: 'application/pdf', filename: 'notes.pdf', url: 'data:x' } as const;
  const sent = (parts: UIMessage['parts']): UIMessage => ({ id: 'u2', role: 'user', parts });

  it('renders an image-only message as its thumbnail, with nothing to edit', () => {
    render(<Harness message={sent([catPng])} onEditResend={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'cat.png' }).getAttribute('src')).toBe(catPng.url);
    expect(screen.queryByRole('button', { name: 'Edit and resend this message' })).toBeNull();
  });

  it('renders a captioned image with both the image and the caption', () => {
    render(<Harness message={sent([{ type: 'text', text: 'what is this' }, catPng])} />);
    expect(screen.getByRole('img', { name: 'cat.png' })).toBeTruthy();
    expect(screen.getByText('what is this')).toBeTruthy();
  });

  it('shows a non-image file as its filename', () => {
    render(<Harness message={sent([notes])} />);
    expect(screen.getByText('notes.pdf')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('assistant actions', () => {
  it('rates a finished reply on its server trace, then allows changing the rating', async () => {
    const user = userEvent.setup();
    const traceId = '1234567890abcdef1234567890abcdef';
    render(<Harness message={assistant(reply.parts, { traceId })} />);
    await user.click(screen.getByRole('button', { name: 'Helpful response' }));
    expect(sendReplyFeedback).toHaveBeenLastCalledWith(traceId, true);
    await user.click(screen.getByRole('button', { name: 'Unhelpful response' }));
    expect(sendReplyFeedback).toHaveBeenLastCalledWith(traceId, false);
  });

  it('does not rate an untraced or streaming reply', () => {
    const { rerender } = render(<Harness message={reply} />);
    expect(screen.queryByRole('button', { name: 'Helpful response' })).toBeNull();
    rerender(<Harness message={assistant(reply.parts, { traceId: '1234567890abcdef1234567890abcdef' })} isStreaming />);
    expect(screen.queryByRole('button', { name: 'Helpful response' })).toBeNull();
    expect(sendReplyFeedback).not.toHaveBeenCalled();
  });
  it('copies the reply, then reverts the label', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    render(<Harness message={reply} />);
    await user.click(screen.getByRole('button', { name: 'Copy response' }));
    expect(writeText).toHaveBeenCalledWith('Here is your week.');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy response' })).toBeTruthy(), {
      timeout: 2500,
    });
  });

  it('reports a clipboard failure', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const onCopyFailure = vi.fn();
    render(<Harness message={reply} onCopyFailure={onCopyFailure} />);
    await user.click(screen.getByRole('button', { name: 'Copy response' }));
    await waitFor(() => expect(onCopyFailure).toHaveBeenCalledTimes(1));
  });

  it('regenerates, but not while busy', async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const { rerender } = render(<Harness message={reply} onRegenerate={onRegenerate} />);
    await user.click(screen.getByRole('button', { name: 'Regenerate reply' }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    rerender(<Harness message={reply} onRegenerate={onRegenerate} busy />);
    expect(isDisabled(screen.getByRole('button', { name: 'Regenerate reply' }))).toBe(true);
  });

  it('keeps the actions on a reply whose last part is a tool call', async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn();
    const endsInTool = assistant([
      { type: 'text', text: 'Checking.' },
      { type: 'tool-getWeather', toolCallId: 't1', state: 'output-available', input: {}, output: {} },
    ] as UIMessage['parts']);
    render(<Harness message={endsInTool} onRegenerate={onRegenerate} />);
    expect(screen.getByRole('button', { name: 'Copy response' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Regenerate reply' }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('offers no actions while the reply is still streaming', () => {
    render(<Harness message={reply} isStreaming onRegenerate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate reply' })).toBeNull();
  });
});

describe('versions', () => {
  it('rates the selected version trace instead of the newest reply trace', async () => {
    const user = userEvent.setup();
    const first = '11111111111111111111111111111111';
    const latest = '22222222222222222222222222222222';
    const versionProps = { texts: ['First.', 'Second.'], traceIds: [first, latest], active: 0, onSelect: vi.fn() };
    const { rerender } = render(<Harness message={assistant(reply.parts, { traceId: latest })} versions={versionProps} />);
    await user.click(screen.getByRole('button', { name: 'Helpful response' }));
    expect(sendReplyFeedback).toHaveBeenLastCalledWith(first, true);
    rerender(<Harness message={assistant(reply.parts, { traceId: latest })} versions={{ ...versionProps, active: 1 }} />);
    await user.click(screen.getByRole('button', { name: 'Unhelpful response' }));
    expect(sendReplyFeedback).toHaveBeenLastCalledWith(latest, false);
  });

  it('hides feedback for a historical version without a trace', () => {
    render(<Harness message={assistant(reply.parts, { traceId: '22222222222222222222222222222222' })}
      versions={{ texts: ['Old.', 'New.'], active: 0, onSelect: vi.fn() }} />);
    expect(screen.queryByRole('button', { name: 'Helpful response' })).toBeNull();
  });
  const versions = (active: number, onSelect = vi.fn()): ComponentProps<typeof MessageView>['versions'] => ({
    texts: ['First take.', 'Second take.'],
    active,
    onSelect,
  });

  it('shows the active version with an N of M label and steps between them', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness message={reply} versions={versions(1, onSelect)} />);
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByText('Second take.')).toBeTruthy();
    expect(screen.queryByText('Here is your week.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('shows no selector for a single version', () => {
    render(<Harness message={reply} versions={{ texts: ['Only.'], active: 0, onSelect: vi.fn() }} />);
    expect(screen.queryByRole('button', { name: 'Next version' })).toBeNull();
    expect(screen.getByText('Here is your week.')).toBeTruthy();
  });

  it('shows the session-only note while an older version is active, not on the newest', () => {
    const { rerender } = render(<Harness message={reply} versions={versions(0)} />);
    expect(screen.getByText('Session only. Bob continues from the newest version.')).toBeTruthy();
    rerender(<Harness message={reply} versions={versions(1)} />);
    expect(screen.queryByText('Session only. Bob continues from the newest version.')).toBeNull();
  });
});

describe('editing a user message', () => {
  const edit = async (onEditResend: (text: string) => void, typed: string): Promise<void> => {
    const user = userEvent.setup();
    render(<Harness message={question} onEditResend={onEditResend} />);
    await user.click(screen.getByRole('button', { name: 'Edit and resend this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.clear(box);
    if (typed) await user.type(box, typed);
    await user.click(screen.getByRole('button', { name: 'Send edited message' }));
  };

  it('sends the edited text', async () => {
    const onEditResend = vi.fn();
    await edit(onEditResend, 'Plan my month');
    expect(onEditResend).toHaveBeenCalledWith('Plan my month');
  });

  it('treats empty text as a no-op', async () => {
    const onEditResend = vi.fn();
    await edit(onEditResend, '');
    expect(onEditResend).not.toHaveBeenCalled();
  });

  it('sends on Enter, keeps a newline on Shift+Enter, cancels on Escape', async () => {
    const user = userEvent.setup();
    const onEditResend = vi.fn();
    render(<Harness message={question} onEditResend={onEditResend} />);
    await user.click(screen.getByRole('button', { name: 'Edit and resend this message' }));
    const box = screen.getByRole('textbox', { name: 'Edit your message' });
    await user.type(box, '{Shift>}{Enter}{/Shift}more');
    expect(onEditResend).not.toHaveBeenCalled();
    await user.type(box, '{Enter}');
    expect(onEditResend).toHaveBeenCalledWith('Plan my week\nmore');

    await user.click(screen.getByRole('button', { name: 'Edit and resend this message' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit your message' }), '{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    expect(onEditResend).toHaveBeenCalledTimes(1);
  });

  it('disables editing while busy', () => {
    render(<Harness message={question} onEditResend={vi.fn()} busy />);
    expect(isDisabled(screen.getByRole('button', { name: 'Edit and resend this message' }))).toBe(true);
  });

  it('keeps the edit action, disabled, for a message that cannot be anchored', () => {
    render(<Harness message={question} onEditResend={vi.fn()} editDisabled />);
    expect(isDisabled(screen.getByRole('button', { name: 'Edit and resend this message' }))).toBe(true);
  });
});

describe('resource chips', () => {
  const addMilk = assistant([
    {
      type: 'tool-createTask',
      toolCallId: 't1',
      state: 'output-available',
      input: { title: 'Milk' },
      output: { taskId: 'tsk_1', spaceId: 'spc_1', title: 'Milk' },
    },
    { type: 'text', text: 'Added milk to the grocery list.' },
  ] as UIMessage['parts']);

  it('shows a chip under the reply that opens the created task in its space', async () => {
    window.history.replaceState(null, '', '/c/c1');
    render(<Harness message={addMilk} />);
    await userEvent.click(screen.getByRole('button', { name: /Milk/ }));
    expect(window.location.pathname).toBe('/spaces/spc_1/tasks');
    // The reply's actions still render, now under the chip.
    expect(screen.getByRole('button', { name: 'Copy response' })).toBeTruthy();
  });

  it('shows no chip when the tool failed', () => {
    const failed = assistant([
      {
        type: 'tool-createTask',
        toolCallId: 't1',
        state: 'output-error',
        input: { title: 'Milk' },
        errorText: 'Could not add that',
      },
      { type: 'text', text: 'I could not add milk.' },
    ] as UIMessage['parts']);
    render(<Harness message={failed} />);
    expect(screen.queryByRole('button', { name: /Milk/ })).toBeNull();
    expect(screen.queryByText('Milk')).toBeNull();
  });

  it('renders the chip as unavailable once the reader has left the space', async () => {
    spacesHook.value = { state: 'ready', spaces: [{ id: 'spc_2' }] };
    window.history.replaceState(null, '', '/c/c1');
    render(<Harness message={addMilk} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Milk/ })).toBeNull();
    await userEvent.click(screen.getByText('Milk'));
    expect(window.location.pathname).toBe('/c/c1');
  });

  it('keeps the chip live while the reader is still in the space', () => {
    spacesHook.value = { state: 'ready', spaces: [{ id: 'spc_1' }] };
    render(<Harness message={addMilk} />);
    expect(screen.getByRole('button', { name: /Milk/ })).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });
});

// The exact outputs create_task (productivity tools) and create_note (voice
// tools) return in web chat, as pinned by the api tests for #517.
describe('resource chips from the real tool outputs', () => {
  it('links a created task and a created note from what the tools actually return', async () => {
    const message = assistant([
      {
        type: 'tool-create_task',
        toolCallId: 'call_task',
        state: 'output-available',
        input: { title: 'Milk' },
        output: { ok: true, taskId: '7c1e2f0a-task', spaceId: 'spc_private', title: 'Milk' },
      },
      {
        type: 'tool-create_note',
        toolCallId: 'call_note',
        state: 'output-available',
        input: { title: 'Groceries', text: 'milk' },
        output: { ok: true, say: 'Saved a note called Groceries.', noteId: 'n-1', spaceId: 'spc_private', title: 'Groceries' },
      },
      {
        type: 'tool-list_tasks',
        toolCallId: 'call_list',
        state: 'output-available',
        input: {},
        output: { ok: true, items: [{ id: 't-2', title: 'Eggs', status: 'open', due: null }] },
      },
      { type: 'text', text: 'Added milk and saved a note.' },
    ] as UIMessage['parts']);
    window.history.replaceState(null, '', '/c/c1');
    render(<Harness message={message} />);
    expect(screen.queryByRole('button', { name: /Eggs/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Milk/ }));
    expect(window.location.pathname).toBe('/spaces/spc_private/tasks');
    await userEvent.click(screen.getByRole('button', { name: /Groceries/ }));
    expect(window.location.pathname).toBe('/spaces/spc_private/notes');
  });

  it('shows no chip for a tool that answered ok: false', () => {
    const message = assistant([
      {
        type: 'tool-create_task',
        toolCallId: 'call_task',
        state: 'output-available',
        input: { title: 'Milk' },
        output: { ok: false, reason: 'not a member of the space' },
      },
    ] as UIMessage['parts']);
    render(<Harness message={message} />);
    expect(screen.queryByRole('button', { name: /Milk/ })).toBeNull();
  });
});

describe('avatar gutter', () => {
  const shell = { isMobile: false, isMobileNavOpen: false, toggleMobileNav() {}, openMobileNav() {}, closeMobileNav() {}, isMobileNavEnabled: false, hasAutoToggle: true };
  const avatar = (): HTMLElement | null => screen.queryByRole('img', { name: BRAND.assistantName });

  it('keeps the assistant avatar on desktop', () => {
    render(<Harness message={reply} />);
    expect(avatar()).not.toBeNull();
  });

  it('starts the assistant text at the gutter on a phone, with no avatar column', () => {
    render(
      <AppShellMobileContext value={{ ...shell, isMobile: true }}>
        <Harness message={reply} />
      </AppShellMobileContext>,
    );
    expect(screen.getByText('Here is your week.')).toBeTruthy();
    expect(avatar()).toBeNull();
  });
});

describe('message actions on a phone', () => {
  const shell = { isMobile: true, isMobileNavOpen: false, toggleMobileNav() {}, openMobileNav() {}, closeMobileNav() {}, isMobileNavEnabled: false, hasAutoToggle: true };
  // jsdom has no modal <dialog>; the Astryx bottom sheet calls showModal() on open.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void { this.removeAttribute('open'); };
  });
  const onPhone = (ui: ReactElement): ReactElement => (
    <AppShellMobileContext value={shell}>{ui}</AppShellMobileContext>
  );

  it('hides the per-message action row and offers the actions from a long-press menu', async () => {
    render(onPhone(<Harness message={question} onEditResend={vi.fn()} onDeleteFrom={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'Edit and resend this message' })).toBeNull();
    fireEvent.contextMenu(screen.getByText('Plan my week'));
    expect(await screen.findByRole('button', { name: /Edit/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete from here/ })).toBeTruthy();
  });

  it('hides copy and regenerate under a reply and offers them from its menu', async () => {
    render(onPhone(<Harness message={reply} onRegenerate={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate reply' })).toBeNull();
    fireEvent.contextMenu(screen.getByText('Here is your week.'));
    expect(await screen.findByRole('button', { name: /Copy/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeTruthy();
  });

  it('offers a visible More actions button on a user message that opens Edit and Delete', async () => {
    render(onPhone(<Harness message={question} showMoreActions onEditResend={vi.fn()} onDeleteFrom={vi.fn()} />));
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Delete from here/ })).toBeTruthy();
  });

  it('offers a visible More actions button on a reply that opens Copy and Regenerate', async () => {
    render(onPhone(<Harness message={reply} showMoreActions onRegenerate={vi.fn()} />));
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Copy/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Regenerate/ })).toBeTruthy();
  });

  it('adds no More actions button unless the message asks for one', () => {
    render(onPhone(<Harness message={reply} onRegenerate={vi.fn()} />));
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('reports a copy from the phone menu so a Copied toast can show', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onCopied = vi.fn();
    render(onPhone(<Harness message={reply} showMoreActions onCopied={onCopied} />));
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: /Copy/ }));
    await waitFor(() => expect(onCopied).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('keeps the action rows on desktop', () => {
    render(<Harness message={reply} onRegenerate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Copy response' })).toBeTruthy();
  });
});
