import { BRAND } from '@/lib/brand';
import type { User } from '@supabase/supabase-js';
import type { SpaceMember } from '../features/spaces/use-spaces';

// The name the account chose, or null. NEVER derives a name from the email:
// an email address is not a name, and showing one as a greeting reads as a bug.
export function accountDisplayName(user: User | null | undefined): string | null {
  const metadata = user?.user_metadata;
  for (const key of ['name', 'full_name']) {
    const value: unknown = metadata?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

// What to call a space member in a list or beside a message. Falls back through
// the derived @handle and finally to a neutral word -- never a raw user id.
export function memberDisplayName(
  members: readonly SpaceMember[],
  userId: string | null,
): string {
  if (userId === null) return BRAND.assistantName;
  const member = members.find((candidate) => candidate.user_id === userId);
  if (!member) return 'Someone';
  if (member.display_name && member.display_name.trim() !== '') return member.display_name.trim();
  if (member.handle && member.handle.trim() !== '') return `@${member.handle}`;
  return 'Someone';
}
