import type { UIMessage } from 'ai';
import type { ConversationDetail } from './use-conversations';

export const MESSAGE_WINDOW = 200;

// The stored `origin` and `createdAt` are on the wire but not in the hook's type.
type StoredMessage = ConversationDetail['messages'][number] & {
  origin?: 'web_text' | 'web_voice' | 'device';
  createdAt?: number;
};

// Each message shows its selected version, else the first. The message view's
// "via Cardputer" note reads `metadata.origin` and its time reads
// `metadata.createdAt`; each is absent when none was stored.
export function toUIMessages(detail: ConversationDetail): UIMessage[] {
  const mapped = (detail.messages as StoredMessage[]).map((message) => {
    const version = message.versions.find((candidate) => candidate.selected) ?? message.versions[0];
    return {
      id: message.id,
      role: message.role,
      parts: version?.parts ?? [],
      metadata: {
        ...(message.origin ? { origin: message.origin } : {}),
        ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
      },
    };
  });
  return mapped as unknown as UIMessage[];
}

// A conversation opens on its most recent window, as in v1; the older remainder
// goes to the surface, which loads it a page at a time.
export function splitWindow(all: UIMessage[]): { recent: UIMessage[]; earlier: UIMessage[] } {
  const cut = Math.max(all.length - MESSAGE_WINDOW, 0);
  return { recent: all.slice(cut), earlier: all.slice(0, cut) };
}

