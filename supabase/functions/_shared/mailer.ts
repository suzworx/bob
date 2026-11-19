/**
 * The one SMTP transport every function sends through: the Bob PurelyMail
 * mailbox (BOB_SMTP_*). There is no second mailbox to fall back to.
 *
 * nodemailer rather than a Deno SMTP library: it is what Supabase's own
 * send-email-smtp example uses, and raw SMTP from an edge runtime is exactly
 * the place not to be the first person trying a library.
 */
import nodemailer from "npm:nodemailer@^9";

/** Required secret, or a loud failure rather than a silent misfire. */
export function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing Edge Function secret: ${name}`);
  return value;
}

const DEFAULT_SMTP_HOST = "smtp.purelymail.com";
/** Implicit TLS; any other port (587) is STARTTLS. */
const IMPLICIT_TLS_PORT = 465;

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;

function getTransport() {
  // Read on every send, so a removed secret fails closed even after a cached send.
  const user = required("BOB_SMTP_USERNAME");
  const pass = required("BOB_SMTP_PASSWORD");
  const port = Number(Deno.env.get("BOB_SMTP_PORT") || IMPLICIT_TLS_PORT);
  transport ??= nodemailer.createTransport({
    host: Deno.env.get("BOB_SMTP_HOST") || DEFAULT_SMTP_HOST,
    port,
    secure: port === IMPLICIT_TLS_PORT,
    auth: { user, pass },
  });
  return transport;
}

/**
 * Sends one message. Rejects on failure -- every caller turns that into a
 * non-2xx, because a send that silently did not happen is the one outcome
 * worth never reporting as success.
 */
export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Omit to skip the BCC (the waitlist does: see its README). */
  bcc?: string;
  /** Where a reply goes, when that is not the sender. */
  replyTo?: string;
}): Promise<void> {
  const mailer = getTransport();
  const address = Deno.env.get("BOB_SMTP_FROM") || required("BOB_SMTP_USERNAME");
  await mailer.sendMail({
    from: { name: "Bob", address },
    to: options.to,
    ...(options.bcc ? { bcc: options.bcc } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    subject: options.subject,
    text: options.text,
    html: options.html,
  });
}
