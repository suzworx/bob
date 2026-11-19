import { describe, expect, it } from 'vitest';
import { buildMentionTrigger, mentionToken } from './mentions';
import { integrationMentions, platformMentions } from './platform-mentions';
import { routeFromPath } from '@/app/routes';

describe('platform mention references', () => {
  it('finds Bob by every supported alias with no spaces or people', async () => {
    const trigger = buildMentionTrigger(platformMentions([]));
    for (const query of ['Bob', '@Bob', 'assistant', 'Bob']) {
      expect((await trigger.searchSource.search(query)).some((item) => item.id === 'bob')).toBe(true);
    }
    expect(trigger.deserialize?.('@bob')).toMatchObject({ value: '@bob' });
  });
  it('inserts the exact @notify.email command from the platform mention picker', async () => {
    const trigger = buildMentionTrigger(platformMentions([]));
    const matches = await trigger.searchSource.search('notify.email');
    const command = matches.find((item) => item.id === 'notify.email');
    expect(command).toBeDefined();
    expect(command && trigger.onSelect(command)).toMatchObject({ value: '@notify.email' });
    expect(trigger.deserialize?.('@notify.email')).toMatchObject({ value: '@notify.email' });
  });
  it('serializes feature references distinctly from people and restores exact meaning', () => {
    const members = platformMentions([{ user_id: 'person', role: 'member', handle: 'routines', display_name: 'Routines', email: null }]);
    const feature = members.find((member) => member.reference?.value === '@{feature:Routines:/routines}');
    expect(feature).toBeDefined();
    if (!feature) return;
    const token = mentionToken(feature);
    expect(token.value).toBe('@{feature:Routines:/routines}');
    expect(buildMentionTrigger(members).deserialize?.(token.value)).toEqual(token);
    expect(buildMentionTrigger(members).deserialize?.('@routines')).toMatchObject({ value: '@routines' });
    for (const member of members.filter((item) => item.reference?.kind === 'feature')) {
      const path = member.reference?.value.split(':').at(-1)?.slice(0, -1) ?? '';
      expect(path === '/' || routeFromPath(path).kind !== 'chat').toBe(true);
    }
  });
  it('only includes authorized connected capabilities and no opaque account IDs', () => {
    const account = { id: 'opaque-secret-id', email: 'one@example.com', name: null, selected: true, createdAt: 1, access: ['gmail.read' as const], needsReconnect: false };
    const members = integrationMentions([account, { ...account, email: 'revoked@example.com', needsReconnect: true }, { ...account, email: 'ungranted@example.com', access: [] }]);
    expect(members).toHaveLength(4);
    expect(mentionToken(members[0]).value).toBe('@{integration:Gmail:one@example.com}');
    expect(JSON.stringify(members)).not.toContain('opaque-secret-id');
  });
});

it('finds custom names by alias, provider and email while preserving canonical identity', async () => {
  const members = integrationMentions([{ id: 'opaque-id', email: 'work@example.com', customName: 'My work', name: null,
    selected: true, createdAt: 1, access: ['gmail.read', 'calendar.read'], needsReconnect: false }]);
  const trigger = buildMentionTrigger(members);
  for (const query of ['My work', 'work@example.com']) expect(await trigger.searchSource.search(query)).toHaveLength(7);
  const matches = await trigger.searchSource.search('Gmail');
  expect(matches).toHaveLength(4);
  const bare = matches.find((match) => match.id === '@{integration:Gmail:work@example.com}');
  expect(bare && trigger.onSelect(bare)).toEqual({ label: 'My work', value: '@{integration:Gmail:work@example.com}', variant: 'blue' });
  expect(trigger.deserialize?.('@{integration:Gmail:work@example.com}')).toMatchObject({ label: 'My work' });
});

it('selects an account-specific action by namespace with duplicate aliases and filters ungranted tools', async () => {
  const account = { id: 'private', email: 'one@example.com', customName: 'WorkGmail', name: null,
    selected: true, createdAt: 1, access: ['gmail.read' as const], needsReconnect: false };
  const members = integrationMentions([account, { ...account, email: 'two@example.com' }]);
  const trigger = buildMentionTrigger(members);
  const matches = await trigger.searchSource.search('WorkGmail.search');
  expect(matches).toHaveLength(2);
  expect(await trigger.searchSource.search('Gmail.search')).toHaveLength(2);
  const second = matches.find((match) => match.id.endsWith(':two@example.com}'));
  expect(second && trigger.onSelect(second)).toEqual({ label: 'WorkGmail.search', value: '@{integration:Gmail.search:two@example.com}', variant: 'blue' });
  expect(members.some((member) => member.reference?.value.includes('draft_reply'))).toBe(false);
  expect(members.some((member) => member.reference?.value.includes('Calendar'))).toBe(false);
  const all = integrationMentions([{ ...account, access: ['gmail.read', 'gmail.draft', 'calendar.read', 'calendar.write'] }]);
  expect(all.filter((member) => member.reference?.value.includes('Gmail.'))).toHaveLength(6);
  expect(all.filter((member) => member.reference?.value.includes('Google Calendar.'))).toHaveLength(4);
});


it.each([
  ['gmail.read', ['search', 'read_thread', 'read_draft']],
  ['gmail.draft', ['draft_reply', 'compose_draft', 'update_draft']],
  ['gmail.send', ['send_draft']],
  ['gmail.modify', ['trash_message', 'restore_message']],
] as const)('exposes only actions authorized by %s', (capability, actions) => {
  const account = { id: 'private', email: 'work@example.com', name: null, selected: true, createdAt: 1,
    access: [capability], needsReconnect: false };
  const values = integrationMentions([account]).map((member) => member.reference?.value);
  expect(values).toEqual([
    '@{integration:Gmail:work@example.com}',
    ...actions.map((action) => `@{integration:Gmail.${action}:work@example.com}`),
  ]);
  expect(integrationMentions([{ ...account, needsReconnect: true }])).toEqual([]);
});

it('keeps renamed Gmail CRUD mentions only when granted and enabled for that account', () => {
  const account = { id: 'work', email: 'work@example.test', customName: 'WorkGmail', name: null, selected: true, createdAt: 1,
    access: ['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify'] as const, needsReconnect: false };
  const grants = { ...account, access: [...account.access] };
  const enabled = new Map([['work', new Set(['google_gmail_read_draft', 'google_gmail_compose_draft', 'google_gmail_send_draft', 'google_gmail_restore_message'])]]);
  const members = integrationMentions([grants], enabled);
  expect(members.map((member) => member.display_name)).toEqual(['WorkGmail', 'WorkGmail.read_draft', 'WorkGmail.compose_draft', 'WorkGmail.send_draft', 'WorkGmail.restore_message']);
  expect(members.map((member) => member.reference?.value)).toContain('@{integration:Gmail.send_draft:work@example.test}');
  expect(integrationMentions([{ ...grants, id: 'other' }], enabled).map((member) => member.display_name)).toEqual(['WorkGmail']);
  expect(integrationMentions([{ ...grants, access: ['gmail.read'] }], enabled).map((member) => member.display_name)).toEqual(['WorkGmail', 'WorkGmail.read_draft']);
});
