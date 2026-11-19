import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { groupChatInvitePath, navigateTo } from '@/app/routes';
import { fetchWithAuth, useSession } from '@/lib/auth/use-session';
import { groupRequest, refreshGroupChats, type GroupChat, type GroupMember } from './group-chats-api';
import { useGroupChatRefresh } from './use-group-chat-refresh';

/** The People dialog. A page may own `open` (on a phone it opens from the composer's top row and hides the button). */
export function GroupChatControls({ chat, onChanged, open: controlledOpen, onOpenChange, showButton = true }: {
  chat: GroupChat; onChanged: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; showButton?: boolean;
}): ReactElement {
  const { session } = useSession();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<GroupMember | null>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const validEmail = email.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const creator = chat.role === 'owner';
  const loadMembers = async (): Promise<void> => {
    const result = await groupRequest<{ members: GroupMember[] }>(`/${encodeURIComponent(chat.id)}/members`);
    setMembers(result.members);
  };
  useGroupChatRefresh((id) => {
    if (!open || (id && id !== chat.id)) return;
    void loadMembers().catch(() => { setMembers([]); setNotice("Couldn't refresh participants. Close this dialog and try again."); });
  });
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void groupRequest<{ members: GroupMember[] }>(`/${encodeURIComponent(chat.id)}/members`)
      .then((result) => { if (!disposed) setMembers(result.members); })
      .catch(() => { if (!disposed) setNotice("Couldn't load participants. Close this dialog and try again."); });
    return () => { disposed = true; };
  }, [open, chat.id]);
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setNotice(null);
    try { await action(); refreshGroupChats(); onChanged(); }
    catch { setNotice("Couldn't finish that. Please try again."); }
    finally { setBusy(false); }
  };
  const createLink = async (): Promise<void> => {
    const result = await groupRequest<{ token: string }>(`/${encodeURIComponent(chat.id)}/links`, 'POST');
    setLink(new URL(groupChatInvitePath(result.token), window.location.origin).href);
  };
  const remove = async (member: GroupMember): Promise<void> => {
    await groupRequest<void>(`/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(member.user_id)}`, 'DELETE');
    setConfirm(null);
    if (member.user_id === session?.user.id) navigateTo('/chat');
    else await loadMembers();
  };
  const rename = async (): Promise<void> => {
    const response = await fetchWithAuth(`/api/threads/${encodeURIComponent(chat.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() }),
    });
    if (!response.ok) throw new Error('rename_failed');
    setNotice('Chat name saved.');
  };
  const sendInvitation = async (): Promise<void> => {
    if (busy || !validEmail) return;
    setBusy(true); setSending(true); setNotice(null);
    try {
      const result = await groupRequest<{ sent: boolean }>(`/${encodeURIComponent(chat.id)}/invitations`, 'POST', { email: email.trim() });
      if (result.sent !== true) throw new Error('email_send_failed');
      setEmail('');
      setNotice('Invitation sent. They can choose whether to join.');
    } catch { setNotice("We couldn't send the invitation. Check the address and try again."); }
    finally { setSending(false); setBusy(false); }
  };
  return <>
    {showButton && <Button label="People" variant="ghost" size="sm" onClick={() => setOpen(true)} />}
    <Dialog isOpen={open} onOpenChange={(value) => { if (!busy) setOpen(value); }} purpose="form">
      <Layout height="auto" header={<DialogHeader title="People" onOpenChange={(value) => { if (!busy) setOpen(value); }} />}
        content={<LayoutContent><VStack gap={4}>
          {creator && <VStack gap={2}>
            <TextInput label="Chat name" value={title} onChange={setTitle} />
            <Button label="Save name" isDisabled={busy || !title.trim() || title.trim().length > 120} onClick={() => void act(rename)} />
          </VStack>}
          <VStack gap={2}>
            <Text type="label">Invite people</Text>
            <Text>Anyone with a working link can join and read the chat's earlier messages. Nothing is sent automatically.</Text>
            <TextInput label="Email address" type="email" value={email} onChange={setEmail} isDisabled={busy} />
            <Button label="Send invitation" isLoading={sending} isDisabled={busy || !validEmail} onClick={() => void sendInvitation()} />
            {link && <TextInput label="Invitation link" value={link} isReadOnly />}
            <HStack gap={2} wrap="wrap">
              <Button label={link ? 'Create another link' : 'Create invite link'} isDisabled={busy} onClick={() => void act(createLink)} />
              {link && <Button label="Copy link" isDisabled={busy} onClick={() => void act(async () => {
                await navigator.clipboard.writeText(link); setNotice('Link copied. Share it with people you want to invite.');
              })} />}
              {creator && <Button label="Disable invite links" isDisabled={busy} onClick={() => void act(async () => {
                await groupRequest<void>(`/${encodeURIComponent(chat.id)}/links`, 'DELETE'); setLink(null); setNotice('All invite links are disabled. You can create a fresh one.');
              })} />}
            </HStack>
          </VStack>
          <VStack gap={2}>
            <Text type="label">Participants</Text>
            {members.map((member) => <HStack key={member.user_id} gap={2} hAlign="between" vAlign="center">
              <Text>{member.display_name || 'Participant'}{member.role === 'owner' ? ' (owner)' : ''}</Text>
              {(creator || member.user_id === session?.user.id) && <Button
                label={member.user_id === session?.user.id ? 'Leave chat' : `Remove ${member.display_name || 'participant'}`}
                variant="ghost" size="sm" isDisabled={busy} onClick={() => setConfirm(member)} />}
            </HStack>)}
          </VStack>
          {confirm && <VStack gap={2}>
            <Text>{confirm.user_id === session?.user.id
              ? 'Leave this chat? You will need a fresh invitation to return. If you own it, ownership passes to the longest-standing participant; an empty chat closes.'
              : 'Remove this participant? They will lose access and need a fresh invitation to return.'}</Text>
            <HStack gap={2}><Button label="Keep participant" isDisabled={busy} onClick={() => setConfirm(null)} />
              <Button label="Confirm departure" variant="destructive" isLoading={busy} onClick={() => void act(() => remove(confirm))} /></HStack>
          </VStack>}
          {notice && <Text role="status">{notice}</Text>}
        </VStack></LayoutContent>} />
    </Dialog>
  </>;
}
