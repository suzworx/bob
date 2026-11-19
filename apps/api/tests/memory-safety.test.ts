/**
 * Table-driven tests for the shared secret classifier (spec 010, T008,
 * FR-018). Runs inside apps/api's Vitest suite and imports the classifier
 * from apps/ai by relative path (the same form as reply-limits.test.ts).
 *
 * Fake secret tokens are assembled at RUNTIME from parts so no literal
 * secret-shaped string appears in this source (the validate.mjs staged-diff
 * scan would reject it).
 */
import { describe, expect, it } from 'vitest';
import { secretReason } from '@bob/ai';
import { isSecretLike } from '@bob/ai/testing';

const x = (n: number): string => 'x'.repeat(n);
const A = (n: number): string => 'A'.repeat(n);

// Secret-shaped tokens, built at runtime from parts.
const tokens = {
  openai: `sk-${x(40)}`,
  stripeLive: `sk_live_${x(24)}`,
  stripePub: `pk_live_${x(24)}`,
  githubPat: `ghp_${x(24)}`,
  githubOAuth: `gho_${x(24)}`,
  githubFineGrained: `github_pat_${x(24)}`,
  slack: `xoxb-${x(24)}`,
  aws: `AKIA${A(16)}`,
  google: `AIza${'Sy'.repeat(16)}abcd`,
  stripeConnect: `vck_${x(40)}`,
  jwt: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${x(20)}abc`,
  pem: `-----BEGIN RSA PRIVATE KEY-----\n${x(64)}\n-----END RSA PRIVATE KEY-----`,
  pemOpenSsh: `-----BEGIN OPENSSH PRIVATE KEY-----`,
  base64: `${'aB3xZ9Qw7k'.repeat(5)}==`,
  hex: `${'a0b1c2d3e4f5'.repeat(8)}`,
};

const positive: Array<[string, string]> = [
  ['openai key prefix', tokens.openai],
  ['stripe live key', tokens.stripeLive],
  ['stripe publishable key', tokens.stripePub],
  ['github personal access token', tokens.githubPat],
  ['github oauth token', tokens.githubOAuth],
  ['github fine-grained token', tokens.githubFineGrained],
  ['slack token', tokens.slack],
  ['aws access key id', tokens.aws],
  ['google api key', tokens.google],
  ['vercel ai gateway key', tokens.stripeConnect],
  ['jwt', tokens.jwt],
  ['pem rsa private key', tokens.pem],
  ['pem openssh private key', tokens.pemOpenSsh],
  ['long base64 run', tokens.base64],
  ['long hex run', tokens.hex],
];

const labelled = [
  'the password is hunter2',
  'my password is s3cr3t',
  'passcode: 4821',
  'the passcode is 123456',
  'my PIN is 4821',
  'PIN: 2210',
  'api key sk-proj value',
  'my api key is abc123',
  'the api-key is abcd1234',
  'recovery code is 4821 9301',
  'my recovery code is 4477',
  'OTP is 395817',
  'otp: 921034',
  'security answer is flanders',
  'my security answer: rosewood',
  'password = correcthorse',
  'api key: abcd1234',
  'password is hunter2',
  'PIN 4821',
  'pin: 0000',
  'password is secret',
];

const negative = [
  'I see Dr. Patel on Tuesdays',
  'I bank with HDFC',
  'my locker is 2210',
  'call me at 5pm',
  'my flight is AI 302',
  'the dog is 5 years old',
  'I prefer chai over coffee',
  'my apartment is on floor 4',
  'what time is the meeting at 3pm',
  'recovery is going well',
  'API documentation is in the wiki',
  'I use two factor auth',
  'the answer is 42',
  'Dr. Patel, please call 555-0100',
  'allergic to peanuts',
  'I spin 100 laps on Sunday',
  'pin the meeting notes',
  'I forgot my password yesterday',
  'reset my passcode later',
  'the passcode feature is broken',
  'drop a pin at the cafe',
  x(45),
  `${'abcdefgh/'.repeat(6)}`,
  'portfolio-john.photography.wordpressco',
];

describe('isSecretLike', () => {
  it.each(positive)('flags a %s', (_label, text) => {
    expect(isSecretLike(text)).toBe(true);
  });

  it.each(negative)('does not flag: %s', (text) => {
    expect(isSecretLike(text)).toBe(false);
  });

  it.each(labelled)('flags a labelled secret: %s', (text) => {
    expect(isSecretLike(text)).toBe(true);
    expect(secretReason(text)).toBe('labelled');
  });

  it.each(positive)('reports token reason for a %s', (_label, text) => {
    expect(secretReason(text)).toBe('token');
  });

  it('reports null for a bare number and ordinary facts', () => {
    expect(secretReason('2210')).toBeNull();
    expect(secretReason('4821')).toBeNull();
    expect(secretReason('I bank with HDFC')).toBeNull();
  });

  it('handles empty and whitespace-only input', () => {
    expect(isSecretLike('')).toBe(false);
    expect(isSecretLike('   ')).toBe(false);
    expect(secretReason('')).toBeNull();
  });

  it('returns a 2,000-character adversarial input in under 50 ms', () => {
    const adversarial = `ab cd ef gh ij kl mn op qr st uv wx yz ${'ab cd ef gh ij kl mn op qr st uv wx yz '.repeat(66)}`;
    const input = adversarial.slice(0, 2000);
    const start = performance.now();
    isSecretLike(input);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
// MEM-SAFE: structural detectors for payment cards, SSNs and credential pairs.
// 4111 1111 1111 1111 / 5555 5555 5555 4444 / 3782 822463 10005 are the
// issuers' published test numbers.
const structural: Array<[string, string, string]> = [
  ['spaced Visa', 'My Visa number is 4111 1111 1111 1111', 'payment_card'],
  ['card with expiry and cvv', 'my card is 4111111111111111 exp 12/28 cvv 123', 'payment_card'],
  ['dashed Mastercard', 'mastercard 5555-5555-5555-4444', 'payment_card'],
  ['Amex grouping', 'amex 3782 822463 10005', 'payment_card'],
  ['cvv with an expiry only', 'expires 09/27, CVV 456', 'payment_card'],
  ['cvv with a mistyped card', 'card 4111 1111 1111 1112 cvc: 789', 'payment_card'],
  ['SSN', 'My SSN: 123-45-6789', 'government_id'],
  ['spaced SSN', 'social is 123 45 6789', 'government_id'],
  ['login and password', 'my bank login is bob and hunter2', 'credential'],
  ['username with symbol password', 'username: alice.w, pass Tr0ub4dor&3', 'credential'],
];

const structuralNegative = [
  'call me on +1 555 010 0199',
  'my number is 555-010-0199',
  'my phone is 98450 12345',
  'we met on 2026-09-27',
  'the party is on 12/28',
  'born in 1987, moved in 2004',
  'order number 1234567890123',
  'tracking 9400 1000 0000 0000 0000 00',
  'invoice 1234 5678 9012 3456',
  'the meeting is 10-12 2026',
  'area 000-12-3456 is never issued',
  'my username is bob',
  'my username is bob42',
  "User's login id is sunbeam42.",
  'my user id is ravi_k and my login name is ravi2024',
  'my login is bob and I changed it in 2024',
  'I got a new credit card last week',
  'the cvv field is on the back',
];

describe('isSecretLike structural detectors (MEM-SAFE)', () => {
  it.each(structural)('flags a %s', (_label, text, reason) => {
    expect(isSecretLike(text)).toBe(true);
    expect(secretReason(text)).toBe(reason);
  });

  it.each(structuralNegative)('does not flag: %s', (text) => {
    expect(secretReason(text)).toBeNull();
  });

  it('rejects a Luhn-invalid card with no cvv', () => {
    expect(isSecretLike('4111 1111 1111 1112')).toBe(false);
  });

  it('stays linear on a long digit-and-space run', () => {
    const input = '1 '.repeat(1000);
    const start = performance.now();
    isSecretLike(input);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
