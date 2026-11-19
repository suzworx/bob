// Content lint for every games pack (epic #460; safety.md S1). Each pack is
// adapted to LintItem once, and every rule runs over every item, so later packs
// (Simon Says, Quiz, Stories) plug in by adding one adapter to PACKS.
import { describe, expect, it } from 'vitest';
import { type Band, kidSafeText } from '@bob/ai';
import { containsBlockedWord, wordFilter, riddlesJson, simonJson, LINE_CHARS, RIDDLE_PACK, RIDDLES_PER_GAME, riddlePackSchema, wrapLines, COMMANDS_PER_ROUND, commandId, eligible, SIMON_PACK, simonPackSchema } from '@bob/ai/testing';

interface LintItem {
  id: string;
  band: Band;
  /** Spoken or shown text: kidSafeText, blocklist, reading level for 'little'. */
  texts: string[];
  /** Player-facing words (answers): wordFilter for the item's band. */
  words: string[];
  /** Words that must never appear inside `texts` (an answer and its aliases). */
  secret: string[];
  /** Text drawn on the device, which must wrap into `maxLines` lines. */
  screen: string[];
}

interface LintPack {
  name: string;
  review: { status: string; reviewer: string | null };
  items: LintItem[];
  /** Rotating host copy by band (praise, encourage...). */
  copy: Array<{ band: Band; text: string }>;
  maxLines: number;
}

const riddles: LintPack = {
  name: 'animal_riddles',
  review: RIDDLE_PACK.review,
  maxLines: 2,
  items: RIDDLE_PACK.riddles.map((r) => ({
    id: r.id, band: r.band, texts: r.clues, words: [r.answer], secret: [r.answer, ...r.aliases], screen: r.clues,
  })),
  copy: Object.values(RIDDLE_PACK.copy).flatMap((pools) =>
    (Object.entries(pools) as Array<[Band, string[]]>).flatMap(([band, lines]) => lines.map((text) => ({ band, text })))),
};

const simon: LintPack = {
  name: 'simon_says',
  review: SIMON_PACK.review,
  // One command is one device line (line2 under "Simon says,").
  maxLines: 1,
  items: SIMON_PACK.commands.map((c) => ({ id: commandId(c), band: c.band, texts: [c.text], words: [], secret: [], screen: [c.text] })),
  copy: Object.values(SIMON_PACK.copy).flatMap((pools) =>
    (Object.entries(pools) as Array<[Band, string[]]>).flatMap(([band, lines]) => lines.map((text) => ({ band, text })))),
};

const PACKS: LintPack[] = [riddles, simon];

/** Rough syllables: vowel groups, a silent final e dropped, at least one. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch-Kincaid grade over a set of sentences. */
function fleschKincaid(texts: readonly string[]): number {
  const words = texts.flatMap((t) => t.split(/\s+/).filter((w) => /[a-z]/i.test(w)));
  const sentences = texts.reduce((n, t) => n + Math.max(1, (t.match(/[.!?]+/g) ?? []).length), 0);
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(s|es)?\\b`).test(text.toLowerCase());
}

const NEVER_FOR_LITTLE = /\b(wrong|no)\b/i;

/**
 * The 'little' tone list (safety.md S1: no death, injury, weapons or scary themes).
 * Little clues and copy stay gentle and concrete, so none of these words appear in
 * them. A content-safety list, not a phrase rule: it only ever fails the lint.
 */
const NOT_GENTLE = [
  'blood', 'bloody', 'bone', 'bones', 'skull', 'skeleton', 'guts', 'brain', 'skin', 'venom', 'poison', 'poisonous',
  'dead', 'death', 'die', 'dies', 'dying', 'kill', 'kills', 'killed', 'hunt', 'hunts', 'hunting', 'prey',
  'bite', 'bites', 'biting', 'sting', 'stings', 'fang', 'fangs', 'claw', 'claws', 'hurt', 'injury', 'weapon',
  'scary', 'scared', 'afraid', 'fear', 'danger', 'dangerous', 'threatened', 'escape', 'monster',
] as const;
const NOT_GENTLE_RE = new RegExp(`\\b(${NOT_GENTLE.join('|')})\\b`, 'i');

describe.each(PACKS)('content pack $name', (pack) => {
  it('awaits a human review and is never marked approved by a machine', () => {
    expect(pack.review).toEqual({ status: 'pending human review', reviewer: null });
  });

  it('has unique ids and every required field', () => {
    const ids = pack.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of pack.items) {
      expect(item.id, item.id).toMatch(/^[a-z_]+$/);
      expect(['little', 'kid', 'grown'], item.id).toContain(item.band);
      expect(item.texts.length, item.id).toBeGreaterThan(0);
      for (const text of item.texts) expect(text.trim().length, item.id).toBeGreaterThan(0);
    }
  });

  it('every text passes kidSafeText and the blocklist; every answer passes wordFilter for its band', () => {
    for (const item of pack.items) {
      for (const text of item.texts) {
        expect(kidSafeText(text), `${item.id}: ${text}`).toEqual({ ok: true });
        expect(containsBlockedWord(text), `${item.id}: ${text}`).toBe(false);
      }
      for (const word of item.words) expect(wordFilter(word, item.band), `${item.id}: ${word}`).toMatchObject({ ok: true });
      for (const word of item.secret) expect(containsBlockedWord(word), `${item.id}: ${word}`).toBe(false);
    }
  });

  it('texts never give away the answer or an alias', () => {
    for (const item of pack.items) {
      for (const text of item.texts) {
        for (const secret of item.secret) expect(containsWord(text, secret), `${item.id}: "${text}" says "${secret}"`).toBe(false);
      }
    }
  });

  it('screen text fits the device lines', () => {
    for (const item of pack.items) {
      for (const text of item.screen) expect(wrapLines(text, LINE_CHARS).length, `${item.id}: ${text}`).toBeLessThanOrEqual(pack.maxLines);
    }
  });

  it("'little' items read at grade 2 or below and never say wrong or no", () => {
    for (const item of pack.items.filter((i) => i.band === 'little')) {
      expect(fleschKincaid(item.texts), item.id).toBeLessThanOrEqual(2);
      for (const text of item.texts) expect(text, item.id).not.toMatch(NEVER_FOR_LITTLE);
    }
  });

  it("host copy is kid-safe and 'little' copy never says wrong or no", () => {
    for (const { band, text } of pack.copy) {
      expect(kidSafeText(text), text).toEqual({ ok: true });
      if (band === 'little') expect(text).not.toMatch(NEVER_FOR_LITTLE);
    }
  });

  it("'little' texts and copy are gentle: nothing from the NOT_GENTLE tone list", () => {
    for (const item of pack.items.filter((i) => i.band === 'little')) {
      for (const text of item.texts) expect(text, item.id).not.toMatch(NOT_GENTLE_RE);
    }
    for (const { band, text } of pack.copy) if (band === 'little') expect(text).not.toMatch(NOT_GENTLE_RE);
  });
});

describe('the NOT_GENTLE tone list', () => {
  it('catches the clue a parent flagged, and passes gentle ones', () => {
    expect('My tongue wraps around the back of my skull.').toMatch(NOT_GENTLE_RE);
    expect('I shed my old skin as I grow.').toMatch(NOT_GENTLE_RE);
    expect('I have soft fur and long whiskers.').not.toMatch(NOT_GENTLE_RE);
  });
});

describe('animal riddles pack', () => {
  it('parses, holds 60 riddles, and every band can fill a game', () => {
    expect(riddlePackSchema.safeParse(riddlesJson).success).toBe(true);
    expect(RIDDLE_PACK.riddles).toHaveLength(60);
    for (const band of ['little', 'kid', 'grown'] as const) {
      expect(RIDDLE_PACK.riddles.filter((r) => r.band === band).length, band).toBeGreaterThanOrEqual(RIDDLES_PER_GAME * 2);
    }
    for (const r of RIDDLE_PACK.riddles) expect(r.answer, r.id).toBe(r.answer.toLowerCase());
  });
});

describe('simon says pack', () => {
  it('parses, holds 80 commands, and every band can fill a round, calm-only too', () => {
    expect(simonPackSchema.safeParse(simonJson).success).toBe(true);
    expect(SIMON_PACK.commands).toHaveLength(80);
    for (const band of ['little', 'kid', 'grown'] as const) {
      expect(eligible(band, false).length, band).toBeGreaterThanOrEqual(COMMANDS_PER_ROUND * 2);
      expect(eligible(band, true).length, band).toBeGreaterThanOrEqual(COMMANDS_PER_ROUND);
    }
  });

  it('every move is safe indoors and no command already says "Simon says"', () => {
    for (const c of SIMON_PACK.commands) {
      expect(c.text, c.text).not.toMatch(/(run|running|race|climb|climbing|jump (off|from)|chase|throw)/i);
      expect(c.text, c.text).not.toMatch(/simon/i);
      expect(c.text, c.text).toMatch(/^[A-Z].*!$/);
    }
  });
});
