// The pure half of Ask Bob proposals (#1191): the strict wire shapes and the policy
// that says which actions always ask. No database.
import { describe, expect, it } from 'vitest';
import {
  CreateProposalSchema,
  PROPOSAL_ACTIONS,
  ProposalViewSchema,
  STARTER_POLICY,
  classifyAction,
} from '../../src/conversations/approval.ts';

const valid = {
  title: 'Move your design review',
  steps: [
    { action: 'move_event', title: 'Move Design review', subline: 'From 11:00 AM to 2:00 PM', params: { event_id: 'evt-1', to: '2026-10-21T14:00:00Z' } },
    { action: 'notify_people', title: 'Notify Work crew' },
  ],
  changes: [{ label: 'Design review', before: 'Was 11:00 AM', after: 'Today, 2:00 PM' }],
  notify: [{ name: 'Work crew', detail: '2 people' }],
  reminder: { label: 'Fires before the event', offset_minutes: 10 },
};

describe('classifyAction', () => {
  it.each([
    ['send_email', 'ask'],
    ['send_message', 'ask'],
    ['purchase', 'ask'],
    ['delete_item', 'ask'],
    ['share_item', 'ask'],
    ['forget', 'ask'],
    ['notify_people', 'ask'],
    ['create_reminder', 'undoable'],
    ['create_task', 'undoable'],
    ['create_note', 'undoable'],
    ['create_event', 'undoable'],
    ['move_event', 'undoable'],
    ['complete_task', 'undoable'],
    ['set_timer', 'allow'],
    ['list_agenda', 'allow'],
  ])('%s is %s in the starter policy', (action, expected) => {
    expect(classifyAction(action)).toBe(expected);
  });

  it('asks about an unknown, empty or inherited action name', () => {
    for (const name of ['wire_money', '', 'constructor', 'toString', '__proto__']) {
      expect(classifyAction(name)).toBe('ask');
    }
  });

  it('lets a custom policy override the starter policy', () => {
    expect(classifyAction('send_email', { send_email: 'allow' })).toBe('allow');
    expect(classifyAction('purchase', { send_email: 'allow' })).toBe('ask');
  });

  it('gives every action a proposal may name a decision in the starter policy', () => {
    for (const action of PROPOSAL_ACTIONS) expect(Object.hasOwn(STARTER_POLICY, action)).toBe(true);
  });
});

describe('CreateProposalSchema', () => {
  it('accepts a full proposal and defaults changes and notify', () => {
    const parsed = CreateProposalSchema.parse(valid);
    expect(parsed.steps).toHaveLength(2);
    const minimal = CreateProposalSchema.parse({ title: 'Add a reminder', steps: [{ action: 'create_reminder', title: 'Remind me' }] });
    expect(minimal.changes).toEqual([]);
    expect(minimal.notify).toEqual([]);
    expect(minimal.reminder).toBeUndefined();
  });

  it('rejects an unknown action', () => {
    const bad = { ...valid, steps: [{ action: 'wire_money', title: 'Send money' }] };
    expect(CreateProposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an extra key at every level', () => {
    expect(CreateProposalSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(CreateProposalSchema.safeParse({ ...valid, steps: [{ ...valid.steps[0], extra: 1 }] }).success).toBe(false);
    expect(CreateProposalSchema.safeParse({ ...valid, changes: [{ ...valid.changes[0], extra: 1 }] }).success).toBe(false);
    expect(CreateProposalSchema.safeParse({ ...valid, notify: [{ name: 'x', extra: 1 }] }).success).toBe(false);
    expect(CreateProposalSchema.safeParse({ ...valid, reminder: { ...valid.reminder, extra: 1 } }).success).toBe(false);
  });

  it.each([
    ['no steps', { ...valid, steps: [] }],
    ['nine steps', { ...valid, steps: Array.from({ length: 9 }, () => ({ action: 'create_task', title: 'Task' })) }],
    ['a blank title', { ...valid, title: '   ' }],
    ['a 121 character title', { ...valid, title: 'x'.repeat(121) }],
    ['a 81 character step title', { ...valid, steps: [{ action: 'create_task', title: 'x'.repeat(81) }] }],
    ['nine changes', { ...valid, changes: Array.from({ length: 9 }, () => ({ label: 'a', after: 'b' })) }],
    ['eleven people notified', { ...valid, notify: Array.from({ length: 11 }, () => ({ name: 'n' })) }],
    ['a negative reminder offset', { ...valid, reminder: { label: 'r', offset_minutes: -1 } }],
    ['a reminder offset over a week', { ...valid, reminder: { label: 'r', offset_minutes: 10081 } }],
    ['a nested object param', { ...valid, steps: [{ action: 'create_task', title: 't', params: { a: { b: 1 } } }] }],
    ['an over-long string param', { ...valid, steps: [{ action: 'create_task', title: 't', params: { a: 'x'.repeat(501) } }] }],
    ['thirteen params', { ...valid, steps: [{ action: 'create_task', title: 't', params: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])) }] }],
  ])('rejects %s', (_name, input) => {
    expect(CreateProposalSchema.safeParse(input).success).toBe(false);
  });

  it('accepts the maximum sizes', () => {
    const max = {
      title: 'x'.repeat(120),
      steps: Array.from({ length: 8 }, () => ({ action: 'create_task', title: 'x'.repeat(80), subline: 'y'.repeat(120) })),
      changes: Array.from({ length: 8 }, () => ({ label: 'l'.repeat(40), before: 'b'.repeat(120), after: 'a'.repeat(120) })),
      notify: Array.from({ length: 10 }, () => ({ name: 'n'.repeat(60), detail: 'd'.repeat(120) })),
      reminder: { label: 'r'.repeat(80), offset_minutes: 10080 },
    };
    expect(CreateProposalSchema.safeParse(max).success).toBe(true);
  });
});

describe('ProposalViewSchema', () => {
  const view = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'pending',
    title: 'Move your design review',
    steps: [{ action: 'move_event', title: 'Move Design review' }],
    changes: [],
    notify: [],
    reminder: null,
    created_at: 1,
    decided_at: null,
  };

  it('accepts a card and rejects step params or an unknown status', () => {
    expect(ProposalViewSchema.safeParse(view).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...view, steps: [{ ...view.steps[0], params: { a: 1 } }] }).success).toBe(false);
    expect(ProposalViewSchema.safeParse({ ...view, status: 'running' }).success).toBe(false);
  });
});
