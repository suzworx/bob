// Space membership emails: invites, joins, removals, ownership and archiving.
// Templates return plain-text content only; render.ts owns all markup.
import type { EmailContent, EmailTemplate } from '../content.ts';

type SpaceInviteData = {
  inviterName: string;
  spaceName: string;
  spaceKind: string;
  role: string;
  acceptUrl: string;
  expiresLabel: string;
};

type SpaceInviteAcceptedData = {
  memberName: string;
  spaceName: string;
  spaceUrl: string;
  manageUrl: string;
};

type SpaceMemberRemovedData = {
  spaceName: string;
  removedByName: string;
};

type SpaceOwnershipTransferredData = {
  spaceName: string;
  previousOwnerName: string;
  spaceUrl: string;
};

type SpaceArchivedData = {
  spaceName: string;
  archivedByName: string;
};

export const spaceInvite = {
  id: 'space-invite',
  category: 'spaces',
  trigger: 'A space member invites someone by email to join the space',
  required: ['inviterName', 'spaceName', 'spaceKind', 'role', 'acceptUrl', 'expiresLabel'],
  build: (d: SpaceInviteData): EmailContent => ({
    subject: `${d.inviterName} invited you to ${d.spaceName} on Bob`,
    preheader: `Join ${d.spaceName} as ${d.role}. The invitation expires ${d.expiresLabel}.`,
    heading: `${d.inviterName} invited you to ${d.spaceName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.inviterName} would like you to join ${d.spaceName}, a ${d.spaceKind} space on Bob, so you can share tasks, threads and plans together.`,
      },
      { kind: 'button', href: d.acceptUrl, label: 'Accept invitation' },
      {
        kind: 'note',
        text: "Open the link, then sign in with this email address — we'll send you a six-digit code.",
      },
      {
        kind: 'details',
        rows: [
          { label: 'Space', value: d.spaceName },
          { label: 'Role', value: d.role },
          { label: 'Expires', value: d.expiresLabel },
        ],
      },
      {
        kind: 'note',
        text: `If you don't know ${d.inviterName}, ignore this — nothing happens until you accept.`,
      },
    ],
    reason: `You got this because ${d.inviterName} invited this address to ${d.spaceName}.`,
  }),
  sample: {
    inviterName: 'Maya',
    spaceName: 'Home',
    spaceKind: 'Family',
    role: 'Member',
    acceptUrl: 'https://app.example.com/invites/accept?token=sample',
    expiresLabel: 'in 7 days',
  },
} satisfies EmailTemplate<SpaceInviteData>;

export const spaceInviteAccepted = {
  id: 'space-invite-accepted',
  category: 'spaces',
  trigger: 'Someone accepts an invitation the recipient sent',
  required: ['memberName', 'spaceName', 'spaceUrl', 'manageUrl'],
  build: (d: SpaceInviteAcceptedData): EmailContent => ({
    subject: `${d.memberName} joined ${d.spaceName}`,
    preheader: `${d.memberName} accepted your invitation and is now in ${d.spaceName}.`,
    heading: `${d.memberName} joined ${d.spaceName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.memberName} accepted your invitation. They can now see and share everything in ${d.spaceName}.`,
      },
      { kind: 'button', href: d.spaceUrl, label: 'Open space' },
    ],
    reason: `You got this because you invited ${d.memberName} to ${d.spaceName}.`,
    manageUrl: d.manageUrl,
  }),
  sample: {
    memberName: 'Arjun',
    spaceName: 'Home',
    spaceUrl: 'https://app.example.com/spaces/home',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<SpaceInviteAcceptedData>;

export const spaceMemberRemoved = {
  id: 'space-member-removed',
  category: 'spaces',
  trigger: 'A space admin removes the recipient from the space',
  required: ['spaceName', 'removedByName'],
  build: (d: SpaceMemberRemovedData): EmailContent => ({
    subject: `You're no longer a member of ${d.spaceName}`,
    preheader: `${d.removedByName} removed you from ${d.spaceName}. Your other spaces are unchanged.`,
    heading: `You're no longer in ${d.spaceName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.removedByName} removed you from ${d.spaceName}, so it no longer appears in your Bob. Your other spaces and your account are unchanged.`,
      },
      {
        kind: 'note',
        text: `If you think this was a mistake, ask ${d.removedByName} to invite you again.`,
      },
    ],
    reason: `You got this because you were a member of ${d.spaceName}.`,
  }),
  sample: { spaceName: 'Home', removedByName: 'Maya' },
} satisfies EmailTemplate<SpaceMemberRemovedData>;

const spaceOwnershipTransferred = {
  id: 'space-ownership-transferred',
  category: 'spaces',
  trigger: 'The owner of a space transfers ownership to the recipient',
  required: ['spaceName', 'previousOwnerName', 'spaceUrl'],
  build: (d: SpaceOwnershipTransferredData): EmailContent => ({
    subject: `You now own ${d.spaceName}`,
    preheader: `${d.previousOwnerName} made you the owner of ${d.spaceName}.`,
    heading: `You now own ${d.spaceName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.previousOwnerName} handed ${d.spaceName} over to you. As owner you can invite and remove members, change roles and archive the space.`,
      },
      { kind: 'button', href: d.spaceUrl, label: 'Open space' },
    ],
    reason: `You got this because ${d.previousOwnerName} transferred ${d.spaceName} to you.`,
  }),
  sample: {
    spaceName: 'Home',
    previousOwnerName: 'Maya',
    spaceUrl: 'https://app.example.com/spaces/home',
  },
} satisfies EmailTemplate<SpaceOwnershipTransferredData>;

export const spaceArchived = {
  id: 'space-archived',
  category: 'spaces',
  trigger: 'A space owner archives a space the recipient belongs to',
  required: ['spaceName', 'archivedByName'],
  build: (d: SpaceArchivedData): EmailContent => ({
    subject: `${d.spaceName} was archived`,
    preheader: `${d.archivedByName} archived ${d.spaceName}. Your other spaces are unchanged.`,
    heading: `${d.archivedByName} archived ${d.spaceName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.archivedByName} archived ${d.spaceName}, so it no longer appears in your Bob. Your other spaces and your account are unchanged.`,
      },
    ],
    reason: `You got this because you were a member of ${d.spaceName}.`,
  }),
  sample: { spaceName: 'Home', archivedByName: 'Maya' },
} satisfies EmailTemplate<SpaceArchivedData>;

export const SPACES_TEMPLATES = [
  spaceInvite,
  spaceInviteAccepted,
  spaceMemberRemoved,
  spaceOwnershipTransferred,
  spaceArchived,
] as const;
