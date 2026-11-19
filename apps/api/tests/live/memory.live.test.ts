/**
 * Live memory lifecycle (#758): the real agent's remember/forget, the real
 * extraction worker and embedder, and the real database, through the web chat
 * route and the device turn. Each case runs x3 on a fresh account and asserts
 * on database state (current rows per fact) and journal events, never on the
 * reply. A failure prints the writer-path evidence: memory journal events and
 * current rows, ids/enums/counts only (support/memory-harness.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { liveRun } from './support/live-env.ts';
import {
  closeLiveStore, currentRows, deviceTurn, evidence, mentioning, newAccount, openLiveStore, retrievedIds, webTurn,
  type JournalEvent, type LiveStore,
} from './support/memory-harness.ts';

vi.mock('../../src/voice/audio/stt-tts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/voice/audio/stt-tts.ts')>()),
  isEmptyTurn: vi.fn(() => false),
  isTooShortTurn: vi.fn(() => false),
  transcribePcm: vi.fn(),
  synthesizeMp3: vi.fn(),
  synthesizePcm: vi.fn(),
}));

const REPEATS = [1, 2, 3];
let store: LiveStore;

/** Runs one case on a fresh account; on failure prints the case's writer-path evidence. */
async function runCase(name: string, repeat: number, body: (userId: string, since: () => JournalEvent[]) => Promise<void>): Promise<void> {
  const userId = await newAccount(store);
  const from = store.events.length;
  const since = (): JournalEvent[] => store.events.slice(from);
  try {
    await body(userId, since);
    console.log(`[live:memory] ${name} #${repeat}: PASS`);
  } catch (error) {
    console.log(`[live:memory] ${name} #${repeat}: FAIL\n${evidence(since(), await currentRows(store, userId))}`);
    throw error;
  }
}

const writes = (events: readonly JournalEvent[]): number => events.reduce((sum, e) =>
  sum + (e.event === 'v2.memory_remembered' && e.outcome !== 'noop' ? 1 : 0)
  + (e.event === 'v2.memory_extracted' ? Number(e.ops_add ?? 0) + Number(e.ops_update ?? 0) + Number(e.ops_supersede ?? 0) : 0), 0);

describe.skipIf(!liveRun)('live memory: one current copy of every fact, through the real writers', () => {
  beforeAll(async () => { store = await openLiveStore(); });
  afterAll(async () => { await closeLiveStore(store); });

  it.each(REPEATS)('prod replay: remember, remember, a superseding turn, remember: one current copy (#%i)', (repeat) => runCase('prod-replay', repeat, async (userId) => {
    const conversation = await webTurn(store, userId, "Remember that my wife's name is Maya.");
    await webTurn(store, userId, "Remember that my wife's name is Maia.", conversation);
    await webTurn(store, userId, "It's Maia, not Maya.", conversation);
    await webTurn(store, userId, "Remember that my wife's name is Maia.", conversation);
    const rows = mentioning(await currentRows(store, userId), 'wife');
    expect(rows, 'current rows about the wife').toHaveLength(1);
    expect(mentioning(rows, 'maia')).toHaveLength(1);
  }));

  it.each(REPEATS)('web plus device: the same fact said on both surfaces: one copy (#%i)', (repeat) => runCase('web+device', repeat, async (userId) => {
    await webTurn(store, userId, 'Remember that my favourite tea is masala chai.');
    await deviceTurn(store, userId, 'Remember that my favourite tea is masala chai.');
    expect(mentioning(await currentRows(store, userId), 'chai'), 'current rows about chai').toHaveLength(1);
  }));

  // The prod rows of 2026-10-02: "User has a wife named Maya." (typed) and
  // "My wife's name is Maya" (device) -- one fact, two wordings.
  it.each(REPEATS)('reworded on another surface: one fact, one row (#%i)', (repeat) => runCase('reworded', repeat, async (userId) => {
    await webTurn(store, userId, 'Remember that I have a wife named Maya.');
    await deviceTurn(store, userId, "Remember that my wife's name is Maya.");
    const rows = mentioning(await currentRows(store, userId), 'maya');
    expect(rows, 'current rows about Maya').toHaveLength(1);
  }));

  it.each(REPEATS)('paraphrase: the fact restated in other words: one copy (#%i)', (repeat) => runCase('paraphrase', repeat, async (userId) => {
    await webTurn(store, userId, "Remember that I'm allergic to peanuts.");
    await webTurn(store, userId, 'Just so you know, peanuts give me an allergic reaction.');
    expect(mentioning(await currentRows(store, userId), 'peanut'), 'current rows about peanuts').toHaveLength(1);
  }));

  it.each(REPEATS)('subsumption: the fuller fact replaces the shorter one (#%i)', (repeat) => runCase('subsumption', repeat, async (userId) => {
    await webTurn(store, userId, "Remember that I'm vegetarian.");
    await webTurn(store, userId, "Remember that I'm an Indian vegetarian.");
    const rows = mentioning(await currentRows(store, userId), 'vegetarian');
    expect(rows, 'current rows about being vegetarian').toHaveLength(1);
    expect(mentioning(rows, 'indian'), 'the current row carries the fuller fact').toHaveLength(1);
  }));

  it.each(REPEATS)('correction: a changed fact supersedes the old one (#%i)', (repeat) => runCase('correction', repeat, async (userId) => {
    await webTurn(store, userId, 'Remember that I live in Toronto.');
    const old = mentioning(await currentRows(store, userId), 'toronto').map((row) => row.id);
    expect(old.length, 'the first fact was stored').toBeGreaterThan(0);
    await webTurn(store, userId, 'I moved. I live in Vancouver now.');
    const rows = await currentRows(store, userId);
    expect(rows.filter((row) => old.includes(row.id)), 'the old fact is still current').toHaveLength(0);
    expect(mentioning(rows, 'vancouver'), 'current rows about Vancouver').toHaveLength(1);
  }));

  it.each(REPEATS)('control turns: thanks, ok and stop write nothing (#%i)', (repeat) => runCase('control', repeat, async (userId, since) => {
    const conversation = await webTurn(store, userId, 'thanks');
    await webTurn(store, userId, 'ok', conversation);
    await webTurn(store, userId, 'stop', conversation);
    expect(await currentRows(store, userId), 'rows written by control turns').toHaveLength(0);
    expect(writes(since()), 'write decisions in the journal').toBe(0);
  }));

  it.each(REPEATS)('retrieval: a new conversation recalls the stored fact (#%i)', (repeat) => runCase('retrieval', repeat, async (userId) => {
    await webTurn(store, userId, "Remember that my dog's name is Biscuit.");
    const stored = mentioning(await currentRows(store, userId), 'biscuit').map((row) => row.id);
    expect(stored.length, 'the fact was stored').toBeGreaterThan(0);
    const from = store.events.length;
    await webTurn(store, userId, "What's my dog's name?");
    const retrieved = store.events.slice(from).find((e) => e.event === 'v2.memory_retrieved');
    expect(Number(retrieved?.count ?? 0), 'v2.memory_retrieved count on the recall turn').toBeGreaterThan(0);
    expect(await retrievedIds(store, userId, "What's my dog's name?"), 'retrieved ids').toEqual(expect.arrayContaining([stored[0]]));
  }));

  it.each(REPEATS)('forget: forget by query removes the fact and a later turn does not recall it (#%i)', (repeat) => runCase('forget', repeat, async (userId, since) => {
    await webTurn(store, userId, 'Remember that my gym is on Elm Street.');
    const stored = mentioning(await currentRows(store, userId), 'elm').map((row) => row.id);
    expect(stored.length, 'the fact was stored').toBeGreaterThan(0);
    await webTurn(store, userId, 'Forget that my gym is on Elm Street.');
    expect(since().some((e) => e.event === 'v2.memory_forgotten'), 'v2.memory_forgotten').toBe(true);
    expect(mentioning(await currentRows(store, userId), 'elm'), 'rows about Elm Street after forget').toHaveLength(0);
    await webTurn(store, userId, 'Where is my gym?');
    expect(mentioning(await currentRows(store, userId), 'elm'), 'rows about Elm Street after a later turn').toHaveLength(0);
    const recalled = await retrievedIds(store, userId, 'Where is my gym?');
    expect(recalled.filter((id) => stored.includes(id)), 'forgotten ids retrieved').toHaveLength(0);
  }));
});
