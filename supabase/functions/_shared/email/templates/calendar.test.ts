import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { Block, EmailContent } from '../content.ts';
import {
  CALENDAR_TEMPLATES,
  eventCancelled,
  eventInvited,
  eventRsvp,
  eventUpdated,
  reminderDue,
  rsvpPhrase,
} from './calendar.ts';

/** Every plain-text string a template emits, for leak and markup checks. */
function strings(content: EmailContent): string[] {
  const out = [content.subject, content.preheader, content.heading, content.reason];
  for (const block of content.blocks) {
    if (block.kind === 'details') {
      for (const row of block.rows) out.push(row.label, row.value);
    } else if (block.kind === 'button') {
      out.push(block.label);
    } else if (block.kind === 'code') {
      out.push(block.value);
    } else {
      out.push(block.text);
    }
  }
  return out;
}

function detailLabels(content: EmailContent): string[] {
  const block = content.blocks.find((b: Block) => b.kind === 'details');
  return block && block.kind === 'details' ? block.rows.map((r) => r.label) : [];
}

function buttons(content: EmailContent): Block[] {
  return content.blocks.filter((b: Block) => b.kind === 'button');
}

Deno.test('every calendar template builds from its sample', () => {
  const ids = new Set<string>();
  for (const t of CALENDAR_TEMPLATES) {
    const content = (t.build as (d: unknown) => EmailContent)(t.sample);
    assertEquals(t.category, 'calendar');
    assert(content.subject.length > 0 && content.subject.length < 78, `${t.id} subject length`);
    assert(content.heading.length > 0, `${t.id} heading`);
    assert(content.reason.length > 0, `${t.id} reason`);
    assert(!ids.has(t.id), `${t.id} duplicated`);
    ids.add(t.id);
  }
});

Deno.test('required lists match the catalog', () => {
  const byId = Object.fromEntries(CALENDAR_TEMPLATES.map((t) => [t.id, [...t.required].sort()]));
  assertEquals(byId, {
    'reminder-due': ['dueLabel', 'manageUrl', 'title', 'url'],
    'event-invited': ['eventTitle', 'eventUrl', 'manageUrl', 'organizerName', 'spaceName', 'whenLabel'],
    'event-updated': ['actorName', 'changesLabel', 'eventTitle', 'eventUrl', 'manageUrl', 'whenLabel'],
    'event-cancelled': ['actorName', 'eventTitle', 'spaceName', 'whenLabel'],
    'event-rsvp': ['attendeeName', 'eventTitle', 'eventUrl', 'manageUrl', 'response'],
  });
});

Deno.test('notification templates link to settings; event-cancelled has no button', () => {
  for (const t of [reminderDue, eventInvited, eventUpdated, eventRsvp]) {
    const content = (t.build as (d: unknown) => EmailContent)(t.sample);
    assertEquals(content.manageUrl, t.sample.manageUrl);
    assertEquals(buttons(content).length, 1);
  }
  const cancelled = eventCancelled.build(eventCancelled.sample);
  assertEquals(buttons(cancelled).length, 0);
  assertEquals(cancelled.manageUrl, undefined);
});

Deno.test('headings and buttons state the thing', () => {
  assertEquals(reminderDue.build(reminderDue.sample).heading, 'Reminder: Pick up the dry cleaning');
  const invited = eventInvited.build(eventInvited.sample);
  assertEquals(invited.heading, 'Maya invited you to Sunday lunch');
  assertEquals(buttons(invited)[0], { kind: 'button', href: eventInvited.sample.eventUrl, label: 'RSVP' });
  assertEquals(detailLabels(invited), ['When', 'Where', 'Space']);
  const updated = eventUpdated.build(eventUpdated.sample);
  assert(strings(updated).includes('Time and place changed'));
});

Deno.test('optional keys absent still build', () => {
  const { spaceName: _s, ...reminder } = reminderDue.sample;
  const r = reminderDue.build(reminder);
  assertEquals(detailLabels(r), ['When']);
  const { location: _l, ...invite } = eventInvited.sample;
  const i = eventInvited.build(invite);
  assertEquals(detailLabels(i), ['When', 'Space']);
});

Deno.test('rsvp copy varies by response and falls back to replied', () => {
  const heading = (response: string): string =>
    eventRsvp.build({ ...eventRsvp.sample, response: response as 'accepted' }).heading;
  assertStringIncludes(heading('accepted'), 'Arjun is going');
  assertStringIncludes(heading('declined'), "Arjun can't make it");
  assertStringIncludes(heading('tentative'), 'Arjun might come');
  assertStringIncludes(heading('maybe-later'), 'Arjun replied');
  assertEquals(rsvpPhrase(''), 'replied');
});

Deno.test('data is carried as plain text, never markup, and no emails leak', () => {
  const evil = '<b onclick="x">Maya</b> & co';
  const content = eventInvited.build({ ...eventInvited.sample, organizerName: evil, eventTitle: evil });
  for (const s of strings(content)) {
    const own = s.split(evil).join('');
    assert(!own.includes('<') && !own.includes('>'), `template markup: ${s}`);
    assert(!s.includes('&amp;') && !s.includes('&lt;'), `pre-escaped: ${s}`);
  }
  assertStringIncludes(content.heading, evil);
  for (const t of CALENDAR_TEMPLATES) {
    for (const s of strings((t.build as (d: unknown) => EmailContent)(t.sample))) {
      assert(!s.includes('@'), `${t.id} leaks an address: ${s}`);
    }
  }
});
