import type { Block, EmailContent, EmailTemplate } from '../content.ts';

const NOTIFY_REASON = 'You got this email because calendar notifications are on for your Bob account.';

type ReminderDueData = {
  title: string;
  dueLabel: string;
  spaceName?: string;
  url: string;
  manageUrl: string;
};

type EventInvitedData = {
  organizerName: string;
  eventTitle: string;
  whenLabel: string;
  location?: string;
  spaceName: string;
  eventUrl: string;
  manageUrl: string;
};

type EventUpdatedData = {
  actorName: string;
  eventTitle: string;
  whenLabel: string;
  changesLabel: string;
  eventUrl: string;
  manageUrl: string;
};

type EventCancelledData = {
  actorName: string;
  eventTitle: string;
  whenLabel: string;
  spaceName: string;
};

type RsvpResponse = 'accepted' | 'declined' | 'tentative';

type EventRsvpData = {
  attendeeName: string;
  eventTitle: string;
  response: RsvpResponse;
  eventUrl: string;
  manageUrl: string;
};

/** Details rows, skipping any optional value that was not supplied. */
function details(rows: ReadonlyArray<[string, string | undefined]>): Block {
  return {
    kind: 'details',
    rows: rows
      .filter((row): row is [string, string] => typeof row[1] === 'string' && row[1] !== '')
      .map(([label, value]) => ({ label, value })),
  };
}

/** The verb phrase for an RSVP; an unexpected value reads as a plain reply. */
export function rsvpPhrase(response: string): string {
  switch (response) {
    case 'accepted': return 'is going';
    case 'declined': return "can't make it";
    case 'tentative': return 'might come';
    default: return 'replied';
  }
}

export const reminderDue = {
  id: 'reminder-due',
  category: 'calendar',
  trigger: 'A reminder the user set comes due.',
  required: ['title', 'dueLabel', 'url', 'manageUrl'],
  build: (d: ReminderDueData): EmailContent => ({
    subject: `Reminder: ${d.title}`,
    preheader: `Due ${d.dueLabel}`,
    heading: `Reminder: ${d.title}`,
    blocks: [
      details([['When', d.dueLabel], ['Space', d.spaceName]]),
      { kind: 'button', href: d.url, label: 'Open reminder' },
    ],
    reason: NOTIFY_REASON,
    manageUrl: d.manageUrl,
  }),
  sample: {
    title: 'Pick up the dry cleaning',
    dueLabel: 'Today at 5:30 PM',
    spaceName: 'Home',
    url: 'https://app.example.com/reminders/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<ReminderDueData>;

export const eventInvited = {
  id: 'event-invited',
  category: 'calendar',
  trigger: 'Someone adds the user as an attendee of an event.',
  required: ['organizerName', 'eventTitle', 'whenLabel', 'spaceName', 'eventUrl', 'manageUrl'],
  build: (d: EventInvitedData): EmailContent => ({
    subject: `${d.organizerName} invited you to ${d.eventTitle}`,
    preheader: `${d.whenLabel} · ${d.spaceName}`,
    heading: `${d.organizerName} invited you to ${d.eventTitle}`,
    blocks: [
      details([['When', d.whenLabel], ['Where', d.location], ['Space', d.spaceName]]),
      { kind: 'button', href: d.eventUrl, label: 'RSVP' },
    ],
    reason: NOTIFY_REASON,
    manageUrl: d.manageUrl,
  }),
  sample: {
    organizerName: 'Maya',
    eventTitle: 'Sunday lunch',
    whenLabel: 'Sun, 27 Sep · 1:00 PM',
    location: 'Arjun’s place',
    spaceName: 'Family',
    eventUrl: 'https://app.example.com/events/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<EventInvitedData>;

export const eventUpdated = {
  id: 'event-updated',
  category: 'calendar',
  trigger: 'An event the user attends is changed by someone else.',
  required: ['actorName', 'eventTitle', 'whenLabel', 'changesLabel', 'eventUrl', 'manageUrl'],
  build: (d: EventUpdatedData): EmailContent => ({
    subject: `${d.actorName} updated ${d.eventTitle}`,
    preheader: d.changesLabel,
    heading: `${d.actorName} updated ${d.eventTitle}`,
    blocks: [
      { kind: 'paragraph', text: d.changesLabel },
      details([['When', d.whenLabel]]),
      { kind: 'button', href: d.eventUrl, label: 'View event' },
    ],
    reason: NOTIFY_REASON,
    manageUrl: d.manageUrl,
  }),
  sample: {
    actorName: 'Maya',
    eventTitle: 'Sunday lunch',
    whenLabel: 'Sun, 27 Sep · 2:00 PM',
    changesLabel: 'Time and place changed',
    eventUrl: 'https://app.example.com/events/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<EventUpdatedData>;

export const eventCancelled = {
  id: 'event-cancelled',
  category: 'calendar',
  trigger: 'An event the user attends is cancelled.',
  required: ['actorName', 'eventTitle', 'whenLabel', 'spaceName'],
  build: (d: EventCancelledData): EmailContent => ({
    subject: `Cancelled: ${d.eventTitle}`,
    preheader: `${d.actorName} cancelled ${d.eventTitle}`,
    heading: `${d.actorName} cancelled ${d.eventTitle}`,
    blocks: [
      details([['When', d.whenLabel], ['Space', d.spaceName]]),
      { kind: 'paragraph', text: 'No action needed.' },
    ],
    reason: 'You got this email because you were attending this event in Bob.',
  }),
  sample: {
    actorName: 'Maya',
    eventTitle: 'Sunday lunch',
    whenLabel: 'Sun, 27 Sep · 1:00 PM',
    spaceName: 'Family',
  },
} satisfies EmailTemplate<EventCancelledData>;

export const eventRsvp = {
  id: 'event-rsvp',
  category: 'calendar',
  trigger: 'An attendee answers the RSVP for an event the user organises.',
  required: ['attendeeName', 'eventTitle', 'response', 'eventUrl', 'manageUrl'],
  build: (d: EventRsvpData): EmailContent => {
    const line = `${d.attendeeName} ${rsvpPhrase(d.response)}`;
    return {
      subject: `${line}: ${d.eventTitle}`,
      preheader: `${line} to ${d.eventTitle}`,
      heading: `${line}: ${d.eventTitle}`,
      blocks: [{ kind: 'button', href: d.eventUrl, label: 'View event' }],
      reason: NOTIFY_REASON,
      manageUrl: d.manageUrl,
    };
  },
  sample: {
    attendeeName: 'Arjun',
    eventTitle: 'Sunday lunch',
    response: 'accepted',
    eventUrl: 'https://app.example.com/events/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<EventRsvpData>;

export const CALENDAR_TEMPLATES = [
  reminderDue,
  eventInvited,
  eventUpdated,
  eventCancelled,
  eventRsvp,
] as const;
