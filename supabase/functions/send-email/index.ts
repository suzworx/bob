/**
 * Supabase Auth "Send Email Hook".
 *
 * With this hook enabled, Supabase stops sending auth mail itself and POSTs
 * each one here instead -- invites, signup confirmations, magic links, OTPs,
 * password resets and the security notifications. This function renders the
 * declared template from `_shared/email` and delivers it over PurelyMail SMTP.
 *
 * Contract with Supabase:
 *   · 200 + {} means "sent". Supabase then does nothing more.
 *   · Any non-2xx means the hook failed, and Supabase surfaces the error to
 *     the caller rather than pretending the mail went out. So a failed
 *     sendMail MUST NOT be swallowed -- see the catch at the bottom.
 *
 * Every secret is read from Edge Function secrets at runtime. Nothing is
 * committed here. Set them with:
 *   supabase secrets set SEND_EMAIL_HOOK_SECRET=... BOB_SMTP_PASSWORD=... ...
 */
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { required, sendMail } from "../_shared/mailer.ts";
import { type EmailData, type HookUser, planAuthEmails } from "./render.ts";

/**
 * Off unless the secret is set: a BCC here is a standing copy of every live
 * sign-in code and reset link (see README).
 */
const BCC = Deno.env.get("AUTH_EMAIL_BCC") ?? "";

/** Non-2xx tells Supabase the hook failed; the body shape is what it logs. */
function failure(message: string, status: number) {
  console.error(`send-email: ${message}`);
  return new Response(
    JSON.stringify({ error: { http_code: status, message } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return failure("Method not allowed", 405);

  const payload = await req.text();

  // 1. Verify the Standard Webhooks signature before trusting a single field.
  //    Unsigned or mis-signed callers must never be able to make us send mail.
  let user: HookUser;
  let email_data: EmailData;
  try {
    const secret = required("SEND_EMAIL_HOOK_SECRET").replace("v1,whsec_", "");
    const wh = new Webhook(secret);
    const verified = wh.verify(payload, Object.fromEntries(req.headers)) as {
      user: HookUser;
      email_data: EmailData;
    };
    user = verified.user;
    email_data = verified.email_data;
  } catch (error) {
    return failure(
      `Signature verification failed: ${
        error instanceof Error ? error.message : error
      }`,
      401,
    );
  }

  if (!user?.email) return failure("Payload carried no recipient", 400);

  // 2. Render every message this action needs -- two for a secure email
  //    change. Recipients and tokens come from Supabase's payload only.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? email_data.site_url;
  const messages = planAuthEmails(user, email_data, supabaseUrl);

  // 3. Send. A failure here must reach Supabase as a non-2xx.
  try {
    for (const { to, subject, text, html } of messages) {
      await sendMail({ to, subject, text, html, bcc: BCC || undefined });
    }
  } catch (error) {
    return failure(
      `SMTP send failed for ${email_data.email_action_type}: ${
        error instanceof Error ? error.message : error
      }`,
      500,
    );
  }

  console.log(
    `send-email: delivered ${email_data.email_action_type} (${messages.length})`,
  );
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
