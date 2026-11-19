import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { EmailContent } from '../content.ts';
import { SECURITY_TEMPLATES, securityIdentityLinked, securityMfaEnrolled } from './security.ts';

Deno.test('every security template builds its sample: what changed, what to do, no button', () => {
  assertEquals(SECURITY_TEMPLATES.length, 7);
  for (const template of SECURITY_TEMPLATES) {
    assert(template.id.startsWith('security-'), template.id);
    assertEquals(template.category, 'security');
    assert(template.trigger.startsWith('Supabase Auth: '), template.id);
    const content = (template.build as (d: unknown) => EmailContent)(template.sample);
    assert(content.subject && content.preheader && content.heading, template.id);
    assert(content.reason.startsWith('You got this because'), template.id);
    assert(!content.blocks.some((b) => b.kind === 'button' || b.kind === 'code'), template.id);
    const text = JSON.stringify(content);
    assertStringIncludes(text, 'reset your password from the Bob sign-in page');
    assertStringIncludes(text, 'reply to this email');
    for (const key of template.required) assert(key in template.sample, `${template.id}.${key}`);
  }
});

Deno.test('ids are unique', () => {
  const ids = SECURITY_TEMPLATES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test('provider and factor ids read as people would say them, and blank is unknown', () => {
  assertStringIncludes(JSON.stringify(securityIdentityLinked.build({ provider: 'google' })), 'Google');
  assertStringIncludes(JSON.stringify(securityIdentityLinked.build({ provider: '' })), 'Unknown');
  assertStringIncludes(JSON.stringify(securityMfaEnrolled.build({ factorType: 'totp' })), 'Authenticator app');
  assertStringIncludes(JSON.stringify(securityMfaEnrolled.build({ factorType: 'weird' })), 'weird');
});
