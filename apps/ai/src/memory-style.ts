/**
 * One canonical voice for every stored memory ("User has a wife named Maya.", never "My wife's name
 * is Maya"): the same fact in two voices shares too few words for the duplicate check.
 *
 * The extractor prompt and the `remember` tool description both carry
 * MEMORY_CONTENT_STYLE; canonicalMemoryVoice is the deterministic net under
 * them for the sentence-initial first person a model still slips into.
 */

/** The phrasing rule both memory writers are given. */
export const MEMORY_CONTENT_STYLE =
  'Write the memory as one short third-person sentence about the user, starting with "User": ' +
  '"User\'s wife\'s name is Maia.", "User is vegetarian.", "User prefers tea over coffee." ' +
  'For a named attribute, use "User\'s <attribute> is <value>." Never write "I", "my" or "you".';

/** The same rule, short, for the `remember` tool description. */
export const MEMORY_CONTENT_STYLE_SHORT =
  'Write one third-person sentence starting with "User", e.g. "User\'s wife\'s name is Maia."';

/** Sentence-initial first person, rewritten to the canonical subject. Ordered:
 *  the contracted and two-word forms before the bare pronoun. */
const LEADING_FIRST_PERSON: ReadonlyArray<[RegExp, string]> = [
  [/^i am\b/i, 'User is'],
  [/^i['’]m\b/i, 'User is'],
  [/^i['’]ve\b/i, 'User has'],
  [/^i have\b/i, 'User has'],
  [/^i was\b/i, 'User was'],
  [/^my\b/i, "User's"],
];

/** Verbs whose third-person form is the bare verb plus "s", for "I <verb>". */
const CONJUGATE_WITH_S = new Set([
  'like', 'love', 'prefer', 'hate', 'dislike', 'enjoy', 'live', 'work', 'own', 'drive',
  'eat', 'drink', 'play', 'speak', 'use', 'need', 'want', 'read', 'cook', 'run', 'support',
]);

/**
 * Rewrites a leading first-person subject to "User" ("My wife's name is
 * Maya" -> "User's wife's name is Maya"). Only the sentence opening is touched: a pronoun later in the sentence, or a
 * first-person verb form that needs more than a subject swap, is left alone
 * rather than guessed at.
 */
export function canonicalMemoryVoice(content: string): string {
  const text = content.trim();
  for (const [pattern, replacement] of LEADING_FIRST_PERSON) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  const verb = /^i\s+([a-z]+)\b/i.exec(text);
  if (verb?.[1] && CONJUGATE_WITH_S.has(verb[1].toLowerCase())) {
    return `User ${verb[1].toLowerCase()}s${text.slice(verb[0].length)}`;
  }
  return text;
}
