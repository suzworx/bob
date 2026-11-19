/**
 * notify-email: app notification mail, sent on the API's behalf. The contract
 * and every rule live in handler.ts; this file only wires the real pieces.
 */
import { findTemplate } from "../_shared/email/catalog.ts";
import { renderEmail } from "../_shared/email/render.ts";
import { required, sendMail } from "../_shared/mailer.ts";
import { createHandler } from "./handler.ts";

Deno.serve(createHandler({
  secret: required("NOTIFY_EMAIL_SECRET"),
  findTemplate,
  render: renderEmail,
  // No BCC: these are ordinary notifications, not credentials to audit.
  send: (message) => sendMail(message),
}));
