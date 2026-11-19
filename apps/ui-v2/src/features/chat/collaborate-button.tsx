import { useRef, useState, type ReactElement } from 'react';
import { Users } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { groupChatPath, navigateTo } from '@/app/routes';
import { groupRequest, refreshGroupChats, type GroupChat } from './group-chats-api';

// The "Add people" dialog, controlled so a button (desktop header) or a phone
// composer top-row button can open it.
export function CollaborateDialog({
  conversationId,
  isOpen,
  onOpenChange,
}: {
  conversationId?: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState(false);
  const requestId = useRef<string | null>(null);
  const create = async (textOnly = false): Promise<void> => {
    setBusy(true); setError(false);
    requestId.current ??= crypto.randomUUID();
    try {
      const { chat } = await groupRequest<{ chat: GroupChat }>('', 'POST', {
        request_id: requestId.current,
        ...(conversationId ? { source_conversation_id: conversationId } : {}),
        ...(textOnly ? { text_only: true } : {}),
      });
      refreshGroupChats();
      onOpenChange(false);
      navigateTo(groupChatPath(chat.id));
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'unsupported_history') setUnsupported(true);
      else setError(true);
    } finally { setBusy(false); }
  };
  const changeOpen = (next: boolean): void => { if (!busy) onOpenChange(next); };
  return (
    <Dialog isOpen={isOpen} onOpenChange={changeOpen} purpose="form">
      <Layout height="auto" header={<DialogHeader title="Add people" onOpenChange={changeOpen} />}
        content={<LayoutContent><VStack gap={4}>
          <Text>{conversationId
            ? 'Create a copy to chat with other people. Everyone who joins can read the copied history, including personal details in replies. Your original stays private and continues independently.'
            : 'Start a chat with Bob and other people. Invite them with a link after you create it.'}</Text>
          {unsupported && <Text>Some messages contain attachments or other content that cannot be shared yet. You can copy text only; attachments and tool details will be left out.</Text>}
          {error && <Text role="alert">We couldn't create the chat. Please try again.</Text>}
        </VStack></LayoutContent>}
        footer={<LayoutFooter><HStack gap={2} hAlign="end">
          <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => changeOpen(false)} />
          <Button label={unsupported ? 'Copy text only' : 'Create chat'} variant="primary" isLoading={busy} onClick={() => void create(unsupported)} />
        </HStack></LayoutFooter>} />
    </Dialog>
  );
}

export function CollaborateButton({ conversationId }: { conversationId?: string | null }): ReactElement {
  const isNarrow = useAppShellMobile().isMobile;
  const [open, setOpen] = useState(false);
  return <>
    <Button label="Add people" tooltip="Add people" isIconOnly={isNarrow} icon={<Icon icon={Users} size="sm" />} variant="ghost" size="sm" onClick={() => setOpen(true)} />
    <CollaborateDialog conversationId={conversationId} isOpen={open} onOpenChange={setOpen} />
  </>;
}
