import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import type { EmailContent } from '../content.ts';
import {
  ACCOUNT_TEMPLATES,
  bobAccountInvite,
  accountDeleted,
  devicePaired,
  deviceRemoved,
  googleAccountLinked,
  googleAccountUnlinked,
} from './account.ts';

const NOT_YOU = "If this wasn't you, sign in and remove it, or reply to this email.";

type Built = ReturnType<(typeof ACCOUNT_TEMPLATES)[number]['build']>;

function buildSample(template: (typeof ACCOUNT_TEMPLATES)[number]): Built {
  return (template.build as (data: unknown) => Built)(template.sample);
}

function allText(content: EmailContent): string {
  return JSON.stringify(content);
}

Deno.test('account templates carry the catalog ids, in the account category', () => {
  assertEquals(
    ACCOUNT_TEMPLATES.map((t) => t.id),
    ['account-deleted', 'google-account-linked', 'google-account-unlinked', 'device-paired', 'device-removed', 'bob-account-invite'],
  );
  for (const template of ACCOUNT_TEMPLATES) assertEquals(template.category, 'account');
});

Deno.test('every required key is present in the sample, and samples are fictional', () => {
  for (const template of ACCOUNT_TEMPLATES) {
    const sample = template.sample as Record<string, unknown>;
    for (const key of template.required) assert(typeof sample[key] === 'string', `${template.id}.${key}`);
    for (const value of Object.values(sample)) {
      if (typeof value === 'string' && value.includes('@')) assert(value.endsWith('@example.com'), template.id);
    }
  }
});

Deno.test('every template builds complete, plain-text content', () => {
  for (const template of ACCOUNT_TEMPLATES) {
    const content = buildSample(template);
    assert(content.subject.length > 0 && content.preheader.length > 0 && content.heading.length > 0, template.id);
    assert(content.reason.length > 0, template.id);
    assert(content.blocks.length > 0, template.id);
    assert(!/<[a-z]/i.test(allText(content)), `${template.id} must not produce HTML`);
  }
});

Deno.test('linked and paired offer one review button to manageUrl', () => {
  const linked = googleAccountLinked.build(googleAccountLinked.sample);
  assertEquals(linked.blocks.filter((b) => b.kind === 'button'), [
    { kind: 'button', href: googleAccountLinked.sample.manageUrl, label: 'Review connected accounts' },
  ]);
  const paired = devicePaired.build(devicePaired.sample);
  assertEquals(paired.blocks.filter((b) => b.kind === 'button'), [
    { kind: 'button', href: devicePaired.sample.manageUrl, label: 'Review devices' },
  ]);
});

Deno.test('security notices name what changed and say what to do if it was not you', () => {
  const cases = [
    [googleAccountLinked.build({ googleEmail: 'arjun@example.com', manageUrl: 'https://x.example.com' }), 'arjun@example.com'],
    [googleAccountUnlinked.build({ googleEmail: 'arjun@example.com' }), 'arjun@example.com'],
    [devicePaired.build({ deviceName: 'Desk unit', manageUrl: 'https://x.example.com' }), 'Desk unit'],
    [deviceRemoved.build({ deviceName: 'Desk unit' }), 'Desk unit'],
  ] as const;
  for (const [content, subject] of cases as ReadonlyArray<readonly [EmailContent, string]>) {
    assertStringIncludes(allText(content), subject);
    assertStringIncludes(allText(content), NOT_YOU);
  }
});

Deno.test('unlinked and removed have no button', () => {
  for (const content of <EmailContent[]>[
    googleAccountUnlinked.build(googleAccountUnlinked.sample),
    deviceRemoved.build(deviceRemoved.sample),
  ]) {
    assertEquals(content.blocks.filter((b) => b.kind === 'button').length, 0);
  }
});

Deno.test('account-deleted is final: says it cannot be undone, and has no button', () => {
  const content: EmailContent = accountDeleted.build(accountDeleted.sample);
  assertEquals(content.blocks.filter((b) => b.kind === 'button').length, 0);
  assertStringIncludes(allText(content), 'cannot be undone');
  assert(!('manageUrl' in content));
});

Deno.test('Bob invitation uses a fixed sign-in URL and no caller content', () => {
  const content = bobAccountInvite.build({});
  assertEquals(content.subject, "You're invited to Bob");
  const buttons = content.blocks.filter(block => block.kind === 'button');
  assertEquals(buttons, [{ kind: 'button', href: 'https://app.heybob.xyz/', label: 'Sign in to Bob' }]);
});