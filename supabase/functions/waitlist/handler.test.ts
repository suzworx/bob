import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import nodemailer from 'npm:nodemailer@^9';
const mails: Record<string, unknown>[] = [];
let fail = false;
let failTo = '';
const attempts: Record<string, unknown>[] = [];
nodemailer.createTransport = (() => ({ sendMail: (mail: Record<string, unknown>) => {
  attempts.push(mail);
  if (fail || mail.to === failTo) return Promise.reject(new Error('simulated'));
  mails.push(mail);
  return Promise.resolve();
} })) as typeof nodemailer.createTransport;
Deno.env.set('BOB_SMTP_USERNAME', 'bob@example.com');
Deno.env.set('BOB_SMTP_PASSWORD', 'bob-test');
Deno.env.set('SUPABASE_URL', 'https://example.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
Deno.env.set('WAITLIST_CODE_PEPPER', 'test-pepper');
Deno.env.set('WAITLIST_NOTIFY_EMAIL', 'owner@example.com');
const { handleWaitlist } = await import('./index.ts');
const originalFetch = globalThis.fetch;
let result = 'verified';
const calls: string[] = [];
globalThis.fetch = (input) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url.split('/').at(-1) ?? '');
  return Promise.resolve(new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }));
};
const request = (body: unknown, origin = 'https://www.heybob.xyz') => new Request('https://example.com', {
  method: 'POST', headers: { origin }, body: JSON.stringify(body),
});
Deno.test('exact production and legacy CORS allowlist on preflight and errors', async () => {
  Deno.env.set('WAITLIST_ALLOWED_ORIGIN', 'https://legacy.example.com');
  for (const origin of ['https://www.heybob.xyz', 'https://www.heybob.xyz', 'https://legacy.example.com', 'https://www.heybob.xyz.evil.test', 'null']) {
    for (const req of [new Request('https://example.com', { method: 'OPTIONS', headers: { origin } }), request({}, origin)]) {
      const response = await handleWaitlist(req);
      assertEquals(response.headers.get('access-control-allow-origin'), origin.endsWith('evil.test') || origin === 'null' ? null : origin);
      assertEquals(response.headers.get('vary'), 'Origin');
    }
  }
});
Deno.test('valid returning subscribers succeed without another welcome', async () => {
  mails.length = 0;
  for (const status of ['rejected', 'already_verified', 'verified']) {
    result = status;
    const response = await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: '123456' }));
    assertEquals(await response.json(), { ok: true, verified: status !== 'rejected' });
  }
  assertEquals(mails.length, 2);
  assertEquals(mails.map(mail => mail.to).sort(), ['maya@example.com', 'owner@example.com']);
  assertEquals((mails[0].from as { name: string }).name, 'Bob');
  assertStringIncludes(String(mails[0].subject), 'Bob');
});
Deno.test('SMTP failure releases generation for retry; cooldown sends nothing', async () => {
  result = 'sent:00000000-0000-0000-0000-000000000001'; fail = true; calls.length = 0;
  const response = await handleWaitlist(request({ action: 'request', email: 'maya@example.com', source: 'bob_landing' }));
  assertEquals(response.status, 502);
  assertEquals(calls, ['waitlist_begin', 'waitlist_send_failed']);
  fail = false; mails.length = 0; result = 'cooldown';
  assertEquals((await handleWaitlist(request({ action: 'request', email: 'maya@example.com' }))).status, 200);
  assertEquals(mails.length, 0);
  result = 'sent:00000000-0000-0000-0000-000000000002';
  assertEquals((await handleWaitlist(request({ action: 'request', email: 'maya@example.com' }))).status, 200);
  assertEquals(mails.length, 1);
});
Deno.test('welcome failure does not undo verification', async () => {
  result = 'verified'; fail = true;
  assertEquals(await (await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: '123456' }))).json(), { ok: true, verified: true });
  fail = false;
});
Deno.test('admin notification excludes credentials and runs even when the welcome fails', async () => {
  result = 'verified'; mails.length = 0; attempts.length = 0; failTo = 'maya@example.com';
  try {
    assertEquals(await (await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: '123456' }))).json(), { ok: true, verified: true });
    assertEquals(attempts.length, 2);
    assertEquals(mails.length, 1);
    assertEquals(mails[0].to, 'owner@example.com');
    for (const body of [String(mails[0].html), String(mails[0].text)]) {
      assertStringIncludes(body, 'maya@example.com');
      assertStringIncludes(body, 'https://app.heybob.xyz/admin');
      assertEquals(body.includes('123456'), false);
      assertEquals(body.includes('test-pepper'), false);
    }
  } finally { failTo = ''; }
});
Deno.test('admin delivery or missing-recipient failure cannot undo verification or suppress the welcome', async () => {
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    for (const recipient of ['owner@example.com', undefined, 'bad-recipient']) {
      result = 'verified'; mails.length = 0; failTo = recipient === 'owner@example.com' ? recipient : '';
      if (recipient === undefined) Deno.env.delete('WAITLIST_NOTIFY_EMAIL');
      else Deno.env.set('WAITLIST_NOTIFY_EMAIL', recipient);
      assertEquals(await (await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: '123456' }))).json(), { ok: true, verified: true });
      assertEquals(mails.length, 1);
      assertEquals(mails[0].to, 'maya@example.com');
    }
    assertEquals(logs, Array.from({ length: 3 }, () => ['waitlist: admin notification failed']));
  } finally { console.error = originalError; failTo = ''; Deno.env.set('WAITLIST_NOTIFY_EMAIL', 'owner@example.com'); }
});
Deno.test('invalid verification input and code requests never notify the admin', async () => {
  mails.length = 0; result = 'rejected';
  await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: 'bad' }));
  await handleWaitlist(request({ action: 'verify', email: 'maya@example.com', code: '123456' }));
  result = 'sent:00000000-0000-0000-0000-000000000003';
  await handleWaitlist(request({ action: 'request', email: 'maya@example.com' }));
  assertEquals(mails.map(mail => mail.to), ['maya@example.com']);
});
Deno.test('restore fetch', () => { globalThis.fetch = originalFetch; });

Deno.test('shared mailer sends every message as Bob', async () => {
  const { sendMail } = await import('../_shared/mailer.ts');
  mails.length = 0;
  await sendMail({ to: 'maya@example.com', subject: 'test', text: 'test', html: 'test' });
  assertEquals(mails[0].from, { name: 'Bob', address: 'bob@example.com' });
});
