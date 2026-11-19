import type { ReactElement, ReactNode, RefObject } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { usePagePadding } from '@/app/page-width';
import { ChatSurface, type ChatAppBinding } from '@/features/chat/chat-surface';
import { ThreadReader } from '@/features/spaces/thread-reader';
import type { Space } from '@/features/spaces/use-spaces';
import type { BobApp } from './bob-apps-api';
import { useMarketingConversation } from './use-marketing-conversation';
import { useAppConversation } from './use-app-conversation';

type ConversationProps = { app: BobApp; focusRef: RefObject<(() => void) | null>; onChanged: () => void };
const TRANSCRIPT_HEIGHT = '30dvh';
const PLACEHOLDER = 'Ask Bob to change this app…';
function appBinding(app: BobApp): ChatAppBinding {
  return { installationId: app.installationId, mode: 'refine' };
}
function PrivateAppConversation({ app, userId, focusRef, onChanged }: ConversationProps & { userId: string }): ReactElement {
  const conversation = useMarketingConversation(userId, app.installationId, 'app');
  if (conversation.loading) return <Text role="status">Opening your app conversation…</Text>;
  if (conversation.error) return <Banner status="error" title="Couldn't open your app conversation" endContent={<Button label="Retry app conversation" onClick={conversation.retry} />} />;
  return <ChatSurface embedded embeddedHeight={TRANSCRIPT_HEIGHT} conversationId={conversation.id} conversationTitle={conversation.title}
    initialMessages={conversation.recent} earlierMessages={conversation.earlier} userName={null} draftKey={conversation.draftKey}
    placeholder={PLACEHOLDER} appBinding={appBinding(app)} composerFocusRef={focusRef}
    onConversationCreated={conversation.created} onConversationTouched={onChanged} />;
}
function SharedAppConversation({ app, space, focusRef, onChanged }: ConversationProps & { space: Space }): ReactElement {
  const conversation = useAppConversation(app.id, space.id);
  if (conversation.error) return <Banner status="error" title="Couldn't open the app conversation. Your saved work is still here." />;
  if (!conversation.thread) return <Text role="status">Opening the shared app conversation…</Text>;
  return <ThreadReader space={space} thread={conversation.thread} threads={conversation.threads} appBinding={appBinding(app)}
    placeholder={PLACEHOLDER} embeddedHeight={TRANSCRIPT_HEIGHT} focusRef={focusRef} onInvocationComplete={onChanged} />;
}
/** The app is the artifact; audience configures the existing conversation below it. */
export function AppWorkspace({ app, userId, space, focusRef, onChanged, children }: ConversationProps & { userId: string; space?: Space; children: ReactNode }): ReactElement {
  const padding = usePagePadding();
  if ((app.spaceId ?? null) !== (space?.id ?? null)) return <Banner status="error" title="That app isn't available here." />;
  const conversation = app.spaceId && space
    ? <SharedAppConversation key={`${userId}:${app.id}:${space.id}`} app={app} space={space} focusRef={focusRef} onChanged={onChanged} />
    : <PrivateAppConversation key={`${userId}:${app.id}`} app={app} userId={userId} focusRef={focusRef} onChanged={onChanged} />;
  return <Layout height="fill" padding={padding} content={<LayoutContent label="App content">{children}</LayoutContent>} footer={<LayoutFooter>{conversation}</LayoutFooter>} />;
}
