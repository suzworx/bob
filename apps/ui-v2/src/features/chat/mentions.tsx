import type { MentionMember } from '@/features/chat/use-mention-picker';
import { BRAND } from '@/lib/brand';
import {
  createStaticSource,
  type SearchableItem,
  TypeaheadItem,
} from '@astryxdesign/core/Typeahead';
import type { ChatComposerTrigger, ChatComposerToken } from '@astryxdesign/core/Chat';

export function mentionName(member: MentionMember): string {
  if (isAssistant(member)) return BRAND.assistantName;
  if (member.display_name && member.display_name.trim() !== '') {
    return member.display_name;
  }
  return member.handle;
}

function isAssistant(member: MentionMember): boolean {
  return member.user_id === 'bob' && member.role === 'assistant' && member.handle === 'bob';
}

export function mentionDescription(member: MentionMember): string {
  if (member.reference) return member.reference.description;
  return isAssistant(member) ? 'Ask Bob' : `@${member.handle}`;
}

export function mentionToken(member: MentionMember): ChatComposerToken {
  return {
    value: member.reference?.value ?? `@${member.handle}`,
    label: mentionName(member),
    variant: 'blue',
  };
}

export function buildMentionTrigger(members: MentionMember[]): ChatComposerTrigger {
  interface MentionSearchableItem extends SearchableItem {
    auxiliaryData?: { handle: string; keywords: string[] };
  }

  const items: MentionSearchableItem[] = members.map((member) => ({
    id: member.handle,
    label: mentionName(member),
    auxiliaryData: { handle: member.handle, keywords: isAssistant(member) ? ['bob', '@bob', 'assistant', 'bob'] : member.reference?.keywords ?? [member.handle] },
  }));

  const searchSource = createStaticSource(items, {
    keywords: (item: MentionSearchableItem) => item.auxiliaryData?.keywords ?? [],
  });

  return {
    character: '@',
    searchSource,
    renderItem: (item: SearchableItem) => {
      const mentionItem = item as MentionSearchableItem;
      const member = members.find((candidate) => candidate.handle === mentionItem.id);
      return (
        <TypeaheadItem
          item={item}
          description={member ? mentionDescription(member) : `@${mentionItem.auxiliaryData?.handle}`}
        />
      );
    },
    onSelect: (item: SearchableItem) => {
      const mentionItem = item as MentionSearchableItem;
      const member = members.find((m) => m.handle === mentionItem.id);
      if (member) {
        return mentionToken(member);
      }
      return `@${mentionItem.id}`;
    },
    deserialize: (value: string) => {
      if (!value.startsWith('@')) return null;
      const handle = value.slice(1);
      const member = members.find(
        (m) => m.reference ? m.reference.value === value : m.handle.toLowerCase() === handle.toLowerCase(),
      );
      if (member) {
        return mentionToken(member);
      }
      return null;
    },
    menuLabel: 'Mention Bob, people or features',
    emptySearchResultsText: 'No matches. Try Bob, a feature or a connected account.',
  };
}

export function normalizeComposerText(value: string): string {
  // Replace non-breaking spaces (U+00A0) with plain spaces
  const normalized = value.replace(/\u00A0/g, ' ');
  // Trim the ends
  return normalized.trim();
}

// Mirrors apps/api/src/spaces/mentions.ts closely enough to decide whether to ask Bob:
// `@bob` (any case) not preceded by a word character or `\`, not continued by another
// handle character (`@bob.bob` is a person), and not inside backtick code.
const BOB_ADDRESS = /(^|[^A-Za-z0-9_\\])@bob(?![A-Za-z0-9_]|[.-]+[A-Za-z0-9_])/i;
export function addressesBob(body: string): boolean {
  const withoutCode = body.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`]*`/g, ' ');
  return BOB_ADDRESS.test(withoutCode);
}
