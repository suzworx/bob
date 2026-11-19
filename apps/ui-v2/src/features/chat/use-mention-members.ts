import { useMemo } from 'react';
import type { MentionMember } from '@/features/chat/use-mention-picker';
import { useSpaces } from '@/features/spaces/use-spaces';
import { useIntegrationMentions } from './use-platform-mentions';
import { platformMentions } from './platform-mentions';

// Every member the reader can see across their spaces, for @mention pickers
// and for turning stored @handles back into chips. Read straight off the
// spaces SpacesProvider already loaded: v1's composer-mentions hook would also
// mount useMembers (invitation plumbing this app does not use), which adds
// member requests of its own.
export function useMentionMembers(conversationId?: string): MentionMember[] {
  const { spaces } = useSpaces();
  const integrations = useIntegrationMentions(true, conversationId);
  return useMemo(() => {
    const byUser = new Map<string, MentionMember>();
    for (const space of spaces) {
      for (const member of space.members) {
        if (byUser.has(member.user_id)) continue;
        byUser.set(member.user_id, {
          user_id: member.user_id,
          role: member.role,
          display_name: member.display_name,
          handle: member.handle,
          email: member.email,
        });
      }
    }
    return platformMentions([...byUser.values(), ...integrations]);
  }, [spaces, integrations]);
}
