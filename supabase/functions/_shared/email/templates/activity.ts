// Activity notifications: someone assigned you a task or mentioned you in a thread.
// Templates return plain-text content only; render.ts owns all markup.
import type { Block, EmailContent, EmailTemplate } from '../content.ts';

/** Longest excerpt a mention email quotes; the caller truncates too, this is the backstop. */
export const EXCERPT_MAX_CHARS = 280;

type TaskAssignedData = {
  actorName: string;
  spaceName: string;
  taskTitle: string;
  dueLabel?: string;
  taskUrl: string;
  manageUrl: string;
};

type ThreadMentionData = {
  actorName: string;
  spaceName: string;
  threadTitle: string;
  excerpt: string;
  threadUrl: string;
  manageUrl: string;
};

type BobMessageData = {
  noteTitle: string;
  noteBody?: string;
  noteUrl: string;
  manageUrl: string;
};

/** Caps text at `max` characters, ending in an ellipsis when it was cut. */
export function capExcerpt(text: string, max: number = EXCERPT_MAX_CHARS): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

export const taskAssigned = {
  id: 'task-assigned',
  category: 'activity',
  trigger: 'A space member assigns a task to the recipient',
  required: ['actorName', 'spaceName', 'taskTitle', 'taskUrl', 'manageUrl'],
  build: (d: TaskAssignedData): EmailContent => {
    const rows: Array<{ label: string; value: string }> = [
      { label: 'Task', value: d.taskTitle },
      { label: 'Space', value: d.spaceName },
    ];
    if (d.dueLabel) rows.push({ label: 'Due', value: d.dueLabel });
    const blocks: Block[] = [
      {
        kind: 'paragraph',
        text: `${d.actorName} assigned you a task in ${d.spaceName}.`,
      },
      { kind: 'details', rows },
      { kind: 'button', href: d.taskUrl, label: 'Open task' },
    ];
    return {
      subject: `${d.actorName} assigned you a task in ${d.spaceName}`,
      preheader: d.dueLabel ? `${d.taskTitle} — due ${d.dueLabel}` : d.taskTitle,
      heading: `${d.actorName} assigned you a task`,
      blocks,
      reason: `You got this because ${d.actorName} assigned you a task in ${d.spaceName}.`,
      manageUrl: d.manageUrl,
    };
  },
  sample: {
    actorName: 'Arjun',
    spaceName: 'Home',
    taskTitle: 'Book the plumber for the kitchen sink',
    dueLabel: 'Friday, 25 Sep',
    taskUrl: 'https://app.example.com/spaces/home/tasks/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<TaskAssignedData>;

export const threadMention = {
  id: 'thread-mention',
  category: 'activity',
  trigger: 'A space member mentions the recipient in a thread',
  required: ['actorName', 'spaceName', 'threadTitle', 'excerpt', 'threadUrl', 'manageUrl'],
  build: (d: ThreadMentionData): EmailContent => ({
    subject: `${d.actorName} mentioned you in ${d.spaceName}`,
    preheader: `In “${d.threadTitle}”: ${capExcerpt(d.excerpt, 90)}`,
    heading: `${d.actorName} mentioned you`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${d.actorName} mentioned you in “${d.threadTitle}” in ${d.spaceName}.`,
      },
      { kind: 'quote', text: capExcerpt(d.excerpt) },
      { kind: 'button', href: d.threadUrl, label: 'Open thread' },
    ],
    reason: `You got this because ${d.actorName} mentioned you in ${d.spaceName}.`,
    manageUrl: d.manageUrl,
  }),
  sample: {
    actorName: 'Maya',
    spaceName: 'Home',
    threadTitle: 'Weekend plans',
    excerpt: '@Arjun could you pick up the groceries on Saturday morning? I will handle dinner.',
    threadUrl: 'https://app.example.com/spaces/home/threads/sample',
    manageUrl: 'https://app.example.com/settings/notifications',
  },
} satisfies EmailTemplate<ThreadMentionData>;

export const bobMessage = {
  id: 'bob-message',
  category: 'activity',
  trigger: 'Bob saves a private note for the recipient',
  required: ['noteTitle', 'noteUrl', 'manageUrl'],
  build: (d: BobMessageData): EmailContent => {
    const noteBody = typeof d.noteBody === 'string' ? d.noteBody.trim() : '';
    return {
      subject: `Bob left you a note: ${d.noteTitle}`,
      preheader: 'A new note from Bob is waiting in your personal notes.',
      heading: 'A note from Bob',
      blocks: [
        { kind: 'paragraph', text: 'Bob left you a note.' },
        { kind: 'details', rows: [{ label: 'Note', value: d.noteTitle }] },
        ...(noteBody ? [{ kind: 'quote' as const, text: noteBody }] : []),
        { kind: 'button', href: d.noteUrl, label: 'Open note' },
      ],
      reason: 'You got this because Bob saved a private note for you.',
      manageUrl: d.manageUrl,
    };
  },
  sample: {
    noteTitle: 'Weekend plan',
    noteBody: 'Pack a picnic.',
    noteUrl: 'https://app.example.com/spaces/private/notes?note=note-123',
    manageUrl: 'https://app.example.com/settings#notifications',
  },
} satisfies EmailTemplate<BobMessageData>;

type ChatInviteData = {
  inviterName: string;
  chatName: string;
  acceptUrl: string;
  expiresLabel: string;
};

export const chatInvite = {
  id: 'chat-invite',
  category: 'activity',
  trigger: 'A chat participant emails an invitation to join their chat',
  required: ['inviterName', 'chatName', 'acceptUrl', 'expiresLabel'],
  build: (d: ChatInviteData): EmailContent => ({
    subject: `${d.inviterName} invited you to a chat with Bob`,
    preheader: `Join ${d.inviterName} in “${d.chatName}”.`,
    heading: 'You’re invited to chat',
    blocks: [
      { kind: 'paragraph', text: `${d.inviterName} invited you to “${d.chatName}” with Bob.` },
      {
        kind: 'paragraph',
        text: 'You choose whether to join. Joining gives you access to only this chat and its history.',
      },
      { kind: 'button', href: d.acceptUrl, label: 'Join chat' },
      {
        kind: 'note',
        text: `Anyone with this link can join, so share it thoughtfully. It expires ${d.expiresLabel}.`,
      },
    ],
    reason: `You got this because ${d.inviterName} sent you a chat invitation.`,
  }),
  sample: {
    inviterName: 'Maya',
    chatName: 'Weekend plans',
    acceptUrl: 'https://app.example.com/join-chat/sample',
    expiresLabel: 'Friday, 30 October at 5:00 PM',
  },
} satisfies EmailTemplate<ChatInviteData>;

export const ACTIVITY_TEMPLATES = [taskAssigned, threadMention, bobMessage, chatInvite] as const;
