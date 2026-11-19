import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { PAGE_WIDTH } from '@/app/page-width';
import { groupChatPath, navigateTo } from '@/app/routes';
import { useSession } from '@/lib/auth/use-session';
import { SignIn } from '@/features/account/sign-in';
import { groupRequest, refreshGroupChats, type GroupChat, type GroupInvitation } from './group-chats-api';

export function GroupChatInvitePage({ token }: { token: string }): ReactElement {
  const { status } = useSession();
  const [preview, setPreview] = useState<GroupInvitation | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setPreview(null); setError(false);
    if (status !== 'signed-in') return;
    void groupRequest<GroupInvitation>(`/invitations/${encodeURIComponent(token)}`)
      .then((value) => { if (!disposed) setPreview(value); })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [token, status, attempt]);
  const join = async (): Promise<void> => {
    setBusy(true); setError(false);
    try {
      const { chat } = await groupRequest<{ chat: GroupChat }>(`/invitations/${encodeURIComponent(token)}/accept`, 'POST');
      refreshGroupChats(); navigateTo(groupChatPath(chat.id));
    } catch { setError(true); } finally { setBusy(false); }
  };
  if (status === 'signed-out') return <SignIn unavailable={null} />;
  return <Layout height="fill" contentWidth={PAGE_WIDTH} padding={6} content={<LayoutContent>
    <VStack gap={4}>
      <Heading level={1}>{preview?.title ?? 'Join a chat'}</Heading>
      {preview && <>
        <Text>{preview.inviter_name} invited you to chat with Bob.</Text>
        <Text>When you join, you can read the chat's earlier messages. Other participants will see your name and messages.</Text>
        <Text type="supporting">This invitation expires {new Date(preview.expires_at).toLocaleDateString()}.</Text>
        <Button label="Join chat" variant="primary" isLoading={busy} onClick={() => void join()} />
      </>}
      {!preview && !error && <Text>Loading your invitation…</Text>}
      {error && <><Text role="alert">This invitation isn't available right now. It may have expired or been disabled. Ask for a fresh link or try again.</Text>
        <Button label="Try again" onClick={() => setAttempt((value) => value + 1)} /></>}
    </VStack>
  </LayoutContent>} />;
}
