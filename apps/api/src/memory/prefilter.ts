/**
 * Memory pre-filter. A `skip` verdict skips the turn's memory search and its
 * extraction call; BOB_MEMORY_PREFILTER_ENFORCE=0 reverts to journaling the
 * verdict only. A literal, whole-message skip-list: anything else, and any
 * error, is `keep` (a wrong skip would silently lose a memory; a wrong keep
 * only costs one extraction call).
 *
 * Confirmatory replies ("sure", "ok", "go ahead", "sounds good", "continue",
 * and "yes"/"y") can accept an assistant's offer ("Want me to remind you at
 * 5?", "Shall I switch you to metric?"), and the extractor reads the
 * assistant text, so the turn can carry an action item or a preference. They
 * get their own reason, `confirmation`, and are ALWAYS `keep`: journaled so
 * the shadow data shows how common they are, never counted as a skip.
 *
 * The `short` rule skips only a single letter (symbols already normalise to
 * `empty`); a lone digit is kept because it can answer a question ("How many
 * kids?" -> "2").
 */

/** Bumped whenever a list or rule changes, so journal analysis never mixes versions. */
export const PREFILTER_VERSION = 'rules-v2';

type PrefilterVerdict = 'skip' | 'keep';
type PrefilterReason = 'ack' | 'control' | 'confirmation' | 'empty' | 'short' | 'none';
type UserCharsBucket = '0-10' | '11-40' | '41-120' | '120+';

interface PrefilterResult {
  verdict: PrefilterVerdict;
  reason: PrefilterReason;
}

/** Normalised messages at or below this length (and not empty) are `short`,
 *  unless they contain a digit (a lone digit can be an answer). */
const SHORT_MAX_CHARS = 1;

const ACK_PHRASES: ReadonlySet<string> = new Set([
  'thanks', 'thank you', 'thanks a lot', 'thank you so much', 'thank you very much', 'thanks so much',
  'many thanks', 'thx', 'ty', 'cheers', 'ok thanks', 'okay thanks', 'ok thank you',
  'okay thank you', 'cool', 'great', 'nice', 'got it', 'gotcha',
  'awesome', 'noted', 'understood', 'i see', 'makes sense',
  'hmm', 'hm', 'uh huh', 'mhm', 'lol', 'haha', 'wow', 'good', 'fine', 'bye', 'goodbye', 'good night',
  'see you', 'see ya', 'hi', 'hello', 'hey', 'hey there', 'hi there', 'good morning', 'good evening',
  'great thanks', 'cool thanks', 'perfect thanks', 'nice one', 'thats great', 'thats all', 'that is all',
]);

const CONTROL_PHRASES: ReadonlySet<string> = new Set([
  'stop', 'cancel', 'never mind', 'nevermind', 'pause', 'resume', 'repeat', 'repeat that',
  'say that again', 'again', 'louder', 'quieter', 'skip', 'next', 'wait', 'hold on', 'one moment',
  'be quiet', 'quiet', 'shh', 'stop talking', 'enough',
]);

/** Replies that may accept an assistant offer: always `keep` (reason `confirmation`). */
const CONFIRMATION_PHRASES: ReadonlySet<string> = new Set([
  'sure', 'ok', 'okay', 'k', 'kk', 'yes', 'y', 'go ahead', 'sounds good', 'perfect', 'alright',
  'all right', 'continue', 'go on', 'keep going',
]);

/** Lowercase, drop every character that is not a letter, digit or space
 *  (apostrophes join: "that's" -> "thats"), collapse whitespace. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function prefilter(userText: string): PrefilterResult {
  try {
    if (typeof userText !== 'string') return { verdict: 'keep', reason: 'none' };
    const text = normalise(userText);
    if (text.length === 0) return { verdict: 'skip', reason: 'empty' };
    if (CONFIRMATION_PHRASES.has(text)) return { verdict: 'keep', reason: 'confirmation' };
    if (ACK_PHRASES.has(text)) return { verdict: 'skip', reason: 'ack' };
    if (CONTROL_PHRASES.has(text)) return { verdict: 'skip', reason: 'control' };
    if (text.length <= SHORT_MAX_CHARS && !/\p{N}/u.test(text)) return { verdict: 'skip', reason: 'short' };
    return { verdict: 'keep', reason: 'none' };
  } catch {
    return { verdict: 'keep', reason: 'none' };
  }
}

/** A coarse length bucket of the raw user text (a count, never the text). */
export function userCharsBucket(text: string): UserCharsBucket {
  const length = typeof text === 'string' ? text.length : 0;
  if (length <= 10) return '0-10';
  if (length <= 40) return '11-40';
  if (length <= 120) return '41-120';
  return '120+';
}

/** Default on; one env var reverts to journal-only with no deploy if the
 *  skip-list ever produces a false positive in production. */
export function prefilterEnforced(): boolean {
  return process.env.BOB_MEMORY_PREFILTER_ENFORCE !== '0';
}
