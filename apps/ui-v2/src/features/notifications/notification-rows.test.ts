import { describe, expect, it } from 'vitest';
import { notificationRow, whenLabel } from './notification-rows';
import type { InboxNotification, NotificationAbout } from './notifications-api';

const SPACE = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '22222222-2222-4222-8222-222222222222';
const SPACE_URL = 'spc_11111111111141118111111111111111';
// 2026-10-21 12:00 in Los Angeles.
const NOW = Date.UTC(2026, 9, 21, 19, 0);
const ZONE = 'America/Los_Angeles';

function about(overrides: Partial<NotificationAbout> = {}): NotificationAbout {
  return { actor_name: null, title: null, space_name: null, at: null, date: null, action: null, ...overrides };
}

function item(overrides: Partial<InboxNotification>): InboxNotification {
  return {
    id: 'n1',
    space_id: SPACE,
    type: 'mention',
    resource_type: 'thread',
    resource_id: RESOURCE,
    revision: 1,
    cursor: 1,
    read_at: null,
    created_at: NOW,
    about: null,
    ...overrides,
  };
}

describe('notificationRow (redesign #1240 P0: who, what, where; exact target)', () => {
  it('a mention names the actor, the conversation and the space, and opens that thread', () => {
    const row = notificationRow(
      item({ about: about({ actor_name: 'Asha', title: 'Groceries', space_name: 'Test Fam' }) }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Asha mentioned you in Groceries');
    expect(row.description).toBe('Test Fam');
    expect(row.target).toMatch(new RegExp(`^/spaces/${SPACE_URL}/conversations/`));
  });

  it('says Bob left a note and opens that exact note', () => {
    const row = notificationRow(
      item({
        type: 'bob_message' as InboxNotification['type'],
        resource_type: 'note',
        about: about({ title: 'Weekend plan', space_name: 'Test Fam' }),
      }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Bob left you a note: Weekend plan');
    expect(row.description).toBe('Note · Test Fam');
    expect(row.target).toBe(`/spaces/${SPACE_URL}/notes?note=${RESOURCE}`);

    const hidden = notificationRow(
      item({ type: 'bob_message' as InboxNotification['type'], resource_type: 'note', about: null }),
      ZONE,
      NOW,
    );
    expect(hidden.label).toBe('Bob left you a note');
    expect(hidden.target).toBeNull();
  });

  it('a reminder names the reminder and its time in the account zone, and opens it on Today', () => {
    const nineAm = Date.UTC(2026, 9, 21, 16, 0); // 9:00 AM in Los Angeles
    const row = notificationRow(
      item({ type: 'reminder', resource_type: 'reminder', about: about({ title: 'Update Insurance', at: nineAm }) }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Update Insurance');
    expect(row.description).toBe('Reminder · today 9:00 AM');
    expect(row.target).toBe(`/today?reminder=${RESOURCE}`);
  });

  it('a task assignment names the task, opens the task in its space, and shows its due date', () => {
    const row = notificationRow(
      item({ type: 'assignment', resource_type: 'task', about: about({ title: 'Book flights', space_name: 'Test Fam', date: '2026-10-24' }) }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Book flights');
    expect(row.description).toBe('Assigned to you · Test Fam · due Oct 24');
    expect(row.target).toBe(`/spaces/${SPACE_URL}/tasks?task=${RESOURCE}`);
  });

  it('an event RSVP names who answered and the event', () => {
    const row = notificationRow(
      item({ type: 'event_change', resource_type: 'event', about: about({ actor_name: 'Ravi', title: 'Dinner', action: 'declined' }) }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Ravi declined Dinner');
    expect(row.target).toBe(`/spaces/${SPACE_URL}/agenda?event=${RESOURCE}`);
  });

  it('a joined member and an accepted invite say who and where, and open the members tab', () => {
    const joined = notificationRow(
      item({ type: 'invitation', resource_type: 'space_member', about: about({ actor_name: 'Asha', space_name: 'Test Fam' }) }),
      ZONE,
      NOW,
    );
    expect(joined.label).toBe('Asha joined Test Fam');
    expect(joined.target).toBe(`/spaces/${SPACE_URL}/members`);
    const accepted = notificationRow(
      item({ type: 'invitation', resource_type: 'invitation', about: about({ actor_name: 'Asha', space_name: 'Test Fam' }) }),
      ZONE,
      NOW,
    );
    expect(accepted.label).toBe('Asha accepted your invite to Test Fam');
  });

  it('a security notice says what happened and opens where it is managed', () => {
    const row = notificationRow(
      item({ type: 'security', space_id: null, resource_type: 'device', about: about({ action: 'device_paired', title: 'Bob2' }) }),
      ZONE,
      NOW,
    );
    expect(row.label).toBe('Bob2 was paired');
    expect(row.target).toMatch(/^\/devices\//);
    const google = notificationRow(
      item({ type: 'security', space_id: null, resource_type: 'google_account', about: about({ action: 'google_linked', title: 'a@b.co' }) }),
      ZONE,
      NOW,
    );
    expect(google.label).toBe('Google account connected');
    expect(google.target).toBe('/integrations');
  });

  it('a row whose item is gone or hidden is plain text with no target', () => {
    const row = notificationRow(item({ about: null }), ZONE, NOW);
    expect(row.label).toBe('You were mentioned');
    expect(row.target).toBeNull();
    const joined = notificationRow(item({ type: 'invitation', resource_type: 'space_member', about: null }), ZONE, NOW);
    expect(joined.label).toBe('A new member joined');
    expect(joined.target).toBeNull();
  });
});

describe('whenLabel', () => {
  it('says tomorrow, or the date, in the account zone, never the browser zone', () => {
    const tomorrowNine = Date.UTC(2026, 9, 22, 16, 0);
    expect(whenLabel({ at: tomorrowNine, date: null }, ZONE, NOW)).toBe('tomorrow 9:00 AM');
    expect(whenLabel({ at: Date.UTC(2026, 9, 4, 12, 0), date: null }, ZONE, NOW)).toBe('Oct 4, 5:00 AM');
    // The same instant is today in Los Angeles but yesterday's late evening in Kolkata.
    const elevenUtc = Date.UTC(2026, 9, 21, 18, 0);
    expect(whenLabel({ at: elevenUtc, date: null }, ZONE, NOW)).toBe('today 11:00 AM');
    expect(whenLabel({ at: elevenUtc, date: null }, 'Asia/Kolkata', NOW)).toBe('Oct 21, 11:30 PM');
    expect(whenLabel({ at: null, date: null }, ZONE, NOW)).toBeNull();
  });
});
