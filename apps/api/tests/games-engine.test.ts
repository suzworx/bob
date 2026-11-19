/**
 * Games engine core (epic #460, unit G1): the shared output schemas match
 * tool-contracts.md section 1 byte for byte, the seeded rng makes a game
 * replayable, wordFilter passes the S2 adversarial table and kidSafeText
 * rejects each S8 class. Everything here is pure; no store, no model.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bandForAge, playerAgeSchema, gameErrSchema, gameOkSchema, gameViewSchema, type GameDefinition, type GameView, type StartOptions, mulberry32, rngAt, type Rng, wordFilter, type KidSafeReason } from '@bob/ai/testing';
import { kidSafeText } from '@bob/ai';

// Line endings are normalised: a Windows checkout may turn the doc's LF into CRLF.
const read = (rel: string | URL): string => readFileSync(typeof rel === 'string' ? new URL(rel, import.meta.url) : rel, 'utf8').replace(/\r\n/gu, '\n');
/** Absolute file URL of a file inside the @bob/ai package (source-text checks read apps/ai files). */
const aiFile = (rel: string): URL => new URL(rel, pathToFileURL(createRequire(import.meta.url).resolve('@bob/ai')));
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  return text.slice(start, text.indexOf('\n', end));
};

describe('shared output schemas (tool-contracts.md section 1)', () => {
  it('engine.ts declares them byte for byte as the contract does', () => {
    const doc = between(read('../../../docs/games/tool-contracts.md'), 'const gameViewSchema', "'stale','store_down']) }).strict();");
    const src = between(read(aiFile('./games/engine.ts')), 'export const gameViewSchema', "'stale','store_down']) }).strict();");
    expect(doc.length).toBeGreaterThan(500);
    expect(src.replace(/^export /gmu, '')).toBe(doc);
  });

  it("bandForAge follows catalog.md's band table; 3 is little and ages outside 3-99 are refused", () => {
    const rows = [...read('../../../docs/games/catalog.md').matchAll(/^\| [^|]+ \| (\d+)(?:-(\d+)|\+) \| `(\w+)` \|$/gmu)];
    expect(rows.map((row) => row[3])).toEqual(['little', 'kid', 'grown']);
    for (const [, from, to, band] of rows) {
      for (let age = Number(from); age <= Number(to ?? 99); age++) expect(bandForAge(age), `age ${age}`).toBe(band);
    }
    expect(bandForAge(3)).toBe('little');
    for (const age of [3, 6, 99]) expect(playerAgeSchema.safeParse(age).success).toBe(true);
    for (const age of [2, 100, 6.5, -1]) expect(playerAgeSchema.safeParse(age).success).toBe(false);
  });

  const view = (status: GameView['status']): GameView => ({
    game: 'animal_riddles', title: 'Animal Riddles', status, line1: 'I have a long trunk...', line2: 'Who am I?',
    icon: 'elephant', turn: 'Maya', scores: [{ name: 'Maya', points: 2 }, { name: 'Leo', points: 1 }],
    progress: { n: 3, of: 10 }, hints: { used: 1, of: 2 },
  });

  it.each(['intro', 'prompt', 'feedback', 'between', 'ended', 'paused'] as const)('accepts a %s view inside an ok result', (status) => {
    const ok = { ok: true, say: 'Here is your riddle.', speak_verbatim: true, expect_reply: true, host_notes: 'wait for their guess', view: view(status) };
    expect(gameOkSchema.parse(ok)).toEqual(ok);
  });

  it('accepts a minimal view and every error reason', () => {
    expect(gameViewSchema.safeParse({ game: 'simon_says', title: 'Simon Says', status: 'intro', line1: 'Get ready!', scores: [] }).success).toBe(true);
    for (const reason of gameErrSchema.shape.reason.options) {
      expect(gameErrSchema.safeParse({ ok: false, say: 'Sorry!', reason }).success).toBe(true);
    }
  });

  it('rejects extra keys at every strict level', () => {
    expect(gameViewSchema.safeParse({ ...view('prompt'), colour: 'red' }).success).toBe(false);
    expect(gameOkSchema.safeParse({ ok: true, say: 'x', speak_verbatim: false, expect_reply: false, view: view('prompt'), extra: 1 }).success).toBe(false);
    expect(gameErrSchema.safeParse({ ok: false, say: 'x', reason: 'stale', detail: 'row 7' }).success).toBe(false);
  });

  it('rejects over-long lines, unknown enums and too many scores', () => {
    expect(gameViewSchema.safeParse({ ...view('prompt'), line1: 'x'.repeat(41) }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), line2: 'x'.repeat(41) }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), title: 'x'.repeat(21) }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), turn: 'x'.repeat(21) }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), status: 'playing' }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), icon: 'skull' }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), scores: Array(7).fill({ name: 'A', points: 0 }) }).success).toBe(false);
    expect(gameViewSchema.safeParse({ ...view('prompt'), progress: { n: 1.5, of: 10 } }).success).toBe(false);
    const base = { ok: true, speak_verbatim: false, expect_reply: false, view: view('prompt') };
    expect(gameOkSchema.safeParse({ ...base, say: 'x'.repeat(601) }).success).toBe(false);
    expect(gameOkSchema.safeParse({ ...base, say: 'x', host_notes: 'x'.repeat(301) }).success).toBe(false);
    expect(gameErrSchema.safeParse({ ok: false, say: 'x'.repeat(201), reason: 'stale' }).success).toBe(false);
    expect(gameErrSchema.safeParse({ ok: false, say: 'x', reason: 'oops' }).success).toBe(false);
  });
});

interface ToyState { deck: number[]; drawn: number[]; score: number }
type ToyAction = { kind: 'draw' } | { kind: 'guess'; value: number };
const toy: GameDefinition<ToyState> = {
  id: 'family_quiz', bands: ['kid', 'grown'], minPlayers: 1, maxPlayers: 6,
  init: (_opts: StartOptions, rng: Rng): ToyState => ({ deck: rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), drawn: [], score: 0 }),
  view: (s: ToyState): GameView => ({ game: 'family_quiz', title: 'Toy', status: 'prompt', line1: `Drawn ${s.drawn.length}`, scores: [] }),
  tools: () => ({}),
};
const toyStep = (s: ToyState, action: ToyAction, rng: Rng): ToyState => {
  if (action.kind === 'draw') return { ...s, deck: s.deck.slice(1), drawn: [...s.drawn, s.deck[0] ?? 0] };
  return { ...s, score: s.score + (action.value === s.drawn.at(-1) ? rng.int(1, 3) : 0) };
};
const replay = (seed: number, actions: readonly ToyAction[]): ToyState => {
  const opts: StartOptions = { players: [{ name: 'Maya', band: 'kid' }], teams: false, band: 'kid' };
  return actions.reduce((s, a, i) => toyStep(s, a, rngAt(seed, i + 1)), toy.init(opts, rngAt(seed, 0)));
};

describe('seeded rng and replay', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const actions: ToyAction[] = [{ kind: 'draw' }, { kind: 'guess', value: 4 }, { kind: 'draw' }, { kind: 'guess', value: 7 }, { kind: 'draw' }];

  it('the same seed plus the same actions gives the same state, and never calls Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    expect(replay(42, actions)).toEqual(replay(42, actions));
    expect(toy.view(replay(42, actions), [])).toEqual(toy.view(replay(42, actions), []));
    expect(replay(42, actions).deck).not.toEqual(replay(43, actions).deck);
  });

  it('mulberry32 is stable across runs and its helpers stay in range', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 50 }, () => a.next());
    expect(seqA).toEqual(Array.from({ length: 50 }, () => b.next()));
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    const r = mulberry32(123);
    const ints = Array.from({ length: 2000 }, () => r.int(-2, 3));
    expect(new Set(ints)).toEqual(new Set([-2, -1, 0, 1, 2, 3]));
    const list = ['a', 'b', 'c', 'd'] as const;
    expect(list).toContain(r.pick(list));
    expect([...r.shuffle(list)].sort()).toEqual([...list]);
    expect(() => r.int(3, 1)).toThrow(RangeError);
    expect(() => r.pick([])).toThrow(RangeError);
  });

  it('no games source touches Math.random', () => {
    for (const file of ['engine.ts', 'rng.ts', 'word-filter.ts', 'kid-safe.ts']) {
      expect(read(aiFile(`./games/${file}`))).not.toMatch(/Math\.random\s*\(/u);
    }
  });
});

// S2 adversarial table. Every BLOCKED entry must fail and every BENIGN entry must pass (0 false positives).
const BLOCKED: readonly string[] = [
  // spacing and separators
  'f u c k', 'f.u.c.k', 'f-u-c-k', 'f_u_c_k', 'f  u  c  k', 's h i t', 'b i t c h', 'a s s', 'c u n t', 'd i c k',
  'fu ck', 'sh it', 'p o r n', 's-e-x', 'w.h.o.r.e',
  // leetspeak
  'sh1t', '$hit', '5hit', 'b1tch', 'b!tch', 'a$$', '@ss', '4ss', 'd1ck', 'p0rn', 'c0ck', 'wh0re', 'p3nis', 't1ts',
  'p!ss', 'cr@p', 'h3ll', 'b00b', 'b00bs', 's3x', 's3xy', 'k1ll', 'd3ad', 'n1gg3r', 'f@g', 'b@st@rd', 'sl*t', 'fvck',
  '8itch', 'pu55y', 'k!ll', 'd.r.u.g.s', 'cun7', 'tw@t', 'pr1ck', 'b0llocks',
  // homoglyphs, width, accents and invisible characters
  'fuсk', 'ѕhit', 'аss', 'bіtch', 'ρorn', 'ｆｕｃｋ', '𝐟𝐮𝐜𝐤', 'fück', 'shït', 'àss', 'fu​ck', 'sh­it',
  'aß', 'сunt', 'dіck', 'ＳＨＩＴ', 'pοrn', 'sеx', 'ki‍ll', 'bооb',
  // plurals and verb forms
  'fucks', 'fucking', 'fucker', 'shits', 'shitty', 'bitches', 'asses', 'dicks', 'cocks', 'boobs', 'boobies',
  'titties', 'penises', 'rapes', 'raping', 'raped', 'killing', 'kills', 'murdered', 'pissing', 'bastards', 'sluts',
  'whores', 'cunts', 'drugs', 'murders', 'stabbing', 'bombs', 'farts', 'poops',
  // repeated letters
  'fuuuuck', 'shiiiit', 'asssss', 'biiitch', 'diiick', 'hellllll', 'buuuttt', 'poooop', 'fuuuuuckiiing', 'sexxxx',
  // case
  'FUCK', 'ShIt', 'BiTcH', 'Ass', 'HELL', 'KiLL',
  // compounds
  'motherfucker', 'bullshit', 'dumbass', 'jackass', 'asshole', 'shithead', 'fuckface', 'bitchy', 'dickhead',
  'cocksucker', 'blowjob', 'porno', 'pornography', 'whorehouse', 'smartass',
  // phrases, punctuation and masking
  'big fat ass', 'you idiot', 'kill him', 'a dead cat', 'shit!', '!!fuck!!', '"ass"', '(dick)', 'f*ck', 's**t',
  'b*tch', 'f#ck', 'a**', 'stupid head',
];
const BENIGN: readonly string[] = [
  'Scunthorpe', 'grass', 'assist', 'class', 'bass', 'pass', 'glass', 'brass', 'classic', 'passenger', 'assassin',
  'cocktail', 'cockatoo', 'peacock', 'Hitchcock', 'Dickens', 'shiitake', 'cumin', 'cucumber', 'document', 'scrap',
  'scrape', 'therapist', 'grape', 'drape', 'raccoon', 'cocoon', 'hello', 'shell', 'shellfish', 'butter', 'butterfly',
  'button', 'buttercup', 'titan', 'title', 'arsenal', 'sextant', 'Essex', 'Sussex', 'analog', 'canal', 'spice',
  'spices', 'skill', 'skilled', 'pea', 'peas', 'peel', 'peer', 'deadline', 'dice', 'mass', 'massive', 'molasses',
  'glasses', 'classes', 'bassoon', 'compass', 'hassle', 'cassette', 'assume', 'assembly', 'hitch', 'witch',
  'sniggering', 'Matsushita', 'Fukuoka', 'swanky', 'h3llo', 'c00l', 'cooool', 'sooo', 'hellooo', 'passss',
  'grasssss', 'yessss', '42', 'Maya', 'Leo', 'pink elephant', 'a b c', 'ice cream', 'spaghetti', 'raspberry',
];

describe('wordFilter (safety.md S2)', () => {
  it('the adversarial table has at least 200 cases', () => {
    expect(BLOCKED.length + BENIGN.length).toBeGreaterThanOrEqual(200);
  });

  it.each(BLOCKED)('blocks %j and never echoes it', (word) => {
    const verdict = wordFilter(word, 'kid');
    expect(verdict).toEqual({ ok: false, reason: 'blocked' });
    expect(wordFilter(word, 'little').ok).toBe(false);
  });

  it.each(BENIGN)('passes the benign %j (no false positive)', (word) => {
    expect(wordFilter(word, 'kid')).toEqual({ ok: true, word: word.normalize('NFKC') });
    expect(wordFilter(word, 'grown').ok).toBe(true);
  });

  it('for little, only allowlisted words pass, with plural and verb forms', () => {
    for (const w of ['dog', 'dogs', 'puppies', 'big red ball', 'seven', '7', 'jumping', 'giggled', 'Unicorn', 'pancakes', 'boing']) {
      expect(wordFilter(w, 'little')).toEqual({ ok: true, word: w });
    }
    for (const w of ['Scunthorpe', 'zeitgeist', 'h3llo', 'Matsushita']) {
      expect(wordFilter(w, 'little')).toEqual({ ok: false, reason: 'not_in_allowlist' });
    }
    expect(wordFilter('sh1t', 'little')).toEqual({ ok: false, reason: 'blocked' });
  });

  it('rejects empty input and cleans whitespace', () => {
    for (const w of ['', '   ', '!!!']) expect(wordFilter(w, 'kid')).toEqual({ ok: false, reason: 'empty' });
    expect(wordFilter('  pink   elephant ', 'kid')).toEqual({ ok: true, word: 'pink elephant' });
  });

  it('no allowlist word is blocked', () => {
    const allow = JSON.parse(read(aiFile('./games/content/wordlists/allowlist-little.json'))) as { words: string[] };
    expect(allow.words.filter((w) => !wordFilter(w, 'kid').ok)).toEqual([]);
  });
});

describe('kidSafeText (safety.md S8, S9)', () => {
  const cases: ReadonlyArray<readonly [KidSafeReason, readonly string[]]> = [
    ['url', ['Check out www.funzone.com!', 'Visit https://x.example now', 'Go to coolgames dot com', 'See games.io']],
    ['long_number', ['Call 555 123 4567', 'The code is 1234567', 'five five five one two three four']],
    ['personal_info', ["What's your name?", 'How old are you?', 'Where do you live?', 'What school do you go to?',
      "What's your phone number?", 'Tell me your password', 'What is your address?', 'When is your birthday?']],
    ['commerce', ['You should buy the premium pack!', 'Ask your mom to pay for more levels', 'A word from our sponsor']],
    ['other_apps', ['Play this on Roblox later', 'Download the app', 'Watch it on YouTube', 'Try another app']],
    ['secret_or_persona', ["Let's keep this a secret", "Don't tell your parents", "I'm a real person", "I'm your best friend"]],
    ['blocked_word', ['That was a sh1t guess', 'What the f u c k', 'You are stupid']],
  ];
  it.each(cases)('rejects the %s class with only the reason', (reason, texts) => {
    for (const text of texts) expect(kidSafeText(text)).toEqual({ ok: false, reason });
  });

  it('passes normal kid-friendly replies', () => {
    for (const text of [
      "Great guess, Maya! It's an elephant. Leo, your turn!", "Here's a clue: I have black and white stripes.",
      'Question 3 of 10. Which planet is red? A: Mars, B: Venus, C: Jupiter.', 'Simon says touch your nose!',
      "Ooh, let's pick a different one! How about a food?", 'The score is Maya 3, Leo 2. Ready for the next one?',
      'Once upon a time a silly pirate ate 12 pancakes on a rainbow.', 'Five more minutes of games today.',
      "What's your guess? Is it a lion or a tiger?", 'Well done, you got 7 out of 10!', 'Nice to meet you, Leo!',
    ]) expect(kidSafeText(text)).toEqual({ ok: true });
  });
});
