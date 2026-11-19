import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHandler, type NotifyDeps } from "./handler.ts";
import { findTemplate } from "../_shared/email/catalog.ts";
import { renderEmail } from "../_shared/email/render.ts";

const SECRET = "test-secret";

type Sent = { to: string; subject: string; html: string; text: string };

const invite = {
  id: "space-invite-accepted",
  category: "spaces",
  trigger: "test",
  required: ["memberName", "spaceName"],
  build: (d: Record<string, unknown>) => ({
    subject: `${d.memberName} joined ${d.spaceName}`,
    preheader: "",
    heading: "",
    blocks: [],
    reason: "",
  }),
  sample: { memberName: "Maya", spaceName: "Home" },
} as const;

function setup(opts: { sendFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const lines: string[] = [];
  const deps = {
    secret: SECRET,
    findTemplate: (id: string) => {
      if (id === invite.id) return invite;
      // A catalog that knew auth ids must still never have them served.
      if (id.startsWith("auth-")) return { ...invite, id };
      return undefined;
    },
    render: (c: { subject: string }) => ({
      subject: c.subject,
      html: "<p>html</p>",
      text: "text",
    }),
    send: (m: Sent) => {
      if (opts.sendFails) return Promise.reject(new Error("smtp down"));
      sent.push(m);
      return Promise.resolve();
    },
    log: (line: string) => lines.push(line),
  } as unknown as NotifyDeps;
  return { handler: createHandler(deps), sent, lines };
}

const good = {
  template: "space-invite-accepted",
  to: "arjun@example.com",
  data: { memberName: "Maya", spaceName: "Home" },
};

function post(
  body: unknown,
  auth: string | null = `Bearer ${SECRET}`,
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth !== null) headers.authorization = auth;
  return new Request("http://localhost/notify-email", {
    method,
    headers,
    body: method === "GET"
      ? undefined
      : typeof body === "string"
      ? body
      : JSON.stringify(body),
  });
}

async function call(
  handler: (r: Request) => Promise<Response>,
  req: Request,
): Promise<unknown[]> {
  const res = await handler(req);
  return [res.status, await res.json()];
}

Deno.test("200 happy path passes the rendered subject to send", async () => {
  const { handler, sent, lines } = setup();
  assertEquals(await call(handler, post(good)), [200, { ok: true }]);
  assertEquals(sent, [{
    to: "arjun@example.com",
    subject: "Maya joined Home",
    html: "<p>html</p>",
    text: "text",
  }]);
  assertEquals(lines, [
    "notify-email template=space-invite-accepted outcome=sent",
  ]);
});

Deno.test("401 on a wrong or missing bearer", async () => {
  const { handler, sent } = setup();
  const denied = [401, { ok: false, error: "unauthorized" }];
  assertEquals(await call(handler, post(good, "Bearer nope")), denied);
  assertEquals(await call(handler, post(good, null)), denied);
  assertEquals(await call(handler, post(good, SECRET)), denied);
  assertEquals(sent.length, 0);
});

Deno.test("405 on anything but POST", async () => {
  const { handler } = setup();
  const [status] = await call(handler, post(null, undefined, "GET"));
  assertEquals(status, 405);
});

Deno.test("400 bad_request on malformed input", async () => {
  const { handler } = setup();
  const bad = [400, { ok: false, error: "bad_request" }];
  assertEquals(await call(handler, post("{not json")), bad);
  assertEquals(await call(handler, post([good])), bad);
  assertEquals(await call(handler, post({ ...good, to: "nobody" })), bad);
  assertEquals(await call(handler, post({ ...good, data: "x" })), bad);
  const long = `${"a".repeat(250)}@example.com`;
  assertEquals(await call(handler, post({ ...good, to: long })), bad);
});

Deno.test("400 bad_request on an oversized body", async () => {
  const { handler, sent } = setup();
  const data = { ...good.data, padding: "x".repeat(17 * 1024) };
  assertEquals(await call(handler, post({ ...good, data })), [
    400,
    { ok: false, error: "bad_request" },
  ]);
  assertEquals(sent.length, 0);
});

Deno.test("400 unknown_template, including refused auth ids", async () => {
  const { handler, sent } = setup();
  const unknown = [400, { ok: false, error: "unknown_template" }];
  for (const template of ["no-such-template", "auth-sign-in-code"]) {
    assertEquals(await call(handler, post({ ...good, template })), unknown);
  }
  assertEquals(sent.length, 0);
});

Deno.test("400 missing_field when a required key is absent or empty", async () => {
  const { handler } = setup();
  const missing = [400, { ok: false, error: "missing_field" }];
  const absent = { ...good, data: { memberName: "Maya" } };
  const empty = { ...good, data: { memberName: "Maya", spaceName: " " } };
  assertEquals(await call(handler, post(absent)), missing);
  assertEquals(await call(handler, post(empty)), missing);
});

Deno.test("502 send_failed when send throws", async () => {
  const { handler, lines } = setup({ sendFails: true });
  assertEquals(await call(handler, post(good)), [
    502,
    { ok: false, error: "send_failed" },
  ]);
  assertEquals(lines, [
    "notify-email template=space-invite-accepted outcome=send_failed",
  ]);
});

Deno.test('Bob invitation accepts only its fixed, data-free template', async () => {
  const sent: Sent[] = [];
  const handler = createHandler({
    secret: SECRET,
    findTemplate: () => ({ ...invite, id: 'bob-account-invite', required: [] }),
    render: () => ({ subject: 'Bob', html: '<p>Bob</p>', text: 'Bob' }),
    send: message => { sent.push(message); return Promise.resolve(); },
    log: () => undefined,
  });
  assertEquals((await handler(post({ template: 'bob-account-invite', to: 'person@example.com', data: {} }))).status, 200);
  assertEquals(sent, [{ to: 'person@example.com', subject: 'Bob', html: '<p>Bob</p>', text: 'Bob' }]);
  assertEquals((await handler(post({ template: 'bob-account-invite', to: 'person@example.com', data: { url: 'https://evil.test' } }))).status, 400);
  assertEquals(sent.length, 1);
});

Deno.test('Bob message sends through the one mailbox with no sender override', async () => {
  const sent: Sent[] = [];
  const lines: string[] = [];
  const handler = createHandler({
    secret: SECRET,
    findTemplate,
    render: renderEmail,
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    log: (line) => lines.push(line),
  });
  const data = {
    noteTitle: 'Private note title',
    noteBody: 'Private note body',
    noteUrl: 'https://app.example.com/spaces/private/notes?note=note-123',
    manageUrl: 'https://app.example.com/settings#notifications',
  };

  assertEquals((await handler(post({
    template: 'bob-message',
    to: 'person@example.com',
    data,
  }))).status, 200);
  const chatInvite = findTemplate('chat-invite');
  assert(chatInvite);
  assertEquals((await handler(post({
    template: 'chat-invite',
    to: 'person@example.com',
    data: chatInvite.sample,
  }))).status, 200);
  assertEquals(sent.length, 2);
  assert(sent.every((message) => !('profile' in message)));
  assertEquals(lines, [
    'notify-email template=bob-message outcome=sent',
    'notify-email template=chat-invite outcome=sent',
  ]);
  assertEquals(lines.join('\n').includes(data.noteTitle), false);
  assertEquals(lines.join('\n').includes(data.noteBody), false);
  assertEquals(lines.join('\n').includes(data.noteUrl), false);
  assertEquals(lines.join('\n').includes('person@example.com'), false);
});