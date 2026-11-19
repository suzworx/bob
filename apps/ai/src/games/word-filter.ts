/**
 * Player word filter for games (safety.md S2): the Silly Stories words and the
 * 20 Questions secret. This is a CHILD-SAFETY CONTENT filter over reviewed
 * lists in content/wordlists/, and nothing else: it never decides intent or
 * picks a tool. A failed word is never echoed back (the verdict carries only a
 * reason class).
 *
 * Pipeline: NFKC, lower case, accents and homoglyphs folded, zero-width and
 * apostrophes removed, leetspeak folded (two variants for the 1/l ambiguity),
 * repeated letters squashed, plural and verb suffixes stripped, then matched
 * against whole blocked words, a few unambiguous blocked roots, and runs of
 * spaced-out letters ("f u c k") joined together. For band 'little' every token
 * must also be on the child vocabulary allowlist.
 */
import { z } from 'zod';
import type { Band } from './engine.ts';
import blocklistJson from './content/wordlists/blocklist.json' with { type: 'json' };
import allowlistJson from './content/wordlists/allowlist-little.json' with { type: 'json' };

const blocklistSchema = z.object({ words: z.array(z.string()), substrings: z.array(z.string()), exceptions: z.array(z.string()) });
const allowlistSchema = z.object({ words: z.array(z.string()) });
const blocklist = blocklistSchema.parse(blocklistJson);
const BLOCKED_WORDS: ReadonlySet<string> = new Set([...blocklist.words, ...blocklist.substrings]);
const BLOCKED_ROOTS: readonly string[] = blocklist.substrings;
const EXCEPTIONS: ReadonlySet<string> = new Set(blocklist.exceptions);
const ALLOWED_LITTLE: ReadonlySet<string> = new Set(allowlistSchema.parse(allowlistJson).words);

type WordFilterReason = 'empty' | 'blocked' | 'not_in_allowlist';
type WordFilterVerdict = { ok: true; word: string } | { ok: false; reason: WordFilterReason };

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  'а': 'a', 'в': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'ё': 'e', 'һ': 'h', 'н': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j',
  'к': 'k', 'м': 'm', 'о': 'o', 'р': 'p', 'ԛ': 'q', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ү': 'y',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'ı': 'i', 'ɑ': 'a', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd',
};
const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '+': 't', '€': 'e', '£': 'l', '¡': 'i', '|': 'i',
};
const LEET_ALT: Readonly<Record<string, string>> = { ...LEET, '1': 'l', '|': 'l', '!': 'l' };
const CHUNK = /[\p{L}\p{N}@$!+|€£¡]+/gu;
const MASKED = /\p{L}[*#]+\p{L}|\p{L}[*#]{2,}/u;

/** Case, width, accent and homoglyph folding shared by every check. */
export function foldText(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const ch of folded) out += HOMOGLYPHS[ch] ?? ch;
  return out.replace(/[­​-‏⁠﻿]/g, '').replace(/['’`]/g, '');
}

/** Letter-only tokens after the leet fold; pure numbers are not words. */
function leetTokens(folded: string, map: Readonly<Record<string, string>>): string[] {
  const tokens: string[] = [];
  for (const raw of folded.match(CHUNK) ?? []) {
    const chunk = raw.replace(/[!|¡]+$/u, '');
    if (!/\p{L}/u.test(chunk)) continue;
    const mapped = [...chunk].map((ch) => map[ch] ?? ch).join('');
    tokens.push(...(mapped.match(/\p{L}+/gu) ?? []));
  }
  return tokens;
}

/** Every way to shorten each repeated-letter run to one or two letters. */
function squashes(token: string): string[] {
  const runs = token.match(/(.)\1*/gu) ?? [];
  if (runs.filter((r) => r.length > 1).length > 6) return [token.replace(/(.)\1+/gu, '$1$1'), token.replace(/(.)\1+/gu, '$1')];
  let out = [''];
  for (const run of runs) {
    const ch = run[0] ?? '';
    const options = run.length > 1 ? [ch, ch + ch] : [ch];
    out = out.flatMap((prefix) => options.map((o) => prefix + o));
  }
  return out;
}

/** The token plus its base forms with a plural or verb suffix removed. */
function stems(word: string): string[] {
  const out = [word];
  const add = (stem: string): void => { if (stem.length >= 3) out.push(stem); };
  if (word.endsWith('ies')) add(word.slice(0, -3) + 'y');
  if (/(s|x|z|ch|sh)es$/u.test(word)) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  for (const suffix of ['ing', 'ed']) {
    if (word.endsWith(suffix)) { add(word.slice(0, -suffix.length)); add(word.slice(0, -suffix.length) + 'e'); }
  }
  return out;
}

function isBlockedToken(token: string): boolean {
  if (EXCEPTIONS.has(token)) return false;
  for (const squashed of squashes(token)) {
    if (EXCEPTIONS.has(squashed)) return false;
    for (const form of stems(squashed)) {
      if (BLOCKED_WORDS.has(form) || BLOCKED_ROOTS.some((root) => form.includes(root))) return true;
    }
  }
  return false;
}

/** Joins runs of 2+ consecutive tokens of at most 2 letters: "f u c k", "fu ck". */
function spacedRuns(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  for (const token of [...tokens, '__end__']) {
    if (token.length <= 2) { run.push(token); continue; }
    if (run.length >= 2) out.push(run.join(''));
    run = [];
  }
  return out;
}

/** True when any word in the text is blocked. Shared with kidSafeText (S8). */
export function containsBlockedWord(text: string): boolean {
  const folded = foldText(text);
  if (MASKED.test(folded)) return true;
  for (const map of [LEET, LEET_ALT]) {
    const tokens = leetTokens(folded, map);
    if ([...tokens, ...spacedRuns(tokens)].some(isBlockedToken)) return true;
  }
  return false;
}

function allAllowedForLittle(text: string): boolean {
  const tokens = foldText(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
  return tokens.length > 0 && tokens.every((t) =>
    /^\p{N}{1,3}$/u.test(t) || (/^\p{L}+$/u.test(t) && stems(t).some((s) => ALLOWED_LITTLE.has(s))));
}

/** Filters one player-supplied word or short phrase for a band (safety.md S2). */
export function wordFilter(word: string, band: Band): WordFilterVerdict {
  const cleaned = word.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return { ok: false, reason: 'empty' };
  if (containsBlockedWord(cleaned)) return { ok: false, reason: 'blocked' };
  if (band === 'little' && !allAllowedForLittle(cleaned)) return { ok: false, reason: 'not_in_allowlist' };
  return { ok: true, word: cleaned };
}
