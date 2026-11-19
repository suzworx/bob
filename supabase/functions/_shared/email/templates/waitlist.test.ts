import { renderEmail } from '../render.ts';
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { EmailContent } from '../content.ts';
import { WAITLIST_TEMPLATES, waitlistCode, waitlistJoined, waitlistAdminJoined } from './waitlist.ts';

Deno.test('waitlist templates carry the catalog ids, in the waitlist category', () => {
  assertEquals(WAITLIST_TEMPLATES.map((t) => t.id), ['waitlist-code', 'waitlist-joined', 'waitlist-admin-joined']);
  for (const template of WAITLIST_TEMPLATES) assertEquals(template.category, 'waitlist');
});

Deno.test('every required key is present in the sample', () => {
  for (const template of WAITLIST_TEMPLATES) {
    const sample = template.sample as Record<string, unknown>;
    for (const key of template.required) assert(sample[key] !== undefined, `${template.id}.${key}`);
  }
});

Deno.test('waitlist-code shows the code as a chip and states the expiry', () => {
  const content: EmailContent = waitlistCode.build({ code: '123456', ttlMinutes: 7 });
  assertStringIncludes(content.subject, '123456');
  assertEquals(content.blocks.filter((b) => b.kind === 'code'), [{ kind: 'code', value: '123456' }]);
  const text = JSON.stringify(content);
  assertStringIncludes(text, 'expires in 7 minutes');
  assertStringIncludes(text, "If you didn't ask to join, ignore this — nothing was created.");
  assertEquals(content.blocks.filter((b) => b.kind === 'button').length, 0);
});

Deno.test('waitlist-joined says what happens next and has no button', () => {
  const content: EmailContent = waitlistJoined.build(waitlistJoined.sample);
  assertStringIncludes(content.heading, "You're on the list");
  assertStringIncludes(JSON.stringify(content), 'invitation');
  assertEquals(content.blocks.filter((b) => b.kind === 'button').length, 0);
});

Deno.test('no template produces HTML', () => {
  for (const template of WAITLIST_TEMPLATES) {
    const content = (template.build as (data: unknown) => unknown)(template.sample);
    assert(!/<[a-z]/i.test(JSON.stringify(content)), template.id);
  }
});

Deno.test('admin notice renders the subscriber safely in both alternatives without credentials', () => {
  const content: EmailContent = waitlistAdminJoined.build({ email: '<script>&"@example.com' });
  const rendered = renderEmail(content);
  assertStringIncludes(rendered.html, '&lt;script&gt;&amp;');
  assert(!rendered.html.includes('<script>'));
  assertStringIncludes(rendered.text, '<script>&"@example.com');
  for (const body of [rendered.text, rendered.html]) assertStringIncludes(body, 'https://app.heybob.xyz/admin');
  assertEquals(content.blocks.filter(block => block.kind === 'code'), []);
  assertEquals(waitlistAdminJoined.required, ['email']);
});
