/**
 * Auth emails: the one-time codes and links Supabase Auth hands the
 * send-email hook. Declarative content only -- render.ts turns it into HTML.
 *
 * The sign-in form asks for a code, so sign-in mail carries a code and never
 * a link. Invites and password resets keep a button because they land on a
 * page of their own; the code rides along as a fallback note.
 */
import type { EmailContent, EmailTemplate } from '../content.ts';

const EXPIRY = 'The code expires in an hour and works once.';
const IGNORE = 'If you didn’t ask for this, you can ignore this email — nothing was changed.';

/** The product name and its indefinite article, for the copy. */
export const brandWords = { name: 'Bob', aName: 'a Bob' } as const;

type SignInCodeData = { code: string };
type SignupConfirmData = { code: string; confirmUrl: string };
type AccountInviteData = { acceptUrl: string; code: string };
type PasswordResetData = { resetUrl: string; code: string };
type EmailChangeCurrentData = { code: string; newEmail: string };
type EmailChangeNewData = { code: string };
type ReauthenticateData = { code: string };

export const authSignInCode = {
  id: 'auth-sign-in-code',
  category: 'auth',
  trigger: 'Supabase Auth: signInWithOtp (magiclink/email)',
  required: ['code'],
  build: ({ code }: SignInCodeData): EmailContent => {
    const { name } = brandWords;
    return {
      subject: `${code} is your ${name} sign-in code`,
      preheader: `Your ${name} sign-in code is ${code}.`,
      heading: `Sign in to ${name}`,
      blocks: [
        { kind: 'paragraph', text: `Enter this code on the ${name} sign-in page.` },
        { kind: 'code', value: code },
        { kind: 'note', text: `${EXPIRY} ${IGNORE}` },
      ],
      reason: `You got this because someone asked to sign in to ${name} with this address.`,
    };
  },
  sample: { code: '482913' },
} satisfies EmailTemplate<SignInCodeData>;

export const authSignupConfirm = {
  id: 'auth-signup-confirm',
  category: 'auth',
  trigger: 'Supabase Auth: signUp (signup)',
  required: ['code', 'confirmUrl'],
  build: ({ code, confirmUrl }: SignupConfirmData): EmailContent => {
    const { name, aName } = brandWords;
    return {
      subject: `Confirm your ${name} address`,
      preheader: `Confirm your address to finish creating your ${name} account.`,
      heading: 'Confirm your address',
      blocks: [
        { kind: 'paragraph', text: `Confirm this address to finish creating your ${name} account.` },
        { kind: 'button', href: confirmUrl, label: 'Confirm address' },
        { kind: 'note', text: `Or enter this code on the ${name} sign-in page: ${code}. ${EXPIRY} ${IGNORE}` },
      ],
      reason: `You got this because someone created ${aName} account with this address.`,
    };
  },
  sample: { code: '482913', confirmUrl: 'https://example.com/auth/v1/verify?token=sample&type=signup' },
} satisfies EmailTemplate<SignupConfirmData>;

export const authAccountInvite = {
  id: 'auth-account-invite',
  category: 'auth',
  trigger: 'Supabase Auth: admin.inviteUserByEmail (invite)',
  required: ['acceptUrl', 'code'],
  build: ({ acceptUrl, code }: AccountInviteData): EmailContent => {
    const { name, aName } = brandWords;
    return {
      subject: `You’re invited to ${name}`,
      preheader: `Accept your invite to set up your ${name} account.`,
      heading: `You’re invited to ${name}`,
      blocks: [
        { kind: 'paragraph', text: `You’ve been invited to ${name}. Accept the invite to set up your account.` },
        { kind: 'button', href: acceptUrl, label: 'Accept invite' },
        { kind: 'note', text: `Or enter this code on the ${name} sign-in page: ${code}. ${IGNORE}` },
      ],
      reason: `You got this because ${aName} admin invited this address.`,
    };
  },
  sample: { acceptUrl: 'https://example.com/auth/v1/verify?token=sample&type=invite', code: '482913' },
} satisfies EmailTemplate<AccountInviteData>;

export const authPasswordReset = {
  id: 'auth-password-reset',
  category: 'auth',
  trigger: 'Supabase Auth: resetPasswordForEmail (recovery)',
  required: ['resetUrl', 'code'],
  build: ({ resetUrl, code }: PasswordResetData): EmailContent => {
    const { name } = brandWords;
    return {
      subject: `Reset your ${name} password`,
      preheader: `Choose a new password for your ${name} account.`,
      heading: 'Reset your password',
      blocks: [
        { kind: 'paragraph', text: 'Use the button below to choose a new password.' },
        { kind: 'button', href: resetUrl, label: 'Choose a new password' },
        { kind: 'note', text: `Or enter this code: ${code}. ${EXPIRY} ${IGNORE}` },
      ],
      reason: `You got this because someone asked to reset the ${name} password for this address.`,
    };
  },
  sample: { resetUrl: 'https://example.com/auth/v1/verify?token=sample&type=recovery', code: '482913' },
} satisfies EmailTemplate<PasswordResetData>;

export const authEmailChangeCurrent = {
  id: 'auth-email-change-current',
  category: 'auth',
  trigger: 'Supabase Auth: updateUser({ email }) (email_change, current address)',
  required: ['code', 'newEmail'],
  build: ({ code, newEmail }: EmailChangeCurrentData): EmailContent => {
    const { name } = brandWords;
    return {
      subject: `Confirm your ${name} email change`,
      preheader: `Someone asked to move your ${name} account to ${newEmail}.`,
      heading: 'Confirm your email change',
      blocks: [
        { kind: 'paragraph', text: `Someone asked to move your ${name} account to a new address:` },
        { kind: 'details', rows: [{ label: 'New address', value: newEmail }] },
        { kind: 'paragraph', text: `If that was you, enter this code in ${name} to confirm.` },
        { kind: 'code', value: code },
        {
          kind: 'note',
          text: `${EXPIRY} If it wasn’t you, don’t share this code — the change can’t finish without it. ` +
            `Reset your password from the ${name} sign-in page and reply to this email.`,
        },
      ],
      reason: `You got this because someone asked to change the email address on this ${name} account.`,
    };
  },
  sample: { code: '482913', newEmail: 'maya@example.com' },
} satisfies EmailTemplate<EmailChangeCurrentData>;

export const authEmailChangeNew = {
  id: 'auth-email-change-new',
  category: 'auth',
  trigger: 'Supabase Auth: updateUser({ email }) (email_change, new address)',
  required: ['code'],
  build: ({ code }: EmailChangeNewData): EmailContent => {
    const { name, aName } = brandWords;
    return {
      subject: `Confirm your new ${name} address`,
      preheader: `Your code to confirm this address is ${code}.`,
      heading: 'Confirm your new address',
      blocks: [
        { kind: 'paragraph', text: `Enter this code in ${name} to move your account to this address.` },
        { kind: 'code', value: code },
        { kind: 'note', text: `${EXPIRY} ${IGNORE}` },
      ],
      reason: `You got this because someone asked to move ${aName} account to this address.`,
    };
  },
  sample: { code: '482913' },
} satisfies EmailTemplate<EmailChangeNewData>;

export const authReauthenticate = {
  id: 'auth-reauthenticate',
  category: 'auth',
  trigger: 'Supabase Auth: reauthenticate (reauthentication)',
  required: ['code'],
  build: ({ code }: ReauthenticateData): EmailContent => {
    const { name } = brandWords;
    return {
      subject: `${code} — confirm it’s you`,
      preheader: `Your ${name} confirmation code is ${code}.`,
      heading: 'Confirm it’s you',
      blocks: [
        { kind: 'paragraph', text: `Enter this code in ${name} to continue.` },
        { kind: 'code', value: code },
        { kind: 'note', text: `${EXPIRY} ${IGNORE}` },
      ],
      reason: `You got this because someone signed in to this ${name} account asked to confirm it’s them.`,
    };
  },
  sample: { code: '482913' },
} satisfies EmailTemplate<ReauthenticateData>;

export const AUTH_TEMPLATES = [
  authSignInCode,
  authSignupConfirm,
  authAccountInvite,
  authPasswordReset,
  authEmailChangeCurrent,
  authEmailChangeNew,
  authReauthenticate,
] as const;
