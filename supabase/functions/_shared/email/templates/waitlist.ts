/**
 * Waitlist mail, sent only by the `waitlist` Edge Function. Nothing here is a
 * credential for an account: joining the list creates no auth.users row.
 */
import type { EmailTemplate } from '../content.ts';

const REASON = 'You received this because this address was entered on the Bob waitlist.';

type WaitlistCodeData = { code: string; ttlMinutes: number };
type WaitlistJoinedData = Record<never, never>;

export const waitlistCode = {
  id: 'waitlist-code',
  category: 'waitlist',
  trigger: 'Someone enters an address on the landing page to join the waitlist.',
  required: ['code', 'ttlMinutes'],
  build: (data) => ({
    subject: `${data.code} is your Bob waitlist code`,
    preheader: `Your Bob waitlist code is ${data.code} — it expires in ${data.ttlMinutes} minutes.`,
    heading: "Here's your code.",
    blocks: [
      { kind: 'paragraph', text: 'Enter these six digits on the Bob page to join the waitlist.' },
      { kind: 'code', value: data.code },
      {
        kind: 'note',
        text: `The code expires in ${data.ttlMinutes} minutes. If you didn't ask to join, ignore this — nothing was created.`,
      },
    ],
    reason: REASON,
  }),
  sample: { code: '482913', ttlMinutes: 10 },
} satisfies EmailTemplate<WaitlistCodeData>;

export const waitlistJoined = {
  id: 'waitlist-joined',
  category: 'waitlist',
  trigger: 'An address is verified on the waitlist for the first time.',
  required: [],
  build: (_data) => ({
    subject: "You're on the Bob waitlist",
    preheader: "You're on the list. We'll email you when a spot opens.",
    heading: "You're on the list.",
    blocks: [
      { kind: 'paragraph', text: 'Thanks for confirming your address — you now have a place on the Bob waitlist.' },
      {
        kind: 'paragraph',
        text: "What happens next: when a spot opens, we'll send an invitation to this address. There's nothing else to do until then.",
      },
      { kind: 'note', text: 'To leave the list, reply to this email.' },
    ],
    reason: REASON,
  }),
  sample: {},
} satisfies EmailTemplate<WaitlistJoinedData>;

export const waitlistAdminJoined = {
  id: 'waitlist-admin-joined',
  category: 'waitlist',
  trigger: 'An address is verified on the waitlist for the first time; notifies the configured administrator.',
  required: ['email'],
  build: (data) => ({
    subject: 'Someone joined the Bob waitlist',
    preheader: 'A new subscriber has confirmed their email address.',
    heading: 'A new person is on the list.',
    blocks: [
      { kind: 'paragraph', text: 'This subscriber has verified their email and joined the Bob waitlist.' },
      { kind: 'details', rows: [{ label: 'Email', value: data.email }] },
      { kind: 'button', href: 'https://app.heybob.xyz/admin', label: 'View the waitlist' },
    ],
    reason: 'You received this because you are the configured recipient for Bob waitlist notifications.',
  }),
  sample: { email: 'maya@example.com' },
} satisfies EmailTemplate<{ email: string }>;

export const WAITLIST_TEMPLATES = [waitlistCode, waitlistJoined, waitlistAdminJoined] as const;
