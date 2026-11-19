/**
 * Maps each Send Email Hook payload onto a declared template in
 * `_shared/email/templates` and renders it through the shared email design
 * system. No markup lives here: the words are in the templates, the look is
 * in `_shared/email/render.ts`.
 */
import type { EmailContent, RenderedEmail } from "../_shared/email/content.ts";
import { renderEmail } from "../_shared/email/render.ts";
import {
  authAccountInvite,
  authEmailChangeCurrent,
  authEmailChangeNew,
  authPasswordReset,
  authReauthenticate,
  authSignInCode,
  authSignupConfirm,
  brandWords,
} from "../_shared/email/templates/auth.ts";
import {
  securityEmailChanged,
  securityIdentityLinked,
  securityIdentityUnlinked,
  securityMfaEnrolled,
  securityMfaUnenrolled,
  securityPasswordChanged,
  securityPhoneChanged,
} from "../_shared/email/templates/security.ts";

/** Every action type the Send Email Hook can deliver (Supabase docs). */
export type EmailActionType =
  | "signup"
  | "invite"
  | "magiclink"
  | "recovery"
  | "email_change"
  | "email"
  | "reauthentication"
  | "password_changed_notification"
  | "email_changed_notification"
  | "phone_changed_notification"
  | "identity_linked_notification"
  | "identity_unlinked_notification"
  | "mfa_factor_enrolled_notification"
  | "mfa_factor_unenrolled_notification";

export interface EmailData {
  token: string;
  token_hash: string;
  redirect_to: string;
  site_url: string;
  email_action_type: EmailActionType | string;
  token_new?: string;
  token_hash_new?: string;
  /** email_changed_notification: the address the account moved away from. */
  old_email?: string;
  /** identity_*_notification: e.g. "google". */
  provider?: string;
  /** mfa_factor_*_notification: e.g. "totp". */
  factor_type?: string;
}

/** The part of the hook's `user` object the renderer reads. */
export interface HookUser {
  email: string;
  new_email?: string;
}

/** One message to send: a recipient and its rendered content. */
type OutgoingEmail = RenderedEmail & { to: string };

/**
 * The verify link Supabase would have built for {{ .ConfirmationURL }}. Built
 * from the project URL rather than site_url: site_url is where the user lands
 * *after* verifying, the auth endpoint lives on the project host.
 */
export function confirmationUrl(supabaseUrl: string, data: EmailData): string {
  const url = new URL(`${supabaseUrl}/auth/v1/verify`);
  url.searchParams.set("token", data.token_hash);
  url.searchParams.set("type", data.email_action_type);
  if (data.redirect_to) url.searchParams.set("redirect_to", data.redirect_to);
  return url.toString();
}

/** A new Supabase action type still gets a notice, never an exception. */
function unknownNotice(actionType: string): EmailContent {
  const what = String(actionType).replace(/_notification$/, "").replace(/_/g, " ").trim() || "unknown";
  const { name } = brandWords;
  return {
    subject: `A change was made to your ${name} account`,
    preheader: `A change was made to your ${name} account.`,
    heading: "Something changed",
    blocks: [
      { kind: "paragraph", text: `A change was just made to your ${name} account.` },
      { kind: "details", rows: [{ label: "Change", value: what }] },
      {
        kind: "note",
        text: `If this wasn’t you, reset your password from the ${name} sign-in page straight away and reply to this email.`,
      },
    ],
    reason: `You got this because a security setting changed on the ${name} account for this address.`,
  };
}

/** Content for a single-message action. email_change here is the new-address copy. */
function contentFor(data: EmailData, supabaseUrl: string, user?: HookUser): EmailContent {
  const code = data.token;
  switch (data.email_action_type) {
    case "magiclink":
    case "email":
      return authSignInCode.build({ code });
    case "signup":
      return authSignupConfirm.build({ code, confirmUrl: confirmationUrl(supabaseUrl, data) });
    case "invite":
      return authAccountInvite.build({ acceptUrl: confirmationUrl(supabaseUrl, data), code });
    case "recovery":
      return authPasswordReset.build({ resetUrl: confirmationUrl(supabaseUrl, data), code });
    case "email_change":
      // Secure change off: one OTP, for the new address, in whichever field is set.
      return authEmailChangeNew.build({ code: data.token_new || code });
    case "reauthentication":
      return authReauthenticate.build({ code });
    case "password_changed_notification":
      return securityPasswordChanged.build({});
    case "email_changed_notification":
      return securityEmailChanged.build({ newEmail: user?.email ?? "" });
    case "phone_changed_notification":
      return securityPhoneChanged.build({});
    case "identity_linked_notification":
      return securityIdentityLinked.build({ provider: data.provider ?? "" });
    case "identity_unlinked_notification":
      return securityIdentityUnlinked.build({ provider: data.provider ?? "" });
    case "mfa_factor_enrolled_notification":
      return securityMfaEnrolled.build({ factorType: data.factor_type ?? "" });
    case "mfa_factor_unenrolled_notification":
      return securityMfaUnenrolled.build({ factorType: data.factor_type ?? "" });
    default:
      return unknownNotice(data.email_action_type);
  }
}

/** Renders one hook payload as a single message. Never throws on an unknown action. */
export function renderAuthEmail(data: EmailData, supabaseUrl: string): RenderedEmail {
  return renderEmail(contentFor(data, supabaseUrl));
}

/** One addressed message; every message leaves through the one mailbox. */
function outgoing(to: string, content: EmailContent): OutgoingEmail {
  return { to, ...renderEmail(content) };
}

/**
 * Every message one hook call should produce, with its recipient.
 *
 * Secure email change: Supabase calls the hook once with two OTPs. Per the
 * Send Email Hook docs, `token` goes to the current address (`user.email`)
 * and `token_new` to the new one (`user.new_email`) -- the `_new` suffix does
 * not name the address. With only one OTP it goes to the new address alone.
 */
export function planAuthEmails(user: HookUser, data: EmailData, supabaseUrl: string): OutgoingEmail[] {
  if (data.email_action_type === "email_change") {
    const newAddress = user.new_email || user.email;
    if (!data.token || !data.token_new) {
      return [outgoing(newAddress, authEmailChangeNew.build({ code: data.token_new || data.token }))];
    }
    const current = outgoing(
      user.email,
      authEmailChangeCurrent.build({ code: data.token, newEmail: user.new_email || "unknown" }),
    );
    if (!user.new_email) return [current];
    return [current, outgoing(user.new_email, authEmailChangeNew.build({ code: data.token_new }))];
  }
  if (data.email_action_type === "email_changed_notification") {
    // Tell the address the account left: that is the one someone may have lost.
    return [outgoing(data.old_email || user.email, contentFor(data, supabaseUrl, user))];
  }
  return [outgoing(user.email, contentFor(data, supabaseUrl, user))];
}
