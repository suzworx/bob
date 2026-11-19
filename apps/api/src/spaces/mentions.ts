/**
 * Deterministic mention parser and resolver for thread bodies. Whether Bob
 * is addressed is decided here, never by asking a model; dependency-free so
 * any transport can run it before deciding whether a model call is warranted.
 *
 * Grammar:
 *   - `@handle`     person; 1..40 chars of `[A-Za-z0-9._-]`, starting with a
 *                   letter or digit, never ending with `.` or `-` (trailing
 *                   punctuation belongs to the sentence).
 *   - `@bob`      (case-insensitive) assistant, never a person.
 *   - `#task/<id>`, `#event/<id>`, `#note/<id>`  resource; `<id>` is 1..64
 *                   chars of `[A-Za-z0-9_-]`, reported as `handle`.
 *
 * Rules that break naive regex parsers:
 *   1. An `@` preceded by a word character is never a mention (emails).
 *   2. Code spans and fenced blocks are skipped (pasted code has no people).
 *   3. `\@` and `\#` are escapes.
 *   4. Duplicates are kept as separate spans; de-duplication is the caller's.
 *   5. Offsets are UTF-16 code units, so `body.slice(m.start, m.end) === m.raw`.
 *   6. One left-to-right pass: O(n), no backtracking blowup.
 */

type MentionKind = 'person' | 'assistant' | 'resource';

type ResourceType = 'task' | 'event' | 'note';

type Mention = {
  kind: MentionKind;
  /** The handle as typed, without the sigil. Lowercased for matching. */
  handle: string;
  /** Only for kind: 'resource'. */
  resourceType?: ResourceType;
  /** UTF-16 code-unit offsets into the original string; start inclusive, end exclusive. */
  start: number;
  end: number;
  /** The exact source text of the mention, sigil included. */
  raw: string;
};

type ParsedMentions = {
  mentions: Mention[];
  /** True when at least one 'assistant' mention is present. */
  addressesAssistant: boolean;
};

/** ASCII word character: [A-Za-z0-9_]. An @ preceded by one is not a mention. */
function isWordChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_'
  );
}

/** Handle character: [A-Za-z0-9._-]. */
function isHandleChar(ch: string): boolean {
  return isWordChar(ch) || ch === '.' || ch === '-';
}

/** Resource id character: [A-Za-z0-9_-]. */
function isIdChar(ch: string): boolean {
  return isWordChar(ch) || ch === '-';
}

function isAsciiLetterOrDigit(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9')
  );
}

/** The exclusive end of the handle after the `@` at `from - 1`, or null. */
function scanHandle(body: string, from: number): number | null {
  const n = body.length;
  let j = from;
  while (j < n && isHandleChar(body.charAt(j))) j += 1;
  let end = j;
  while (end > from && (body.charAt(end - 1) === '.' || body.charAt(end - 1) === '-')) end -= 1;
  const len = end - from;
  if (len < 1 || len > 40) return null;
  if (!isAsciiLetterOrDigit(body.charAt(from))) return null;
  return end;
}

const RESOURCE_PREFIXES: ReadonlyArray<{ prefix: string; type: ResourceType }> = [
  { prefix: 'task', type: 'task' },
  { prefix: 'event', type: 'event' },
  { prefix: 'note', type: 'note' },
];

/** The resource mention at the `#` at `at`, or null. */
function scanResource(
  body: string,
  at: number,
): { type: ResourceType; id: string; end: number } | null {
  const n = body.length;
  for (const { prefix, type } of RESOURCE_PREFIXES) {
    const pEnd = at + 1 + prefix.length;
    if (pEnd >= n) continue;
    if (body.slice(at + 1, pEnd) !== prefix) continue;
    if (body.charAt(pEnd) !== '/') continue;
    const idStart = pEnd + 1;
    let j = idStart;
    while (j < n && isIdChar(body.charAt(j))) j += 1;
    const idLen = j - idStart;
    if (idLen < 1 || idLen > 64) return null;
    return { type, id: body.slice(idStart, j), end: j };
  }
  return null;
}

export function parseMentions(body: string): ParsedMentions {
  const mentions: Mention[] = [];
  const n = body.length;
  let i = 0;
  let inCodeSpan = false;
  let inFence = false;

  while (i < n) {
    const ch = body[i];

    if (ch === '\\') {
      i += body[i + 1] === '@' || body[i + 1] === '#' ? 2 : 1;
      continue;
    }

    // A single backtick toggles a code span; a line-start run of three or
    // more toggles a fenced block.
    if (ch === '`') {
      let run = 0;
      while (i + run < n && body[i + run] === '`') run += 1;
      const atLineStart = i === 0 || body[i - 1] === '\n';
      if (inFence) {
        if (run >= 3 && atLineStart) inFence = false;
      } else if (inCodeSpan) {
        if (run === 1) inCodeSpan = false;
      } else if (run >= 3 && atLineStart) {
        inFence = true;
      } else if (run === 1) {
        inCodeSpan = true;
      }
      i += run;
      continue;
    }

    if (inFence || inCodeSpan) {
      i += 1;
      continue;
    }

    if (ch === '@') {
      if (i > 0 && isWordChar(body.charAt(i - 1))) {
        i += 1;
        continue;
      }
      const end = scanHandle(body, i + 1);
      if (end !== null) {
        const handle = body.slice(i + 1, end);
        const kind: MentionKind = handle.toLowerCase() === 'bob' ? 'assistant' : 'person';
        mentions.push({ kind, handle, start: i, end, raw: body.slice(i, end) });
        i = end;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '#') {
      const resource = scanResource(body, i);
      if (resource !== null) {
        const raw = body.slice(i, resource.end);
        mentions.push({
          kind: 'resource',
          resourceType: resource.type,
          handle: resource.id,
          start: i,
          end: resource.end,
          raw,
        });
        i = resource.end;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return { mentions, addressesAssistant: mentions.some((m) => m.kind === 'assistant') };
}

type ResolvedPeople = {
  /** The member's canonical (derived) handle, lowercased. */
  handle: string;
  user_id: string;
};

type ResolveMentionsResult = {
  /** True when at least one `@bob` assistant mention is present. */
  addressesAssistant: boolean;
  /** One entry per distinct user, in first-mention order; never `@bob`. */
  people: ResolvedPeople[];
  /** Lowercased handles that matched no member -- reported, never guessed. */
  unresolved: string[];
};

/** Resolves person mentions against the caller-supplied members, case-insensitively. */
export function resolveMentions(
  body: string,
  members: ReadonlyArray<{ user_id: string; handle: string }>,
): ResolveMentionsResult {
  const parsed = parseMentions(body);
  const userIdByHandle = new Map<string, string>();
  for (const member of members) {
    userIdByHandle.set(member.handle.toLowerCase(), member.user_id);
  }
  const people: ResolvedPeople[] = [];
  const seenUsers = new Set<string>();
  const unresolved: string[] = [];
  for (const mention of parsed.mentions) {
    if (mention.kind !== 'person') continue;
    const lower = mention.handle.toLowerCase();
    const user_id = userIdByHandle.get(lower);
    if (user_id === undefined) {
      unresolved.push(lower);
      continue;
    }
    if (seenUsers.has(user_id)) continue;
    seenUsers.add(user_id);
    people.push({ handle: lower, user_id });
  }
  return { addressesAssistant: parsed.addressesAssistant, people, unresolved };
}