import type { AppRoute } from '@/app/routes';
import type { GoogleAccount } from '@/features/integrations/google-accounts-api';
import type { MentionMember } from './use-mention-picker';
import { BRAND } from '@/lib/brand';

const FEATURES = [
  ['Chat', '/', 'chat'], ['Spaces', '/spaces', 'spaces'],
  ['Today', '/today', 'today'], ['Calendar', '/calendar', 'calendar'],
  ['Memory', '/memory', 'memory'], ['Devices', '/devices', 'devices'],
  ['Settings', '/settings', 'settings'], ['Integrations', '/integrations', 'integrations'],
  ['Insights', '/insights', 'insights'], ['Routines', '/routines', 'routines'],
  ['Timeline', '/timeline', 'timeline'], ['Tools', '/tools', 'tools'],
  ['Tasks', '/today', 'today'], ['Reminders', '/today', 'today'], ['Timers', '/today', 'today'],
  ['Notes', '/spaces', 'spaces'], ['Voice', '/', 'chat'],
  ['Future', '/insights/future', 'insights'], ['Reflections', '/insights/reflections', 'insights'],
  ['Past', '/insights/past', 'insights'],
] as const satisfies ReadonlyArray<readonly [string, string, AppRoute['kind']]>;

const NOTIFY_EMAIL: MentionMember = {
  user_id: 'notify.email',
  role: 'feature',
  display_name: 'Email notifications',
  handle: 'notify.email',
  email: null,
};

function reference(kind: 'feature' | 'integration', name: string, target: string, description: string): MentionMember {
  const value = `@{${kind}:${name}:${target}}`;
  return { user_id: value, role: kind, display_name: name, handle: value, email: null,
    reference: { kind, value, description, keywords: [name, target, kind] } };
}

function integrationReference(provider: string, account: GoogleAccount, action?: string): MentionMember {
  const canonical = action ? `${provider}.${action}` : provider;
  const label = action ? `${account.customName ?? provider}.${action}` : account.customName ?? provider;
  const member = reference('integration', canonical, account.email, `${canonical} · ${account.email}`);
  return { ...member, display_name: label,
    reference: { kind: 'integration', value: member.handle, description: `${canonical} · ${account.email}`,
      keywords: [canonical, account.email, label, 'integration'] } };
}

const INTEGRATION_TOOLS = [
  ['Gmail', 'search', 'gmail.read'], ['Gmail', 'read_thread', 'gmail.read'], ['Gmail', 'draft_reply', 'gmail.draft'],
  ['Gmail', 'read_draft', 'gmail.read'], ['Gmail', 'compose_draft', 'gmail.draft'], ['Gmail', 'update_draft', 'gmail.draft'],
  ['Gmail', 'send_draft', 'gmail.send'], ['Gmail', 'trash_message', 'gmail.modify'], ['Gmail', 'restore_message', 'gmail.modify'],
  ['Google Calendar', 'list_calendars', 'calendar.read'], ['Google Calendar', 'list_events', 'calendar.read'],
  ['Google Calendar', 'create_event', 'calendar.write'], ['Google Calendar', 'update_event', 'calendar.write'],
] as const;

/** Public destinations and Bob are always available, even with no shared spaces. */
export function platformMentions(members: MentionMember[]): MentionMember[] {
  const assistant: MentionMember = { user_id: 'bob', role: 'assistant', display_name: BRAND.assistantName, handle: 'bob', email: null };
  const all = [assistant, ...members, NOTIFY_EMAIL, ...FEATURES.map(([name, path]) => reference('feature', name, path, `Feature · ${path}`))];
  return [...new Map(all.map((member) => [member.user_id, member])).values()];
}

function isActionAllowed(allowedTools: ReadonlyMap<string, ReadonlySet<string>> | undefined, accountId: string, provider: string, action: string): boolean {
  const toolName = 'google_' + (provider === 'Gmail' ? 'gmail_' : 'calendar_') + action;
  return allowedTools === undefined || allowedTools.get(accountId)?.has(toolName) === true;
}

/** Only granted, usable connections; references carry readable identity, never credentials or opaque IDs. */
export function integrationMentions(accounts: GoogleAccount[], allowedTools?: ReadonlyMap<string, ReadonlySet<string>>): MentionMember[] {
  return accounts.filter((account) => !account.needsReconnect && /^[^\s{}:]+@[^\s{}:]+$/.test(account.email)).flatMap((account) => {
    const mentions: MentionMember[] = [];
    if (account.access.some((capability) => capability.startsWith('gmail.'))) {
      mentions.push(integrationReference('Gmail', account));
    }
    if (account.access.includes('calendar.read') || account.access.includes('calendar.write')) {
      mentions.push(integrationReference('Google Calendar', account));
    }
    for (const [provider, action, capability] of INTEGRATION_TOOLS) {
      if (account.access.includes(capability) && isActionAllowed(allowedTools, account.id, provider, action)) mentions.push(integrationReference(provider, account, action));
    }
    return mentions;
  });
}
