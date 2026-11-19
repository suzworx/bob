/**
 * Output guard for kids' games (safety.md S8, S9). When any player is 'little'
 * or 'kid', the turn's final reply text passes through kidSafeText() before TTS
 * and before reply_text; on a failure the server speaks the last tool's `say`
 * instead and journals the reason class (never the text).
 *
 * This is a CHILD-SAFETY CONTENT filter over the model's own output. It never
 * reads the user's transcript, never decides intent and never picks a tool.
 * Each class below is one S8/S9 rule; add a pattern only with a test case.
 */
import { containsBlockedWord, foldText } from './word-filter.ts';

export type KidSafeReason =
  | 'blocked_word'        // S2 blocklist
  | 'url'                 // links or web addresses
  | 'long_number'         // 7+ digits, e.g. a phone number
  | 'personal_info'       // asking for name, age, address, school, phone, password
  | 'commerce'            // buying, ads, subscriptions
  | 'other_apps'          // other apps, sites or downloads
  | 'secret_or_persona';  // secrets, or claiming to be a real person or friend (S9)

type KidSafeVerdict = { ok: true } | { ok: false; reason: KidSafeReason };

const URL_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\//u,
  /\bwww\./u,
  /\b[a-z0-9-]+\.(com|org|net|io|app|co|uk|us|tv|gg|ly|me|info|biz|xyz|site|online)\b/u,
  /\bdot (com|org|net|co)\b/u,
];

const DIGIT_WORD = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const LONG_NUMBER_PATTERNS: readonly RegExp[] = [
  /(?:\d[\s\-.()]*){7,}/u,
  new RegExp(`\\b${DIGIT_WORD}(?:[\\s,-]+${DIGIT_WORD}){6,}\\b`, 'u'),
];

const PERSONAL_PATTERNS: readonly RegExp[] = [
  /\b(your|ur) (full |last |real |first |sur|family |middle )?names?\b/u,
  /\bwhat are you called\b/u,
  /\bhow old are (you|u)\b|\byour age\b|\byour birthday\b|\bwhen were you born\b|\bdate of birth\b/u,
  /\byour (home |house |street |email )?address\b|\bwhere (do|does) (you|your \w+) live\b|\bwhat street\b/u,
  /\byour (post|zip) ?code\b|\bwhat (town|city) do you live\b/u,
  /\b(your|ur) school\b|\b(what|which) school\b|\bgo to school\b|\bwhat grade are you\b|\byour teacher\b/u,
  /\byour (phone|mobile|cell|telephone)\b|\bphone number\b|\bnumber to (call|text)\b/u,
  /\bpassword\b|\bpass ?code\b|\bpin (code|number)\b/u,
  /\byour e-?mail\b/u,
];

const COMMERCE_PATTERNS: readonly RegExp[] = [
  /\b(buy|buying|bought|purchas\w*|subscri\w*|premium|in-app|checkout|coupon|discount code)\b/u,
  /\b(credit card|pay for|paying for|ask (your )?(mum|mom|dad|parents?) to pay)\b/u,
  /\b(ads?|advert\w*|sponsor\w*|commercials?)\b/u,
];

const OTHER_APPS_PATTERNS: readonly RegExp[] = [
  /\b(youtube|tiktok|instagram|snapchat|facebook|whatsapp|roblox|minecraft|fortnite|netflix|spotify|discord|twitch)\b/u,
  /\b(app store|google play|play store|download\w*|install\w*|another app|other apps?|websites?|web site|online games?)\b/u,
];

const PERSONA_PATTERNS: readonly RegExp[] = [
  /\b(our (little )?secret|keep ((it|this|that) )?(a |our )?secrets?|just between (us|you and me))\b/u,
  /\bdon'?t tell (your )?(mum|mom|dad|parents?|anyone|anybody|grown-?ups?|family)\b/u,
  /\bi am (a )?real (person|human|kid|boy|girl)\b|\bim (a )?real (person|human|kid|boy|girl)\b/u,
  /\b(i am|im) your (best |secret |real |only )?friend\b/u,
  /\bmeet (me|up)\b/u,
];

const CLASSES: ReadonlyArray<readonly [Exclude<KidSafeReason, 'blocked_word'>, readonly RegExp[]]> = [
  ['url', URL_PATTERNS],
  ['long_number', LONG_NUMBER_PATTERNS],
  ['personal_info', PERSONAL_PATTERNS],
  ['commerce', COMMERCE_PATTERNS],
  ['other_apps', OTHER_APPS_PATTERNS],
  ['secret_or_persona', PERSONA_PATTERNS],
];

/** Checks a reply meant for a kids' game. Returns the first failing class. */
export function kidSafeText(text: string): KidSafeVerdict {
  // Case, width and homoglyph folding; apostrophes are dropped ("don't" -> "dont").
  const folded = foldText(text).replace(/\s+/gu, ' ');
  for (const [reason, patterns] of CLASSES) {
    if (patterns.some((p) => p.test(folded))) return { ok: false, reason };
  }
  if (containsBlockedWord(text)) return { ok: false, reason: 'blocked_word' };
  return { ok: true };
}
