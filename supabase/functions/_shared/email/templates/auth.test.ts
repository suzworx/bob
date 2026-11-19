import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { Block, EmailContent } from '../content.ts';
import {
  AUTH_TEMPLATES,
  authAccountInvite,
  authEmailChangeCurrent,
  authPasswordReset,
  authSignInCode,
} from './auth.ts';

const kinds = (content: EmailContent): string[] => content.blocks.map((b: Block) => b.kind);
const allText = (content: EmailContent): string => JSON.stringify(content);

Deno.test('every auth template builds its sample with a reason and a trigger', () => {
  assertEquals(AUTH_TEMPLATES.length, 7);
  for (const template of AUTH_TEMPLATES) {
    assert(template.id.startsWith('auth-'), template.id);
    assertEquals(template.category, 'auth');
    assert(template.trigger.startsWith('Supabase Auth: '), template.id);
    const content = (template.build as (d: unknown) => EmailContent)(template.sample);
    assert(content.subject && content.preheader && content.heading, template.id);
    assert(content.reason.startsWith('You got this because'), template.id);
    for (const key of template.required) assert(key in template.sample, `${template.id}.${key}`);
  }
});

Deno.test('ids are unique', () => {
  const ids = AUTH_TEMPLATES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test('sign-in is a code with no link and no button', () => {
  const content = authSignInCode.build({ code: '123456' });
  assertEquals(content.heading, 'Sign in to Bob');
  assert(kinds(content).includes('code'));
  assert(!kinds(content).includes('button'));
  assert(!allText(content).includes('http'));
  assertStringIncludes(allText(content), 'expires in an hour and works once');
  assertStringIncludes(allText(content), 'ignore this email');
});

Deno.test('invite and reset carry a button plus the code as a fallback note', () => {
  const invite = authAccountInvite.build({ acceptUrl: 'https://example.com/a', code: '111222' });
  assertEquals(invite.heading, 'You’re invited to Bob');
  assertEquals(invite.blocks.find((b) => b.kind === 'button'), {
    kind: 'button',
    href: 'https://example.com/a',
    label: 'Accept invite',
  });
  assert(invite.blocks.some((b) => b.kind === 'note' && b.text.includes('111222')));

  const reset = authPasswordReset.build({ resetUrl: 'https://example.com/r', code: '333444' });
  assert(reset.blocks.some((b) => b.kind === 'button' && b.href === 'https://example.com/r'));
  assert(reset.blocks.some((b) => b.kind === 'note' && b.text.includes('333444')));
});

Deno.test('email change to the current address names the new one and how to stop it', () => {
  const content = authEmailChangeCurrent.build({ code: '555666', newEmail: 'arjun@example.com' });
  assertStringIncludes(allText(content), 'arjun@example.com');
  assert(kinds(content).includes('code'));
  assertStringIncludes(allText(content), 'reply to this email');
});
