import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { Users } from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { PAGE_WIDTH, PageTitle } from '@/app/page-width';
import { GroupThreadContent } from '@/features/spaces/group-thread-content';
import { groupRequest, type GroupChat } from './group-chats-api';
import { GroupChatControls } from './group-chat-controls';
import { useGroupChatRefresh } from './use-group-chat-refresh';

export function GroupChatPage({ chatId }: { chatId: string }): ReactElement {
  const [chat, setChat] = useState<GroupChat | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestEpoch = useRef(0);
  const refresh = useCallback((): void => setRevision((value) => value + 1), []);
  useGroupChatRefresh((id, deleted) => {
    if (id && id !== chatId) return;
    if (deleted) { requestEpoch.current += 1; setChat(null); setFailed(true); }
    else refresh();
  });
  useEffect(() => {
    let disposed = false;
    const epoch = ++requestEpoch.current;
    setFailed(false);
    void groupRequest<{ chat: GroupChat }>(`/${encodeURIComponent(chatId)}`)
      .then((result) => { if (!disposed && epoch === requestEpoch.current) setChat(result.chat); })
      .catch(() => { if (!disposed && epoch === requestEpoch.current) { setChat(null); setFailed(true); } });
    return () => { disposed = true; };
  }, [chatId, revision]);
  const visibleChat = chat?.id === chatId ? chat : null;
  const { isMobile } = useAppShellMobile();
  const [peopleOpen, setPeopleOpen] = useState(false);
  const title = visibleChat?.title ?? 'Chat';
  // On a phone the shell's top bar is the one header: People sits on the composer's top row.
  const peopleAction = isMobile ? <Button label="People" variant="ghost" size="sm" icon={<Icon icon={Users} size="sm" />} isIconOnly onClick={() => setPeopleOpen(true)} /> : undefined;
  const controls = visibleChat && <GroupChatControls key={visibleChat.id} chat={visibleChat} onChanged={refresh} open={peopleOpen} onOpenChange={setPeopleOpen} showButton={!isMobile} />;
  return <Layout height="fill" contentWidth={PAGE_WIDTH}
    header={isMobile ? undefined : <LayoutHeader hasDivider><HStack gap={2} hAlign="between" vAlign="center" wrap="wrap" paddingInline={3} paddingBlock={1}>
      <PageTitle>{title}</PageTitle>
      {controls}
    </HStack></LayoutHeader>}
    content={visibleChat ? <>
      {isMobile && <PageTitle>{title}</PageTitle>}
      {isMobile && controls}
      <GroupThreadContent chatId={visibleChat.id} spaceId={visibleChat.space_id} phoneActions={peopleAction} />
    </> : <LayoutContent>{isMobile && <PageTitle>{title}</PageTitle>}<VStack gap={3}>
      <Text>{failed ? "This chat isn't available. You may need a fresh invitation to join." : 'Loading your chat…'}</Text>
      {failed && <Button label="Try again" onClick={refresh} />}
    </VStack></LayoutContent>} />;
}
