import { createRef, useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppWorkspace } from './app-workspace';
import { starterApp } from './app-starters';
import type { BobApp } from './bob-apps-api';
import type { Space } from '@/features/spaces/use-spaces';
import { useMarketingConversation } from './use-marketing-conversation';
import { useAppConversation } from './use-app-conversation';

const chat = vi.hoisted(() => ({ binding: null as unknown, touched: () => {}, draftKey: '', mounts: 0 }));
vi.mock('./use-marketing-conversation', () => ({ useMarketingConversation: vi.fn((userId: string, installationId: string) => ({ id: null, recent: [], earlier: [], draftKey: `app:${userId}:${installationId}:new`, loading: false, error: false, created: vi.fn() })) }));
vi.mock('./use-app-conversation', () => ({ useAppConversation: vi.fn(() => ({ thread: { id: 'canonical-thread' }, threads: {} })) }));
type ChatProps = { appBinding: unknown; composerFocusRef?: { current: (() => void) | null }; focusRef?: { current: (() => void) | null }; draftKey?: string; onConversationTouched?: () => void; onInvocationComplete?: () => void };
function Conversation(props: ChatProps) {
  const [text, setText] = useState(() => { chat.mounts += 1; return ''; });
  const input = useRef<HTMLTextAreaElement>(null);
  const focus = props.composerFocusRef ?? props.focusRef;
  if (focus) focus.current = () => input.current?.focus();
  chat.binding = props.appBinding; chat.draftKey = props.draftKey ?? ''; chat.touched = props.onConversationTouched ?? props.onInvocationComplete ?? (() => {});
  return <textarea ref={input} role="combobox" aria-label="Message" value={text} onChange={(event) => setText(event.target.value)} />;
}
vi.mock('@/features/chat/chat-surface', () => ({ ChatSurface: (props: ChatProps) => <Conversation {...props} /> }));
vi.mock('@/features/spaces/thread-reader', () => ({ ThreadReader: (props: ChatProps) => <Conversation {...props} /> }));
const app: BobApp = { id: 'checklist-app', installationId: 'installation', spaceId: null, canManage: true, revision: 2, lifecycle: 'active', createdAt: 1, updatedAt: 1, definition: starterApp('checklist'), state: {}, metrics: {}, pendingDefinition: null, canUndo: false };
const space: Space = { id: 'space', name: 'Team', kind: 'group', role: 'member', membership_revision: 1, created_at: 1, updated_at: 1, members: [] };
beforeEach(() => { vi.clearAllMocks(); chat.mounts = 0; });
it('binds a private app conversation without Marketing campaign fields and keeps composer text on data refresh', () => {
  const focus = createRef<(() => void) | null>();
  const changed = vi.fn();
  const { rerender } = render(<AppWorkspace app={app} userId="member" focusRef={focus} onChanged={changed}><p>Saved app records</p></AppWorkspace>);
  expect(useMarketingConversation).toHaveBeenCalledWith('member', app.installationId, 'app');
  expect(useAppConversation).not.toHaveBeenCalled();
  expect(chat.binding).toEqual({ installationId: app.installationId, mode: 'refine' });
  expect(chat.draftKey).toBe('app:member:installation:new');
  const composer = screen.getByRole('combobox', { name: 'Message' });
  fireEvent.change(composer, { target: { value: 'My unsent app correction' } });
  rerender(<AppWorkspace app={{ ...app, revision: 3 }} userId="member" focusRef={focus} onChanged={changed}><p>Saved app records</p></AppWorkspace>);
  act(() => focus.current?.());
  expect(document.activeElement).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe('My unsent app correction');
  expect(chat.mounts).toBe(1);
  act(() => chat.touched());
  expect(changed).toHaveBeenCalledOnce();
});
it('configures the canonical shared thread without opening a private conversation', () => {
  const focus = createRef<(() => void) | null>();
  render(<AppWorkspace app={{ ...app, spaceId: space.id, canManage: false }} userId="member" space={space} focusRef={focus} onChanged={vi.fn()}><p>Team app records</p></AppWorkspace>);
  expect(useAppConversation).toHaveBeenCalledWith(app.id, space.id);
  expect(useMarketingConversation).not.toHaveBeenCalled();
  expect(chat.binding).toEqual({ installationId: app.installationId, mode: 'refine' });
  expect(screen.getAllByRole('combobox', { name: 'Message' })).toHaveLength(1);
  expect(screen.getByText('Team app records')).toBeTruthy();
});
it('changes composer identity when switching apps instead of carrying an old app target or unsent draft into another', () => {
  const focus = createRef<(() => void) | null>();
  const { rerender } = render(<AppWorkspace app={app} userId="member" focusRef={focus} onChanged={vi.fn()}><p>First app records</p></AppWorkspace>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Message' }), { target: { value: 'Only for the first app' } });
  rerender(<AppWorkspace app={{ ...app, id: 'another-app', installationId: 'another-installation' }} userId="member" focusRef={focus} onChanged={vi.fn()}><p>Other app records</p></AppWorkspace>);
  expect(chat.binding).toEqual({ installationId: 'another-installation', mode: 'refine' });
  expect(chat.draftKey).toBe('app:member:another-installation:new');
  expect((screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  expect(chat.mounts).toBe(2);
});
it.each(['another-space', null])('does not open a conversation for an app from the wrong audience %s', (spaceId) => {
  render(<AppWorkspace app={{ ...app, spaceId }} userId="member" space={space} focusRef={createRef()} onChanged={vi.fn()}><p>Hidden records</p></AppWorkspace>);
  expect(screen.getByText("That app isn't available here.")).toBeTruthy();
  expect(screen.queryByText('Hidden records')).toBeNull();
  expect(useMarketingConversation).not.toHaveBeenCalled();
  expect(useAppConversation).not.toHaveBeenCalled();
});
