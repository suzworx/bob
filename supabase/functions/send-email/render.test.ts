import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  confirmationUrl,
  type EmailActionType,
  type EmailData,
  planAuthEmails,
  renderAuthEmail,
} from "./render.ts";

const PROJECT = "https://proj.supabase.co";
const USER = { email: "maya@example.com" };

function payload(type: string, extra: Partial<EmailData> = {}): EmailData {
  return {
    token: "123456",
    token_hash: "hash-abc",
    redirect_to: "https://example.com/app",
    site_url: "https://example.com",
    email_action_type: type,
    ...extra,
  };
}

const ALL: EmailActionType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
  "reauthentication",
  "password_changed_notification",
  "email_changed_notification",
  "phone_changed_notification",
  "identity_linked_notification",
  "identity_unlinked_notification",
  "mfa_factor_enrolled_notification",
  "mfa_factor_unenrolled_notification",
];

Deno.test("every action type renders a subject, html and text", () => {
  for (const type of ALL) {
    const { subject, html, text } = renderAuthEmail(payload(type), PROJECT);
    assert(subject.length > 0, type);
    assert(html.includes("<"), type);
    assert(text.length > 0, type);
    assertEquals(planAuthEmails(USER, payload(type), PROJECT).length, 1, type);
  }
});

Deno.test("sign-in carries the code and no verify link", () => {
  for (const type of ["magiclink", "email"]) {
    const { subject, html, text } = renderAuthEmail(payload(type), PROJECT);
    assertStringIncludes(subject + text, "123456");
    assertStringIncludes(html, "123456");
    assert(!html.includes("/auth/v1/verify"), type);
    assert(!text.includes("/auth/v1/verify"), type);
    assert(!html.includes("hash-abc"), type);
  }
});

Deno.test("invite and recovery links are built from the project URL", () => {
  for (const type of ["invite", "recovery"]) {
    const data = payload(type);
    const link = new URL(confirmationUrl(PROJECT, data));
    assertEquals(link.origin + link.pathname, `${PROJECT}/auth/v1/verify`);
    assertEquals(link.searchParams.get("token"), "hash-abc");
    assertEquals(link.searchParams.get("type"), type);
    const { html, text } = renderAuthEmail(data, PROJECT);
    assertStringIncludes(html, `${PROJECT}/auth/v1/verify`);
    assertStringIncludes(text + html, "123456");
  }
});

Deno.test("secure email change yields two messages: token to current, token_new to new", () => {
  const user = { email: "maya@example.com", new_email: "arjun@example.com" };
  const sent = planAuthEmails(user, payload("email_change", { token: "111111", token_new: "222222" }), PROJECT);
  assertEquals(sent.map((m) => m.to), ["maya@example.com", "arjun@example.com"]);
  assertStringIncludes(sent[0].text, "111111");
  assertStringIncludes(sent[0].text, "arjun@example.com");
  assert(!sent[0].text.includes("222222"));
  assertStringIncludes(sent[1].text, "222222");
  assert(!sent[1].text.includes("111111"));
});

Deno.test("email change with one OTP goes to the new address only", () => {
  const user = { email: "maya@example.com", new_email: "arjun@example.com" };
  const sent = planAuthEmails(user, payload("email_change", { token: "", token_new: "333333" }), PROJECT);
  assertEquals(sent.map((m) => m.to), ["arjun@example.com"]);
  assertStringIncludes(sent[0].text, "333333");
});

Deno.test("notifications read provider and factor from email_data, with an unknown fallback", () => {
  assertStringIncludes(
    renderAuthEmail(payload("identity_linked_notification", { provider: "google" }), PROJECT).text,
    "Google",
  );
  assertStringIncludes(renderAuthEmail(payload("mfa_factor_enrolled_notification"), PROJECT).text, "Unknown");
  const moved = planAuthEmails(
    { email: "arjun@example.com" },
    payload("email_changed_notification", { old_email: "maya@example.com" }),
    PROJECT,
  );
  assertEquals(moved[0].to, "maya@example.com");
  assertStringIncludes(moved[0].text, "arjun@example.com");
});

const BOB = "https://app.heybob.xyz";

Deno.test("sign-in mail is Bob in subject, header, body and footer, whatever the origin", () => {
  for (const redirect_to of [BOB, "https://example.com/app", "not a url", ""]) {
    for (const type of ["magiclink", "email"]) {
      const [mail] = planAuthEmails(USER, payload(type, { redirect_to }), PROJECT);
      assertEquals(mail.subject, "123456 is your Bob sign-in code");
      assertStringIncludes(mail.html, ">Bob</p>");
      assertStringIncludes(mail.text, "Sign in to Bob");
      for (const body of [mail.html, mail.text]) assertStringIncludes(body, "Bob · www.heybob.xyz");
    }
  }
  assertStringIncludes(planAuthEmails(USER, payload("invite"), PROJECT)[0].text, "a Bob admin invited this address");
});

Deno.test("the recovery link still returns to the app", () => {
  const data = payload("recovery", { redirect_to: `${BOB}/reset` });
  const link = new URL(confirmationUrl(PROJECT, data));
  assertEquals(link.origin + link.pathname, `${PROJECT}/auth/v1/verify`);
  assertEquals(link.searchParams.get("redirect_to"), `${BOB}/reset`);
  assertEquals(link.searchParams.get("token"), "hash-abc");
  assertStringIncludes(renderAuthEmail(data, PROJECT).text, link.toString());
});

Deno.test("secure email change keeps the token pairing and recipients", () => {
  const user = { email: "maya@example.com", new_email: "arjun@example.com" };
  const sent = planAuthEmails(
    user,
    payload("email_change", { token: "111111", token_new: "222222", redirect_to: BOB }),
    PROJECT,
  );
  assertEquals(sent.map((m) => m.to), ["maya@example.com", "arjun@example.com"]);
  assertStringIncludes(sent[0].text, "111111");
  assertStringIncludes(sent[0].text, "arjun@example.com");
  assert(!sent[0].text.includes("222222"));
  assertStringIncludes(sent[1].text, "222222");
  assert(!sent[1].text.includes("111111"));
});

Deno.test("an unknown action type renders a generic notice instead of throwing", () => {
  const { subject, text } = renderAuthEmail(payload("brand_new_thing_notification"), PROJECT);
  assertStringIncludes(subject, "change");
  assertStringIncludes(text, "brand new thing");
});
