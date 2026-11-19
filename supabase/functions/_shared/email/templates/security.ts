/**
 * Security notices: Supabase Auth's `*_notification` emails, sent after the
 * change has already happened. Nothing to click and nothing secret -- the
 * hook payload carries no URL, and a notice must be safe to forward.
 */
import type { Block, EmailContent, EmailTemplate } from '../content.ts';
import { brandWords } from './auth.ts';

/**
 * Brand is explicit, never inferred: Supabase sends most notices with no
 * redirect_to, so the hook leaves it unset and the notice reads as Bob.
 */

type PasswordChangedData = Record<never, never>;
type EmailChangedData = { newEmail: string };
type PhoneChangedData = Record<never, never>;
type IdentityLinkedData = { provider: string };
type IdentityUnlinkedData = { provider: string };
type MfaEnrolledData = { factorType: string };
type MfaUnenrolledData = { factorType: string };

const PROVIDERS: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  github: 'GitHub',
  email: 'Email',
  phone: 'Phone',
};
const FACTORS: Record<string, string> = {
  totp: 'Authenticator app',
  phone: 'Phone',
  webauthn: 'Security key',
};

/** A human label for a provider or factor id; blank means "unknown", never a throw. */
function label(table: Record<string, string>, value: string): string {
  const key = value.trim().toLowerCase();
  if (!key) return 'Unknown';
  return table[key] ?? value.trim();
}

/** Every notice has the same shape: what changed, optional details, what to do if not you. */
function notice(
  words: (name: string) => [subject: string, heading: string, what: string],
  details?: Extract<Block, { kind: 'details' }>['rows'],
): EmailContent {
  const { name } = brandWords;
  const [subject, heading, what] = words(name);
  return {
    subject,
    preheader: what,
    heading,
    blocks: [
      { kind: 'paragraph', text: what },
      ...(details ? [{ kind: 'details' as const, rows: details }] : []),
      { kind: 'paragraph', text: 'If this was you, there’s nothing more to do.' },
      {
        kind: 'note',
        text: `If this wasn’t you, reset your password from the ${name} sign-in page straight away and reply to this email.`,
      },
    ],
    reason: `You got this because a security setting changed on the ${name} account for this address.`,
  };
}

export const securityPasswordChanged = {
  id: 'security-password-changed',
  category: 'security',
  trigger: 'Supabase Auth: password_changed_notification',
  required: [],
  build: (_data: PasswordChangedData): EmailContent =>
    notice((n) => [`Your ${n} password was changed`, 'Your password was changed', `The password on your ${n} account was just changed.`]),
  sample: {},
} satisfies EmailTemplate<PasswordChangedData>;

export const securityEmailChanged = {
  id: 'security-email-changed',
  category: 'security',
  trigger: 'Supabase Auth: email_changed_notification',
  required: ['newEmail'],
  build: ({ newEmail }: EmailChangedData): EmailContent =>
    notice(
      (n) => [`Your ${n} email address was changed`, 'Your email address was changed', `The email address on your ${n} account was just changed.`],
      [{ label: 'New address', value: newEmail || 'Unknown' }],
    ),
  sample: { newEmail: 'maya@example.com' },
} satisfies EmailTemplate<EmailChangedData>;

export const securityPhoneChanged = {
  id: 'security-phone-changed',
  category: 'security',
  trigger: 'Supabase Auth: phone_changed_notification',
  required: [],
  build: (_data: PhoneChangedData): EmailContent =>
    notice((n) => [`Your ${n} phone number was changed`, 'Your phone number was changed', `The phone number on your ${n} account was just changed.`]),
  sample: {},
} satisfies EmailTemplate<PhoneChangedData>;

export const securityIdentityLinked = {
  id: 'security-identity-linked',
  category: 'security',
  trigger: 'Supabase Auth: identity_linked_notification',
  required: ['provider'],
  build: ({ provider }: IdentityLinkedData): EmailContent =>
    notice(
      (n) => [`A sign-in method was added to ${n}`, 'A sign-in method was added', `A new way to sign in was just linked to your ${n} account.`],
      [{ label: 'Provider', value: label(PROVIDERS, provider) }],
    ),
  sample: { provider: 'google' },
} satisfies EmailTemplate<IdentityLinkedData>;

export const securityIdentityUnlinked = {
  id: 'security-identity-unlinked',
  category: 'security',
  trigger: 'Supabase Auth: identity_unlinked_notification',
  required: ['provider'],
  build: ({ provider }: IdentityUnlinkedData): EmailContent =>
    notice(
      (n) => [`A sign-in method was removed from ${n}`, 'A sign-in method was removed', `A way to sign in was just unlinked from your ${n} account.`],
      [{ label: 'Provider', value: label(PROVIDERS, provider) }],
    ),
  sample: { provider: 'google' },
} satisfies EmailTemplate<IdentityUnlinkedData>;

export const securityMfaEnrolled = {
  id: 'security-mfa-enrolled',
  category: 'security',
  trigger: 'Supabase Auth: mfa_factor_enrolled_notification',
  required: ['factorType'],
  build: ({ factorType }: MfaEnrolledData): EmailContent =>
    notice(
      (n) => [`Two-step verification was added to ${n}`, 'Two-step verification was added', `A new two-step verification method was just added to your ${n} account.`],
      [{ label: 'Method', value: label(FACTORS, factorType) }],
    ),
  sample: { factorType: 'totp' },
} satisfies EmailTemplate<MfaEnrolledData>;

export const securityMfaUnenrolled = {
  id: 'security-mfa-unenrolled',
  category: 'security',
  trigger: 'Supabase Auth: mfa_factor_unenrolled_notification',
  required: ['factorType'],
  build: ({ factorType }: MfaUnenrolledData): EmailContent =>
    notice(
      (n) => [`Two-step verification was removed from ${n}`, 'Two-step verification was removed', `A two-step verification method was just removed from your ${n} account.`],
      [{ label: 'Method', value: label(FACTORS, factorType) }],
    ),
  sample: { factorType: 'totp' },
} satisfies EmailTemplate<MfaUnenrolledData>;

export const SECURITY_TEMPLATES = [
  securityPasswordChanged,
  securityEmailChanged,
  securityPhoneChanged,
  securityIdentityLinked,
  securityIdentityUnlinked,
  securityMfaEnrolled,
  securityMfaUnenrolled,
] as const;
