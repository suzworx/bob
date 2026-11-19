import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { Block, EmailContent } from '../content.ts';
import { renderEmail } from '../render.ts';
import {
  ACTIVITY_TEMPLATES,
  bobMessage,
  capExcerpt,
  chatInvite,
  EXCERPT_MAX_CHARS,
  taskAssigned,
  threadMention,
} from './activity.ts';

type AnyTemplate = {
  id: string;
  category: string;
  trigger: string;
  required: ReadonlyArray<string>;
  build: (data: Record<string, unknown>) => EmailContent;
  sample: Record<string, unknown>;
};

const templates = ACTIVITY_TEMPLATES as unknown as ReadonlyArray<AnyTemplate>;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INJECTED = '<b onclick="x()">Mallory</b>';

/** The catalog's required keys per id; optional keys (dueLabel) are left out. */
const DECLARED_REQUIRED: Record<string, ReadonlyArray<string>> = {
  'bob-message': ['noteTitle', 'noteUrl', 'manageUrl'],
  'chat-invite': ['inviterName', 'chatName', 'acceptUrl', 'expiresLabel'],
  'task-assigned': ['actorName', 'spaceName', 'taskTitle', 'taskUrl', 'manageUrl'],
  'thread-mention': ['actorName', 'spaceName', 'threadTitle', 'excerpt', 'threadUrl', 'manageUrl'],
};

/** Every plain-text string an email's content carries, blocks included. */
function contentStrings(content: EmailContent): string[] {
  const out = [content.subject, content.preheader, content.heading, content.reason];
  if (content.manageUrl !== undefined) out.push(content.manageUrl);
  for (const block of content.blocks) {
    if (block.kind === 'code') out.push(block.value);
    else if (block.kind === 'button') out.push(block.href, block.label);
    else if (block.kind === 'details') for (const r of block.rows) out.push(r.label, r.value);
    else out.push(block.text);
  }
  return out;
}

function blocksOf<K extends Block['kind']>(c: EmailContent, kind: K): Array<Extract<Block, { kind: K }>> {
  return c.blocks.filter((b): b is Extract<Block, { kind: K }> => b.kind === kind);
}

Deno.test('activity: ids are kebab-case, unique and match the catalog', () => {
  const ids = templates.map((t) => t.id);
  for (const id of ids) assert(KEBAB.test(id), `${id} is not kebab-case`);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals([...ids].sort(), Object.keys(DECLARED_REQUIRED).sort());
});

for (const t of templates) {
  Deno.test(`${t.id}: category, trigger and required`, () => {
    assertEquals(t.category, 'activity');
    assert(t.trigger.trim().length > 0);
    assertEquals([...t.required].sort(), [...DECLARED_REQUIRED[t.id]].sort());
    for (const key of t.required) assert(key in t.sample, `${key} missing from sample`);
  });

  Deno.test(`${t.id}: sample builds a notification with one button`, () => {
    const c = t.build(t.sample);
    assert(c.subject.trim().length > 0);
    assert(c.preheader.trim().length > 0);
    assert(c.heading.trim().length > 0);
    assert(c.subject.length < 78, `subject is ${c.subject.length} chars`);
    assert(c.reason.startsWith('You got this because'));
    assertEquals(c.manageUrl, t.sample.manageUrl);
    assertEquals(blocksOf(c, 'button').length, 1);
  });

  Deno.test(`${t.id}: builds with only the required keys`, () => {
    const minimal = Object.fromEntries(t.required.map((k) => [k, t.sample[k]]));
    for (const s of contentStrings(t.build(minimal))) assert(!s.includes('undefined'), s);
  });

  Deno.test(`${t.id}: never produces markup of its own`, () => {
    for (const s of contentStrings(t.build(t.sample))) assert(!/[<>]/.test(s), `markup in: ${s}`);
    const hostile = Object.fromEntries(
      Object.entries(t.sample).map(([k, v]) => [k, typeof v === 'string' ? INJECTED : v]),
    );
    for (const s of contentStrings(t.build(hostile))) {
      assert(!/[<>]/.test(s.split(INJECTED).join('')), `markup added around data: ${s}`);
    }
  });
}

Deno.test('task-assigned: due row only when dueLabel is given', () => {
  const withDue = blocksOf(taskAssigned.build(taskAssigned.sample), 'details')[0];
  assert(withDue.rows.some((r) => r.label === 'Due'));
  const { dueLabel: _omit, ...rest } = taskAssigned.sample;
  const withoutDue = blocksOf(taskAssigned.build(rest), 'details')[0];
  assert(!withoutDue.rows.some((r) => r.label === 'Due'));
});

Deno.test('thread-mention: excerpt is a quote block', () => {
  const quotes = blocksOf(threadMention.build(threadMention.sample), 'quote');
  assertEquals(quotes.length, 1);
  assertEquals(quotes[0].text, threadMention.sample.excerpt);
});

Deno.test('thread-mention: build caps a long excerpt at 280 chars with an ellipsis', () => {
  const excerpt = 'word '.repeat(200);
  const quote = blocksOf(threadMention.build({ ...threadMention.sample, excerpt }), 'quote')[0];
  assert(Array.from(quote.text).length <= EXCERPT_MAX_CHARS, `${quote.text.length} chars`);
  assert(quote.text.endsWith('…'));
});

Deno.test('capExcerpt: leaves short text alone and counts characters, not UTF-16 units', () => {
  assertEquals(capExcerpt('  hello  '), 'hello');
  const exact = 'a'.repeat(EXCERPT_MAX_CHARS);
  assertEquals(capExcerpt(exact), exact);
  const emoji = '😀'.repeat(EXCERPT_MAX_CHARS + 10);
  const capped = capExcerpt(emoji);
  assertEquals(Array.from(capped).length, EXCERPT_MAX_CHARS);
  assert(capped.endsWith('…'));
});

Deno.test('chat-invite: joining is explicit, scoped to this chat and uses a shareable expiring link', () => {
  const content = chatInvite.build(chatInvite.sample);
  const rendered = renderEmail(content);
  assertEquals(blocksOf(content, 'button'), [
    { kind: 'button', href: chatInvite.sample.acceptUrl, label: 'Join chat' },
  ]);
  assert(rendered.html.includes(`href="${chatInvite.sample.acceptUrl}"`));
  assert(rendered.text.includes(chatInvite.sample.expiresLabel));
  assert(rendered.text.includes('only this chat and its history'));
  assert(rendered.text.includes('You choose whether to join'));
  assert(rendered.text.includes('Anyone with this link can join'));
  assert(!/space|automatically|only you can/i.test(rendered.text));
});

Deno.test('chat-invite: renderer escapes names and rejects an unsafe invitation URL', () => {
  const rendered = renderEmail(chatInvite.build({
    ...chatInvite.sample,
    inviterName: INJECTED,
    chatName: '<script>alert(1)</script>',
    acceptUrl: 'javascript:alert(1)',
  }));
  assert(!rendered.html.includes(INJECTED));
  assert(rendered.html.includes('&lt;b onclick=&quot;x()&quot;&gt;Mallory&lt;/b&gt;'));
  assert(rendered.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert(!rendered.html.includes('href="javascript:'));
});

Deno.test('bob-message: Bob-branded note includes its body and exact note link', () => {
  const content = bobMessage.build(bobMessage.sample);
  const quotes = blocksOf(content, 'quote');
  const buttons = blocksOf(content, 'button');
  const rendered = renderEmail(content);

  assertEquals(content.subject, 'Bob left you a note: Weekend plan');
  assertEquals(quotes.length, 1);
  assertEquals(quotes[0].text, bobMessage.sample.noteBody);
  assertEquals(buttons.length, 1);
  assertEquals(buttons[0].href, bobMessage.sample.noteUrl);
  assertEquals(buttons[0].label, 'Open note');
  assert(rendered.text.includes(bobMessage.sample.noteBody));
  assert(rendered.text.includes(`Open note: ${bobMessage.sample.noteUrl}`));
});

Deno.test('bob-message: an empty optional body is omitted without losing the note link', () => {
  const content = bobMessage.build({ ...bobMessage.sample, noteBody: '' });
  assertEquals(blocksOf(content, 'quote').length, 0);
  assertEquals(blocksOf(content, 'button').length, 1);
});
