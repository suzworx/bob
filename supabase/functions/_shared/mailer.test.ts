import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import nodemailer from 'npm:nodemailer@^9';
const transports: { config: Record<string, unknown>; mails: Record<string, unknown>[] }[] = [];
nodemailer.createTransport = ((config: Record<string, unknown>) => {
  const entry = { config, mails: [] as Record<string, unknown>[] };
  transports.push(entry);
  return { sendMail: async (mail: Record<string, unknown>) => { entry.mails.push(mail); } };
}) as typeof nodemailer.createTransport;
Deno.env.set('BOB_SMTP_USERNAME', 'bob@example.com');
Deno.env.set('BOB_SMTP_PASSWORD', 'bob-test');
Deno.env.delete('BOB_SMTP_FROM');
Deno.env.delete('BOB_SMTP_HOST');
Deno.env.delete('BOB_SMTP_PORT');
const { sendMail } = await import('./mailer.ts');
const content = { to: 'maya@example.com', subject: 'test', text: 'test', html: 'test' };
const allMails = (): Record<string, unknown>[] => transports.flatMap((t) => t.mails);

Deno.test('every message leaves through the one Bob mailbox, sent as Bob', async () => {
  await sendMail({ ...content, replyTo: 'support@example.com' });
  await sendMail({ ...content, bcc: 'audit@example.com' });
  assertEquals(transports.length, 1);
  assertEquals(transports[0].config, { host: 'smtp.purelymail.com', port: 465, secure: true, auth: { user: 'bob@example.com', pass: 'bob-test' } });
  assertEquals(transports[0].mails[0].from, { name: 'Bob', address: 'bob@example.com' });
  assertEquals(transports[0].mails[0].replyTo, 'support@example.com');
  assertEquals(transports[0].mails[0].bcc, undefined);
  assertEquals(transports[0].mails[1].bcc, 'audit@example.com');
  Deno.env.set('BOB_SMTP_FROM', 'hello@example.com');
  try {
    await sendMail(content);
    assertEquals(allMails().at(-1)?.from, { name: 'Bob', address: 'hello@example.com' });
  } finally {
    Deno.env.delete('BOB_SMTP_FROM');
  }
});

Deno.test('a missing Bob secret fails closed even after a cached send', async () => {
  const before = allMails().length;
  for (const name of ['BOB_SMTP_PASSWORD', 'BOB_SMTP_USERNAME']) {
    const saved = Deno.env.get(name);
    Deno.env.delete(name);
    try {
      await assertRejects(() => sendMail(content), Error, name);
    } finally {
      if (saved !== undefined) Deno.env.set(name, saved);
    }
  }
  assertEquals(allMails().length, before);
});

Deno.test('host and port come from env, and only port 465 is implicit TLS', async () => {
  const { sendMail: fresh } = await import(`./mailer.ts?env=${crypto.randomUUID()}`);
  Deno.env.set('BOB_SMTP_HOST', 'smtp.example.com');
  Deno.env.set('BOB_SMTP_PORT', '587');
  try {
    await fresh(content);
    assertEquals(transports.at(-1)?.config, { host: 'smtp.example.com', port: 587, secure: false, auth: { user: 'bob@example.com', pass: 'bob-test' } });
  } finally {
    Deno.env.delete('BOB_SMTP_HOST');
    Deno.env.delete('BOB_SMTP_PORT');
  }
});
