/**
 * Account and security-event notices: things that changed who or what can
 * reach an account. Each one says what happened and what to do if it was not
 * the reader -- except account-deleted, which is final and has nothing to act on.
 */
import type { EmailTemplate } from '../content.ts';

const NOT_YOU = "If this wasn't you, sign in and remove it, or reply to this email.";
const REASON = 'You received this because it concerns your Bob account.';

type AccountDeletedData = Record<never, never>;
type GoogleAccountLinkedData = { googleEmail: string; manageUrl: string };
type GoogleAccountUnlinkedData = { googleEmail: string };
type DevicePairedData = { deviceName: string; manageUrl: string };
type DeviceRemovedData = { deviceName: string };

export const accountDeleted = {
  id: 'account-deleted',
  category: 'account',
  trigger: 'The account owner deletes their Bob account; sent just before it is erased.',
  required: [],
  build: (_data) => ({
    subject: 'Your Bob account has been deleted',
    preheader: 'Your account and everything in it have been erased.',
    heading: 'Your account has been deleted.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'As you asked, we have erased your Bob account: your profile, conversations, spaces you owned, connected accounts and paired devices.',
      },
      { kind: 'paragraph', text: 'This cannot be undone. Thank you for trying Bob.' },
      {
        kind: 'note',
        text: "If you didn't ask for this, reply to this email and we'll look into it.",
      },
    ],
    reason: 'You received this because the Bob account for this address was deleted.',
  }),
  sample: {},
} satisfies EmailTemplate<AccountDeletedData>;

export const googleAccountLinked = {
  id: 'google-account-linked',
  category: 'account',
  trigger: 'A Google account is connected to Bob (calendar and mail access).',
  required: ['googleEmail', 'manageUrl'],
  build: (data) => ({
    subject: 'A Google account was connected to Bob',
    preheader: `${data.googleEmail} can now be used by your Bob assistant.`,
    heading: 'A Google account was connected.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'A Google account was just connected to your Bob account.',
      },
      { kind: 'details', rows: [{ label: 'Google account', value: data.googleEmail }] },
      { kind: 'button', href: data.manageUrl, label: 'Review connected accounts' },
      { kind: 'note', text: NOT_YOU },
    ],
    reason: REASON,
  }),
  sample: { googleEmail: 'maya@example.com', manageUrl: 'https://app.heybob.xyz/settings/accounts' },
} satisfies EmailTemplate<GoogleAccountLinkedData>;

export const googleAccountUnlinked = {
  id: 'google-account-unlinked',
  category: 'account',
  trigger: 'A Google account is disconnected from Bob.',
  required: ['googleEmail'],
  build: (data) => ({
    subject: 'A Google account was disconnected from Bob',
    preheader: `${data.googleEmail} is no longer connected to Bob.`,
    heading: 'A Google account was disconnected.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'A Google account was just disconnected from your Bob account. Bob can no longer read or change anything in it.',
      },
      { kind: 'details', rows: [{ label: 'Google account', value: data.googleEmail }] },
      { kind: 'note', text: NOT_YOU },
    ],
    reason: REASON,
  }),
  sample: { googleEmail: 'maya@example.com' },
} satisfies EmailTemplate<GoogleAccountUnlinkedData>;

export const devicePaired = {
  id: 'device-paired',
  category: 'account',
  trigger: 'A device (e.g. a Cardputer) is paired with a Bob account.',
  required: ['deviceName', 'manageUrl'],
  build: (data) => ({
    subject: 'A new device was paired with Bob',
    preheader: `${data.deviceName} can now talk to your Bob assistant.`,
    heading: 'A new device was paired.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'A device was just paired with your Bob account and can now talk to your assistant.',
      },
      { kind: 'details', rows: [{ label: 'Device', value: data.deviceName }] },
      { kind: 'button', href: data.manageUrl, label: 'Review devices' },
      { kind: 'note', text: NOT_YOU },
    ],
    reason: REASON,
  }),
  sample: { deviceName: "Maya's Cardputer", manageUrl: 'https://app.heybob.xyz/settings/devices' },
} satisfies EmailTemplate<DevicePairedData>;

export const deviceRemoved = {
  id: 'device-removed',
  category: 'account',
  trigger: 'A paired device is removed from a Bob account.',
  required: ['deviceName'],
  build: (data) => ({
    subject: 'A device was removed from Bob',
    preheader: `${data.deviceName} can no longer reach your Bob assistant.`,
    heading: 'A device was removed.',
    blocks: [
      {
        kind: 'paragraph',
        text: 'A device was just removed from your Bob account and can no longer reach your assistant.',
      },
      { kind: 'details', rows: [{ label: 'Device', value: data.deviceName }] },
      { kind: 'note', text: NOT_YOU },
    ],
    reason: REASON,
  }),
  sample: { deviceName: "Maya's Cardputer" },
} satisfies EmailTemplate<DeviceRemovedData>;

export const bobAccountInvite = {
  id: 'bob-account-invite',
  category: 'account',
  trigger: 'An administrator adds a person and queues a Bob invitation.',
  required: [],
  build: (_data) => ({
    subject: "You're invited to Bob",
    preheader: 'Your access is ready. Sign in to meet Bob.',
    heading: 'Come meet Bob.',
    blocks: [
      { kind: 'paragraph', text: 'You have been invited to Bob. Your account is ready to use.' },
      { kind: 'button', href: 'https://app.heybob.xyz/', label: 'Sign in to Bob' },
      { kind: 'paragraph', text: 'Use this email address to request a sign-in code. No password is needed.' },
    ],
    reason: 'You received this because an administrator invited this address to Bob.',
  }),
  sample: {},
} satisfies EmailTemplate<Record<never, never>>;

export const ACCOUNT_TEMPLATES = [
  accountDeleted,
  googleAccountLinked,
  googleAccountUnlinked,
  devicePaired,
  deviceRemoved,
  bobAccountInvite,
] as const;
