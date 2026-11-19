import { useEffect, useState, type ReactElement } from 'react';
import type { UIMessage } from 'ai';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { ChatSurface } from '@/features/chat/chat-surface';
import { conversationPath } from '@/app/routes';
import { getDraft, moveDraft, setDraft } from '@/features/chat/drafts';
import { splitWindow, toUIMessages } from '@/features/chat/conversation-messages';
import type { ConversationDetail } from '@/features/chat/use-conversations';
import { fetchWithAuth } from '@/lib/auth/use-session';

// Only an opaque pointer is persisted in this tab. Messages remain in the
// ordinary owner-scoped conversation store; drafts use the shared memory cache.
function readPointer(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writePointer(key: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch { /* A storage-disabled browser can still chat for this visit. */ }
}

type Conversation = { id: string | null; messages: UIMessage[]; title?: string };

async function restoreConversation(id: string, signal: AbortSignal): Promise<Conversation | null> {
  const response = await fetchWithAuth(`/api/conversations/${encodeURIComponent(id)}`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('conversation_unavailable');
  const detail = await response.json() as ConversationDetail;
  if (detail.id !== id) throw new Error('conversation_mismatch');
  return { id, title: detail.title, messages: toUIMessages(detail) };
}

export function RoutineConversation({ userId, onTurnFinished, scope = 'routines', title = 'Ask Bob about routines', description = 'Describe what you would like ready. Bob can help choose the account and schedule.', placeholder = 'Ask Bob to create or change a routine', suggestedPrompt }: {
  userId: string; onTurnFinished: () => void; scope?: string; title?: string; description?: string; placeholder?: string; suggestedPrompt?: string;
}): ReactElement {
  const pointerKey = `bob:${scope}:conversation:${userId}`;
  const [conversation, setConversation] = useState<Conversation>(() => {
    const id = readPointer(pointerKey);
    const key = `${scope}:${userId}:${id ?? 'new'}`;
    if (suggestedPrompt && !getDraft(key)) setDraft(key, suggestedPrompt);
    return { id, messages: [] };
  });
  const [loading, setLoading] = useState(() => conversation.id !== null);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const id = readPointer(pointerKey);
    if (!id) return;
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    void restoreConversation(id, controller.signal)
      .then((restored) => {
        if (controller.signal.aborted) return;
        if (!restored) {
          writePointer(pointerKey, null);
          setConversation({ id: null, messages: [] }); setMissing(true);
          return;
        }
        setConversation(restored);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [pointerKey, retry]);

  const created = (id: string, messages: UIMessage[]): void => {
    writePointer(pointerKey, id);
    moveDraft(`${scope}:${userId}:new`, `${scope}:${userId}:${id}`);
    setConversation({ id, messages });
  };
  const startNew = (): void => {
    writePointer(pointerKey, null);
    setConversation({ id: null, messages: [] });
    setMissing(false); setGeneration((value) => value + 1);
  };
  const window = splitWindow(conversation.messages);
  return <VStack gap={3}>
    <Heading level={2}>{title}</Heading>
    <Text type="supporting">{description}</Text>
    {missing && <Banner status="info" title="That conversation is no longer here. You can start a fresh one." />}
    {loading && <Text role="status">Opening your conversation…</Text>}
    {failed && <Banner status="error" title="Couldn't open your routine conversation"
      endContent={<Button label="Retry conversation" onClick={() => setRetry((value) => value + 1)} />} />}
    {!loading && !failed && <ChatSurface key={generation} embedded
      conversationId={conversation.id} conversationTitle={conversation.title}
      initialMessages={window.recent} earlierMessages={window.earlier} userName={null}
      draftKey={`${scope}:${userId}:${conversation.id ?? 'new'}`} placeholder={placeholder}
      onConversationCreated={created} onConversationTouched={onTurnFinished} onBusyChange={setBusy} />}
    {conversation.id && !loading && !failed && <HStack gap={2} wrap="wrap">
      <Button label="New conversation" variant="ghost" size="sm" isDisabled={busy} onClick={startNew} />
      <Button label="Open full conversation" variant="ghost" size="sm" href={conversationPath(conversation.id)} />
    </HStack>}
  </VStack>;
}
