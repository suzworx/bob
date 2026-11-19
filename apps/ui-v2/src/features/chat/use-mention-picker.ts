import { BRAND } from '@/lib/brand';
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';

/**
 * Headless mention picker for the thread composer (S14-AT-PICKER).
 *
 * The server owns what a mention means (apps/api/src/spaces/mentions.ts): a
 * person handle is 1..40 chars of [A-Za-z0-9._-], `@` preceded by a word
 * character is NOT a mention (email addresses), `\@` is an escape, and code
 * spans/fences are skipped. The trigger detection here mirrors that grammar so
 * the picker agrees with the server about when `@` starts a mention.
 *
 * Everything in this file is a pure function except the `useMentionPicker`
 * hook wrapper itself, so the tests run without a DOM.
 */

export type MentionMember = {
  reference?: { kind: 'feature' | 'integration'; value: string; description: string; keywords: string[] };
  user_id: string;
  role: string;
  display_name: string | null;
  handle: string;
  email: string | null;
};

type InviteInput = { email: string; role: 'admin' | 'member' };
type InviteFn = (input: InviteInput) => Promise<string | null>;

type MentionTrigger = { query: string; start: number } | null;

type MentionOption = {
  kind: 'person' | 'assistant' | 'invite';
  /** Stable, unique key (a user id, 'bob', or 'invite') used as the option id. */
  id: string;
  label: string;
  sub: string;
  initials: string;
  /** The full handle including the sigil; null for the invite row (no insert). */
  handle: string | null;
};

type MentionSections = {
  people: MentionOption[];
  assistant: MentionOption[];
  invite: MentionOption[];
};

const EMPTY_SECTIONS: MentionSections = { people: [], assistant: [], invite: [] };

function isWordChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_'
  );
}

/** True when `text` (up to the caret) ends inside a backtick code span or
 *  fenced block. Mirrors the server grammar's backtick handling so pasted code
 *  never opens the picker. */
function insideBacktickSpan(text: string): boolean {
  let inFence = false;
  let inSpan = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run += 1;
      const atLineStart = i === 0 || text[i - 1] === '\n';
      if (inFence) {
        if (run >= 3 && atLineStart) inFence = false;
      } else if (inSpan) {
        if (run === 1) inSpan = false;
      } else if (run >= 3 && atLineStart) {
        inFence = true;
      } else if (run === 1) {
        inSpan = true;
      }
      i += run;
      continue;
    }
    i += 1;
  }
  return inFence || inSpan;
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  if (role === 'member') return 'Member';
  return role;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0) ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) ?? '' : '';
  return (first + last).toUpperCase();
}

/**
 * Finds an open `@` mention trigger in `value` given the caret position.
 * Scans back from the caret to the nearest `@`, stopping at whitespace or a
 * newline. Returns null when there is no open trigger, when the `@` is
 * preceded by a word character (`name@example.com`) or a backslash (`\@`), or
 * when the caret sits inside a backtick code span.
 */
export function findMentionTrigger(value: string, caret: number): MentionTrigger {
  const segment = value.slice(0, caret);
  if (insideBacktickSpan(segment)) return null;
  let at = -1;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = segment[i];
    if (ch === ' ' || ch === '\n') break;
    if (ch === '@') {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  if (at > 0) {
    const prev = segment[at - 1];
    if (prev === '\\') return null;
    if (isWordChar(prev)) return null;
  }
  return { query: segment.slice(at + 1), start: at };
}

/**
 * Builds the picker sections from the space's members and the typed query.
 * 1. people: members whose display name OR handle contains the query
 *    (case-insensitive substring); label is the display name.
 * 2. assistant: Bob when the query is a prefix of "bob".
 * 3. invite: only when the query is non-empty and no person matched.
 */
export function buildMentionSections(members: MentionMember[], query: string): MentionSections {
  const lowerQuery = query.toLowerCase();
  const people: MentionOption[] = members
    .filter((member) => {
      const name = (member.display_name ?? '').toLowerCase();
      const handle = member.handle.toLowerCase();
      return name.includes(lowerQuery) || handle.includes(lowerQuery);
    })
    .map((member) => ({
      kind: 'person',
      id: member.user_id,
      label: member.display_name && member.display_name.trim() !== '' ? member.display_name : member.handle,
      sub: `@${member.handle} · ${roleLabel(member.role)}`,
      initials: initialsOf(member.display_name && member.display_name.trim() !== '' ? member.display_name : member.handle),
      handle: `@${member.handle}`,
    }));

  const assistant: MentionOption[] = [];
  if (['bob', 'assistant'].some((alias) => alias.startsWith(lowerQuery.replace(/^@/, '')))) {
    assistant.push({
      kind: 'assistant',
      id: 'bob',
      label: BRAND.assistantName,
      sub: '@bob',
      initials: 'B',
      handle: '@bob',
    });
  }

  const invite: MentionOption[] = [];
  if (lowerQuery.length > 0 && people.length === 0 && assistant.length === 0) {
    invite.push({
      kind: 'invite',
      id: 'invite',
      label: `Invite ${query} to this space…`,
      sub: 'They get a link; you stay in the conversation',
      initials: '+',
      handle: null,
    });
  }

  return { people, assistant, invite };
}

/** Flattens the sections into the single ordered list the picker navigates. */
function flattenOptions(sections: MentionSections): MentionOption[] {
  return [...sections.people, ...sections.assistant, ...sections.invite];
}

/** Next active index with wrap-around; stays at 0 for an empty list. */
export function moveIndex(current: number, dir: 1 | -1, length: number): number {
  if (length === 0) return 0;
  return (current + dir + length) % length;
}

/**
 * Replaces the mention token (from `start` through `caret`) with `handle`
 * followed by one space, returning the new value and caret position. A pure
 * function of (value, caret, start, handle) so tests assert without a DOM.
 */
export function insertMention(
  value: string,
  caret: number,
  start: number,
  handle: string,
): { value: string; caret: number } {
  const prefix = value.slice(0, start);
  const suffix = value.slice(caret);
  const next = `${prefix}${handle} ${suffix}`;
  return { value: next, caret: start + handle.length + 1 };
}

type MentionPickerValue = {
  value: string;
  onValueChange: (value: string, caret: number) => void;
  open: boolean;
  trigger: MentionTrigger;
  sections: MentionSections;
  options: MentionOption[];
  activeIndex: number;
  inviteOpen: boolean;
  move: (dir: 1 | -1) => void;
  pick: (index: number) => void;
  choose: () => void;
  dismiss: () => void;
  insert: (handle: string) => void;
  closeInvite: () => void;
  /** Handles the picker's keys (arrows, Enter, Tab, Escape). Returns true when
   *  the key was consumed so the caller does not also send on Enter. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};

/**
 * The composer's mention picker state: owns the draft value + caret, derives
 * the open trigger and sections, and exposes keyboard navigation and insertion.
 */
function useMentionPicker({
  members,
  onInvite,
}: {
  members: MentionMember[];
  onInvite: InviteFn;
}): MentionPickerValue {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [suppressed, setSuppressed] = useState(false);

  const trigger = useMemo(() => findMentionTrigger(value, caret), [value, caret]);
  const query = trigger === null ? '' : trigger.query;
  const sections = useMemo(
    () => (trigger === null ? EMPTY_SECTIONS : buildMentionSections(members, query)),
    [trigger, members, query],
  );
  const options = useMemo(() => flattenOptions(sections), [sections]);
  const open = trigger !== null && options.length > 0 && !suppressed && !inviteOpen;

  const onValueChange = useCallback((nextValue: string, nextCaret: number): void => {
    setValue(nextValue);
    setCaret(nextCaret);
    setSuppressed(false);
    setActiveIndex(0);
    setInviteOpen(false);
  }, []);

  const insert = useCallback(
    (handle: string): void => {
      if (trigger === null) return;
      const result = insertMention(value, caret, trigger.start, handle);
      setValue(result.value);
      setCaret(result.caret);
      setSuppressed(false);
      setActiveIndex(0);
      setInviteOpen(false);
    },
    [value, caret, trigger],
  );

  const dismiss = useCallback((): void => {
    setSuppressed(true);
    setActiveIndex(0);
    setInviteOpen(false);
  }, []);

  const chooseOption = useCallback(
    (option: MentionOption): void => {
      if (option.kind === 'invite') {
        setInviteOpen(true);
        return;
      }
      if (option.handle !== null) insert(option.handle);
    },
    [insert],
  );

  const choose = useCallback((): void => {
    const option = options[activeIndex];
    if (option !== undefined) chooseOption(option);
  }, [options, activeIndex, chooseOption]);

  const pick = useCallback(
    (index: number): void => {
      const option = options[index];
      if (option === undefined) return;
      setActiveIndex(index);
      chooseOption(option);
    },
    [options, chooseOption],
  );

  const move = useCallback(
    (dir: 1 | -1): void => {
      setActiveIndex((prev) => moveIndex(prev, dir, options.length));
    },
    [options.length],
  );

  const closeInvite = useCallback((): void => {
    setInviteOpen(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          return true;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          return true;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          choose();
          return true;
        case 'Escape':
          event.preventDefault();
          dismiss();
          return true;
        default:
          return false;
      }
    },
    [open, move, choose, dismiss],
  );

  return {
    value,
    onValueChange,
    open,
    trigger,
    sections,
    options,
    activeIndex,
    inviteOpen,
    move,
    pick,
    choose,
    dismiss,
    insert,
    closeInvite,
    onKeyDown,
  };
}
