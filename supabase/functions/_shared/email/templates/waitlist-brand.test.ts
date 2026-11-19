import { assertStringIncludes } from 'jsr:@std/assert@1';
import { renderEmail } from '../render.ts';
import { waitlistCode, waitlistJoined, waitlistAdminJoined } from './waitlist.ts';
Deno.test('waitlist email branding is Bob in both alternatives', () => {
  for (const content of [waitlistCode.build({ code: '123456', ttlMinutes: 10 }), waitlistJoined.build({}), waitlistAdminJoined.build(waitlistAdminJoined.sample)]) {
    const mail = renderEmail(content);
    assertStringIncludes(mail.subject, 'Bob');
    for (const body of [mail.html, mail.text]) {
      assertStringIncludes(body, 'Bob');
      assertStringIncludes(body, 'www.heybob.xyz');
    }
  }
});
