/**
 * Who a task tool means by "assign it to X". The model passes
 * the name or @handle as the person said or typed it -- often through speech to
 * text ("Samir number four work" for @sameer4work) -- and this resolves it to
 * exactly one active member of the task's space, or fails naming the candidates
 * so the model asks instead of claiming an assignment it never made.
 *
 * matchAssignee is pure; resolveToolAssignee reads the members (listMembers runs
 * under the actor's RLS, so only a fellow member's names are ever seen).
 */
import { type Db } from '../platform/db/db.ts';
import { listMembers } from '../spaces/store.ts';

/** A space member as the matcher sees it. */
export type AssigneeCandidate = { userId: string; displayName: string | null; handle: string };

export type AssigneeMatch =
  | { kind: 'match'; member: AssigneeCandidate }
  | { kind: 'ambiguous' | 'none'; candidates: AssigneeCandidate[] };

const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
/** Words speech adds around a handle: "number four", "jane dot doe". */
const FILLER = new Set(['number', 'dot', 'underscore', 'dash', 'hyphen']);

/** Lowercase ASCII words of `raw`, accents folded, spoken digits as digits, filler dropped. */
function words(raw: string): string[] {
  const tokens = raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  if (tokens[0] === 'at' && tokens.length > 1) tokens.shift(); // a spoken "@"
  return tokens.filter((token) => !FILLER.has(token)).map((token) => SPOKEN_DIGITS[token] ?? token);
}

/** A rough sound-alike fold for speech-to-text spellings: Samir, Sameer and Samyr all fold to "samir". */
function fold(key: string): string {
  return key.replace(/th/g, 't').replace(/ph/g, 'f').replace(/ee|ea|ie|y/g, 'i').replace(/oo|ou/g, 'u')
    .replace(/(.)\1+/g, '$1');
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitute));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The keys a member answers to: handle, full name and each name word, squashed. */
function keysOf(member: AssigneeCandidate): { handle: string; names: string[] } {
  const name = words(member.displayName ?? '');
  return { handle: words(member.handle).join(''), names: name.length === 0 ? [] : [name.join(''), ...name] };
}

/**
 * Resolves a spoken or typed name or @handle to one member. Only the exact-handle,
 * exact-name (or one word of it) and sound-alike tiers may settle on a single
 * member; a prefix or small-typo hit is never enough on its own -- it still fails
 * naming the candidates so the model asks instead of guessing. A sound-alike or
 * typo key must be the @handle or 6+ characters, so a short name isn't one
 * phonetic slip or typo away from a different person. No hit at all returns
 * every member.
 */
export function matchAssignee(spoken: string, members: AssigneeCandidate[]): AssigneeMatch {
  const query = words(spoken).join('');
  if (query.length === 0) return { kind: 'none', candidates: members };
  const folded = fold(query);
  const keyed = members.map((member) => {
    const { handle, names } = keysOf(member);
    return { member, handle, all: [handle, ...names] };
  });
  const fuzzyKey = (entry: (typeof keyed)[number], key: string) => key.length >= 6 || key === entry.handle;
  const tiers: Array<{ hits: (entry: (typeof keyed)[number]) => boolean; resolves: boolean }> = [
    { hits: (entry) => entry.handle === query, resolves: true },
    { hits: (entry) => entry.all.includes(query), resolves: true },
    { hits: (entry) => entry.all.some((key) => fuzzyKey(entry, key) && fold(key) === folded), resolves: true },
    { hits: (entry) => query.length >= 3 && entry.all.some((key) => fold(key).startsWith(folded)), resolves: false },
    {
      hits: (entry) => query.length >= 4
        && entry.all.some((key) => fuzzyKey(entry, key) && editDistance(query, key) <= Math.floor(key.length / 4)),
      resolves: false,
    },
  ];
  for (const tier of tiers) {
    const [first, ...rest] = keyed.filter(tier.hits).map((entry) => entry.member);
    if (!first) continue;
    if (tier.resolves && rest.length === 0) return { kind: 'match', member: first };
    return { kind: 'ambiguous', candidates: [first, ...rest] };
  }
  return { kind: 'none', candidates: members };
}

/** How a reply names a member: "Maya Rao (@maya.rao)", or just "@maya" when the name adds nothing. */
export function assigneeLabel(member: AssigneeCandidate): string {
  const name = member.displayName?.trim();
  return name && name.toLowerCase() !== member.handle ? `${name} (@${member.handle})` : `@${member.handle}`;
}

/**
 * The assignee a task tool asked for, resolved against `spaceId`'s active
 * members: undefined leaves the task's assignee alone, null clears it, a name
 * resolves to exactly one member. Throws an Error whose message lists the
 * candidates when the name is unknown or ambiguous -- the tool hands that
 * reason to the model, which asks the person which one they meant.
 */
export async function resolveToolAssignee(
  db: Db,
  actorUserId: string,
  spaceId: string,
  spoken: string | null | undefined,
): Promise<{ userId: string | null; label: string | null } | undefined> {
  if (spoken === undefined) return undefined;
  if (spoken === null) return { userId: null, label: null };
  const result = matchAssignee(spoken, await listMembers(db, actorUserId, spaceId));
  if (result.kind === 'match') return { userId: result.member.userId, label: assigneeLabel(result.member) };
  const names = result.candidates.map(assigneeLabel).join(', ');
  throw new Error(result.kind === 'ambiguous'
    ? `"${spoken}" matches more than one member: ${names}. Ask which one they mean; nothing was changed.`
    : `No member of this space matches "${spoken}". Members: ${names}. Ask who they mean; nothing was changed.`);
}
