/**
 * invite-account: a confirmed account for an invited address. The contract
 * and every rule live in handler.ts; this file only wires the real pieces.
 * It never sends email -- the API sends the space-invite mail itself.
 */
import { createClient, isAuthApiError } from "jsr:@supabase/supabase-js@2";
import { required } from "../_shared/mailer.ts";
import { createHandler } from "./handler.ts";

/** GoTrue's codes for "this address already has an account". */
const EXISTS_CODES = new Set(["email_exists", "user_already_exists"]);

function admin() {
  // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
  return createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  ).auth.admin;
}

async function createUser(email: string): Promise<"created" | "exists"> {
  // email_confirm: the invitee signs in with an emailed code straight away;
  // signups stay off, so this is the only way an invited address gets in.
  const { error } = await admin().createUser({ email, email_confirm: true });
  if (!error) return "created";
  if (isAuthApiError(error) && EXISTS_CODES.has(error.code ?? "")) {
    return "exists";
  }
  throw error;
}

Deno.serve(createHandler({
  // The ONE shared API -> functions bearer (also gates notify-email), so the
  // owner has no new secret to manage.
  secret: required("NOTIFY_EMAIL_SECRET"),
  createUser,
}));
