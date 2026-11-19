import { useEffect, useState } from 'react';
import type { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { moveDraft } from '@/features/chat/drafts';
import { splitWindow, toUIMessages } from '@/features/chat/conversation-messages';
import type { ConversationDetail } from '@/features/chat/use-conversations';

function pointer(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function savePointer(key: string, id: string | null): void {
  try { if (id) sessionStorage.setItem(key, id); else sessionStorage.removeItem(key); } catch { /* Tab storage is optional. */ }
}
type Conversation = { id: string | null; messages: UIMessage[]; title?: string };

/** Only the opaque conversation pointer is stored in this tab; Chat owns the memory-only unsent draft. */
export function useMarketingConversation(userId: string, installationId: string, namespace: 'marketing' | 'app' = 'marketing') {
  const scope = `${namespace}:${userId}:${installationId}`;
  const pointerKey = `bob:${scope}:conversation`;
  const [conversation, setConversation] = useState<Conversation>(() => ({ id: pointer(pointerKey), messages: [] }));
  const [loading, setLoading] = useState(() => conversation.id !== null);
  const [error, setError] = useState(false);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const id = pointer(pointerKey);
    if (!id) return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    void fetchWithAuth(`/api/conversations/${encodeURIComponent(id)}`, { signal: controller.signal }).then(async (response) => {
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        moveDraft(`${scope}:${id}`, `${scope}:new`); savePointer(pointerKey, null);
        setConversation({ id: null, messages: [] }); setMissing(true); return;
      }
      if (!response.ok) throw new Error('conversation_unavailable');
      const detail = await response.json() as ConversationDetail;
      if (controller.signal.aborted) return;
      if (detail.id !== id) throw new Error('conversation_mismatch');
      setConversation({ id, title: detail.title, messages: toUIMessages(detail) });
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [pointerKey, retry, scope]);
  const created = (id: string, messages: UIMessage[]): void => {
    savePointer(pointerKey, id); moveDraft(`${scope}:new`, `${scope}:${id}`); setConversation({ id, messages });
  };
  return { ...conversation, ...splitWindow(conversation.messages), loading, error, missing, retry: () => setRetry((value) => value + 1), created, draftKey: `${scope}:${conversation.id ?? 'new'}` };
}
