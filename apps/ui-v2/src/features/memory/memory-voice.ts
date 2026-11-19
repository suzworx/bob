// Memories are stored in one canonical third-person voice about "User"
// ("User is vegetarian.", "User's wife is Sam Example."), which is what the model
// reads back. The Memory page talks to the person, so it shows the same text
// addressed to them ("You're vegetarian.", "Your wife is Sam Example."). The rewrite
// is display-only: storage is unchanged, and an edit is turned back into the
// stored voice before it is saved.

/** Leading subject forms, ordered: the longer and contracted forms first. */
const LEADING_TO_READER: ReadonlyArray<[RegExp, string]> = [
  [/^User's\b/, 'Your'],
  [/^User is\b/, "You're"],
  [/^User has\b/, 'You have'],
  [/^User was\b/, 'You were'],
  [/^User does\b/, 'You do'],
  // Text a person typed themselves is stored as written, often first person.
  [/^I am\b/i, "You're"],
  [/^I['’]m\b/i, "You're"],
  [/^I['’]ve\b/i, "You've"],
  [/^I have\b/i, 'You have'],
  [/^I was\b/i, 'You were'],
  [/^My\b/i, 'Your'],
  [/^I\b/i, 'You'],
];

/** "prefers" -> "prefer", "watches" -> "watch", "studies" -> "study". */
function baseForm(verb: string): string {
  if (/ies$/.test(verb)) return `${verb.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z|o)es$/.test(verb)) return verb.slice(0, -2);
  if (/[^s]s$/.test(verb)) return verb.slice(0, -1);
  return verb;
}

/** The stored memory, addressed to the person reading it. */
export function memoryForReader(content: string): string {
  const text = content.trim();
  let out = text;
  let matched = false;
  for (const [pattern, replacement] of LEADING_TO_READER) {
    if (pattern.test(text)) {
      out = text.replace(pattern, replacement);
      matched = true;
      break;
    }
  }
  if (!matched) {
    const verb = /^User\s+([a-z]+)\b/.exec(text);
    if (verb?.[1]) out = `You ${baseForm(verb[1])}${text.slice(verb[0].length)}`;
  }
  // The rest of the sentence: only the exact canonical word, never "user" in
  // ordinary prose.
  return out.replace(/\bUser's\b/g, 'your').replace(/\bUser\b/g, 'you');
}

/** Verbs whose third-person form is the bare verb plus "s" (as memory-style.ts). */
const CONJUGATE_WITH_S = new Set([
  'like', 'love', 'prefer', 'hate', 'dislike', 'enjoy', 'live', 'work', 'own', 'drive',
  'eat', 'drink', 'play', 'speak', 'use', 'need', 'want', 'read', 'cook', 'run', 'support',
]);

const LEADING_TO_STORED: ReadonlyArray<[RegExp, string]> = [
  [/^You['’]re\b/i, 'User is'],
  [/^You are\b/i, 'User is'],
  [/^You['’]ve\b/i, 'User has'],
  [/^You have\b/i, 'User has'],
  [/^You were\b/i, 'User was'],
  [/^Your\b/i, "User's"],
];

/**
 * The inverse, for an edit made in the reader's voice. Only a leading subject
 * is rewritten; a verb form it does not know is left as typed rather than
 * guessed at.
 */
export function memoryForStorage(content: string): string {
  const text = content.trim();
  for (const [pattern, replacement] of LEADING_TO_STORED) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  const verb = /^You\s+([a-z]+)\b/i.exec(text);
  if (verb?.[1] && CONJUGATE_WITH_S.has(verb[1].toLowerCase())) {
    return `User ${verb[1].toLowerCase()}s${text.slice(verb[0].length)}`;
  }
  return text;
}

const PEOPLE = new RegExp(
  '\\b(' +
    [
      'wife', 'husband', 'partner', 'spouse', 'girlfriend', 'boyfriend', 'fiance', 'fiancee', 'fiancé', 'fiancée',
      'son', 'daughter', 'sons', 'daughters', 'kid', 'kids', 'child', 'children', 'baby',
      'mother', 'mom', 'mum', 'father', 'dad', 'parents', 'sister', 'brother', 'sibling', 'siblings',
      'grandmother', 'grandma', 'grandfather', 'grandpa', 'aunt', 'uncle', 'cousin', 'niece', 'nephew',
      'friend', 'friends', 'colleague', 'coworker', 'boss', 'manager', 'neighbor', 'neighbour',
      'mother-in-law', 'father-in-law', 'roommate',
    ].join('|') +
    ')\\b',
  'i',
);

/** A fact about someone in the person's life ("User's wife is Sam Example."). */
export function isAboutPeople(content: string): boolean {
  return PEOPLE.test(content);
}
