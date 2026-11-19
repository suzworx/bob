/**
 * Shared secret classifier (FR-018). Pure, deterministic, linear-time.
 *
 * `isSecretLike` / `secretReason` decide whether a string carries a secret
 * that must never be stored: passwords, passcodes, PINs, API keys, recovery
 * codes, JWTs, PEM private keys, and (by data format) payment card
 * numbers, a CVV beside a card or expiry, US SSNs, and a login paired with a
 * password-shaped token. The `remember` tool (apps/ai) and the
 * extraction worker (apps/api, importing through the allowed @/ai direction)
 * both call it, so a secret is refused on the explicit path and dropped on
 * the automatic path.
 *
 * Sensitive-but-storable facts (FR-017) such as health, finance, or "I bank
 * with HDFC" are NOT flagged; only labelled secret values and secret-shaped
 * tokens are. A bare number ("my locker is 2210") is not a secret; a number
 * labelled as a PIN, passcode, or password is.
 */

/** A secret-shaped token: PEM private-key header, JWT, API-key prefix, or a
 * long high-entropy base64/hex run (32+ chars). */
const TOKEN_PATTERN = new RegExp(
  [
    // PEM private-key header: -----BEGIN [OPENSSH |RSA |EC |DSA ]PRIVATE KEY-----
    '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----',
    // JWT: first segment is base64url of `{"` (starts eyJ), then three
    // base64url segments, dot-separated.
    'eyJ[A-Za-z0-9_-]{7,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    // API-key prefixes with a substantive tail.
    [
      'sk-[A-Za-z0-9]{20,}', // OpenAI
      '(?:sk_live_|pk_live_)[A-Za-z0-9]{20,}', // Stripe
      '(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}', // GitHub
      'xox[abp]-[A-Za-z0-9]{20,}', // Slack
      'AKIA[0-9A-Z]{16}', // AWS access key id
      'AIza[0-9A-Za-z_-]{30,}', // Google API key
      'vck_[A-Za-z0-9_-]{40,}', // Vercel AI Gateway key
    ].join('|'),
    // Long high-entropy base64/hex run (32+ contiguous chars) that contains at
    // least one digit AND one letter (so ordinary long words and letter-only
    // URL paths are not flagged).
    '(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{32,}',
  ].join('|'),
);

/** A labelled secret value: a secret label, then EITHER an explicit connector
 * (is, was, means, equals, :, =, "is set to", "is now") followed by a value
 * token, OR a value token containing at least one digit or symbol right after
 * the label ("PIN 4821", "password hunter2!"). Ordinary words after a label
 * with no connector are NOT secret ("pin the meeting notes"). */
const LABELLED_PATTERN =
  /\b(?:password|passcode|pin|otp|recovery code|security answer|api[\s-]?key)\b(?:\s*(?:is set to|is now|is|was|means|equals|[:=])\s*[A-Za-z0-9._@#+!/\\-]{3,}|\s*[A-Za-z0-9._@#+!/\\-]*[0-9._@#+!/\\-][A-Za-z0-9._@#+!/\\-]{2,})/i;

/** A run of 13-19 digits, each optionally followed by one space or dash: the
 * printed shape of a payment card number. */
const CARD_RUN_PATTERN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

/** Issuer prefixes (IIN ranges) with their allowed lengths: Visa, Mastercard,
 * Amex, Diners, Discover, JCB, UnionPay. A Luhn-valid run with no issuer
 * prefix (an order number, a tracking id) is not a card. */
const CARD_ISSUER_PATTERN =
  /^(?:4(?:\d{12}|\d{15}|\d{18})|5[1-5]\d{14}|2(?:22[1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720)\d{12}|3[47]\d{13}|3(?:0[0-5]|[689]\d)\d{11}|6(?:011|5\d{2}|4[4-9]\d)\d{12,15}|35(?:2[89]|[3-8]\d)\d{12,15}|62\d{14,17})$/;

/** A labelled card verification value: CVV / CVC / CVV2 / CID, then 3-4 digits. */
const CVV_PATTERN = /\b(?:cvv2?|cvc2?|cid)\b\s*(?:is|:|=|#)?\s*\d{3,4}\b/i;

/** A card expiry: MM/YY or MM/YYYY (slash or dash). */
const EXPIRY_PATTERN = /(?<![\d/])(?:0[1-9]|1[0-2])\s*[/-]\s*(?:\d{2}|20\d{2})(?![\d/])/;

/** US SSN: AAA-GG-SSSS (or spaced), excluding never-issued areas 000, 666,
 * 900-999, group 00 and serial 0000. A phone (3-3-4) or ISO date (4-2-2)
 * has a different shape. */
const SSN_PATTERN = /(?<![\d-])(?!000|666|9\d{2})\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/;

/** An account identifier label with its value ("login is bob", "username: bob"). */
const LOGIN_PATTERN =
  /\b(?:login id|login name|login|log-in|username|user name|user id|userid|sign-in)\b\s*(?:is|was|:|=)?\s*([A-Za-z0-9._@+-]{2,})/i;

/** A password-shaped token: 6+ chars mixing letters with a digit or symbol. */
const PASSWORD_TOKEN_PATTERN =
  /(?<![A-Za-z0-9._@#+!$%&*-])(?=[A-Za-z0-9._@#+!$%&*-]*[A-Za-z])(?=[A-Za-z0-9._@#+!$%&*-]*[0-9#+!$%&*])[A-Za-z0-9._@#+!$%&*-]{6,}(?![A-Za-z0-9._@#+!$%&*-])/g;

/** Luhn checksum over a digit string. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Digit strings of every card-shaped run in `text` (separators removed). */
function cardRuns(text: string): string[] {
  return Array.from(text.matchAll(CARD_RUN_PATTERN), (m) => m[0].replace(/[ -]/g, ''));
}

/** True for a payment card: a Luhn-valid issuer-prefixed number, or a CVV
 * next to any card-shaped number or an expiry. */
function hasPaymentCard(text: string): boolean {
  const runs = cardRuns(text);
  if (runs.some((digits) => CARD_ISSUER_PATTERN.test(digits) && luhnValid(digits))) return true;
  return CVV_PATTERN.test(text) && (runs.length > 0 || EXPIRY_PATTERN.test(text));
}

/** True for a login label with its value plus a separate password-shaped
 * token. Every labelled identifier is removed first, so two identifiers
 * ("user id ... login name ...") are not read as a login and its password. */
function hasCredentialPair(text: string): boolean {
  const labelled = new RegExp(LOGIN_PATTERN.source, 'gi');
  const logins = Array.from(text.matchAll(labelled), (m) => m[1]!);
  if (logins.length === 0) return false;
  const rest = text.replace(labelled, ' ');
  return Array.from(rest.matchAll(PASSWORD_TOKEN_PATTERN)).some((m) => !logins.includes(m[0]));
}

type SecretReason = 'labelled' | 'token' | 'payment_card' | 'government_id' | 'credential';

/** Returns the secret category of `text`, or null when it is not secret-like.
 * Callers journal this category and never the text (FR-013). */
export function secretReason(text: string): SecretReason | null {
  if (TOKEN_PATTERN.test(text)) return 'token';
  if (LABELLED_PATTERN.test(text)) return 'labelled';
  if (hasPaymentCard(text)) return 'payment_card';
  if (SSN_PATTERN.test(text)) return 'government_id';
  if (hasCredentialPair(text)) return 'credential';
  return null;
}

/** True when `text` carries a secret that must never be stored (FR-018). */
export function isSecretLike(text: string): boolean {
  return secretReason(text) !== null;
}
