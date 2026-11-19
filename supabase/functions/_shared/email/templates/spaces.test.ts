import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { EmailContent } from '../content.ts';
import {
  SPACES_TEMPLATES,
  spaceArchived,
  spaceInvite,
  spaceInviteAccepted,
  spaceMemberRemoved,
} from './spaces.ts';

type AnyTemplate = {
  id: string;
  category: string;
  trigger: string;
  required: ReadonlyArray<string>;
  build: (data: Record<string, unknown>) => EmailContent;
  sample: Record<string, unknown>;
};

const templates = SPACES_TEMPLATES as unknown as ReadonlyArray<AnyTemplate>;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INJECTED = '<b onclick="x()">Mallory</b>';

/** Every plain-text string an email's content carries, blocks included. */
function contentStrings(content: EmailContent): string[] {
  const out = [content.subject, content.preheader, content.heading, content.reason];
  if (content.manageUrl !== undefined) out.push(content.manageUrl);
  for (const block of content.blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'quote':
      case 'note':
        out.push(block.text);
        break;
      case 'code':
        out.push(block.value);
        break;
      case 'button':
        out.push(block.href, block.label);
        break;
      case 'details':
        for (const row of block.rows) out.push(row.label, row.value);
        break;
    }
  }
  return out;
}

/** Runs the checks every template must pass, whatever its file. */
function checkTemplates(list: ReadonlyArray<AnyTemplate>, category: string): void {
  Deno.test(`${category}: ids are kebab-case and unique`, () => {
    const ids = list.map((t) => t.id);
    for (const id of ids) assert(KEBAB.test(id), `${id} is not kebab-case`);
    assertEquals(new Set(ids).size, ids.length);
  });

  for (const t of list) {
    Deno.test(`${t.id}: category and trigger`, () => {
      assertEquals(t.category, category);
      assert(t.trigger.trim().length > 0);
    });

    Deno.test(`${t.id}: sample builds with a short subject`, () => {
      const c = t.build(t.sample);
      assert(c.subject.trim().length > 0);
      assert(c.preheader.trim().length > 0);
      assert(c.heading.trim().length > 0);
      assert(c.reason.trim().length > 0);
      assert(c.blocks.length > 0);
      assert(c.subject.length < 78, `subject is ${c.subject.length} chars`);
    });

    Deno.test(`${t.id}: required keys are in the sample`, () => {
      for (const key of t.required) {
        assert(key in t.sample, `${key} missing from sample`);
      }
    });

    Deno.test(`${t.id}: builds with only the required keys`, () => {
      const minimal = Object.fromEntries(t.required.map((k) => [k, t.sample[k]]));
      const c = t.build(minimal);
      for (const s of contentStrings(c)) assert(!s.includes('undefined'), s);
    });

    Deno.test(`${t.id}: never produces markup of its own`, () => {
      for (const s of contentStrings(t.build(t.sample))) {
        assert(!/[<>]/.test(s), `markup in: ${s}`);
      }
      const hostile = Object.fromEntries(
        Object.entries(t.sample).map(([k, v]) => [k, typeof v === 'string' ? INJECTED : v]),
      );
      for (const s of contentStrings(t.build(hostile))) {
        assert(!/[<>]/.test(s.split(INJECTED).join('')), `markup added around data: ${s}`);
      }
    });
  }
}

/** The catalog's required keys per id, so `required` cannot silently drift from it. */
const DECLARED_REQUIRED: Record<string, ReadonlyArray<string>> = {
  'space-invite': ['inviterName', 'spaceName', 'spaceKind', 'role', 'acceptUrl', 'expiresLabel'],
  'space-invite-accepted': ['memberName', 'spaceName', 'spaceUrl', 'manageUrl'],
  'space-member-removed': ['spaceName', 'removedByName'],
  'space-ownership-transferred': ['spaceName', 'previousOwnerName', 'spaceUrl'],
  'space-archived': ['spaceName', 'archivedByName'],
};

checkTemplates(templates, 'spaces');

Deno.test('spaces: required matches the catalog', () => {
  assertEquals(templates.map((t) => t.id).sort(), Object.keys(DECLARED_REQUIRED).sort());
  for (const t of templates) {
    assertEquals([...t.required].sort(), [...DECLARED_REQUIRED[t.id]].sort());
  }
});

Deno.test('space-invite: one Accept button, expiry and an ignore-this note', () => {
  const c = spaceInvite.build(spaceInvite.sample);
  const buttons = c.blocks.filter((b) => b.kind === 'button');
  assertEquals(buttons.length, 1);
  assertEquals(buttons[0].kind === 'button' && buttons[0].label, 'Accept invitation');
  const details = c.blocks.find((b) => b.kind === 'details');
  assert(details?.kind === 'details' && details.rows.some((r) => r.value === 'in 7 days'));
  assert(contentStrings(c).some((s) => s.includes("If you don't know Maya, ignore this")));
});

Deno.test('space-invite: says how to accept -- open the link, sign in with a six-digit code', () => {
  const c = spaceInvite.build(spaceInvite.sample);
  assert(c.blocks.some((b) => b.kind === 'note'
    && b.text === "Open the link, then sign in with this email address — we'll send you a six-digit code."));
  const button = c.blocks.find((b) => b.kind === 'button');
  assertEquals(button?.kind === 'button' && button.href, spaceInvite.sample.acceptUrl);
});

Deno.test('space-invite-accepted: a notification with a manage link', () => {
  const c = spaceInviteAccepted.build(spaceInviteAccepted.sample);
  assertEquals(c.manageUrl, spaceInviteAccepted.sample.manageUrl);
  assert(c.reason.startsWith('You got this because'));
});

Deno.test('removed and archived emails have no button', () => {
  for (const c of [
    spaceMemberRemoved.build(spaceMemberRemoved.sample),
    spaceArchived.build(spaceArchived.sample),
  ]) {
    assert(!c.blocks.some((b) => b.kind === 'button'), c.subject);
  }
});
