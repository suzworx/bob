import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #415: a pass-through spy, so a test can inspect the rows the bounded read returned.
vi.mock('../../src/conversations/store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/conversations/store.ts')>();
  return { ...actual, loadRecentHistory: vi.fn(actual.loadRecentHistory) };
});

import type { Db } from '../../src/platform/db/db.ts';
import {
  appendMessage,
  addReplyVersion,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  loadRecentHistory,
  selectVersion,
  type RecentMessage,
} from '../../src/conversations/store.ts';
import { getActive } from '../../src/conversations/active.ts';
import { MAX_HISTORY_MESSAGES, trimHistory } from '../../src/voice/turn-core.ts';
import { loadCardputerHistory, persistDeviceTurn, preparePrivateDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { newId } from '../../src/platform/ids.ts';
import { resolveDevAccount } from '../../src/account/dev-account.ts';
import type { ChatMessage } from '../../src/voice/protocol.ts';
import {
  asDb,
  addAccount,
  closeTestDb,
  createTestDb,
  withUserRaw,
  type TestDb,
} from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let userId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  userId = await resolveDevAccount(db);
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

describe('cardputer conversation', () => {
  it('prepares the first private user anchor once before generation and finalizes only its reply', async () => {
    const fresh = await addAccount(pg, {});
    const input = { pinnedRef: undefined, transcriptText: 'hello first turn', deviceId: null,
      userMessageId: newId('message'), replyMessageId: newId('message') };
    const prepared = await preparePrivateDeviceTurn(db, fresh.userId, input);
    expect(prepared?.scope.spaceKind).toBe('private');
    if (!prepared) throw new Error('missing prepared turn');
    expect(await preparePrivateDeviceTurn(db, fresh.userId, input)).toMatchObject({ userMessageId: input.userMessageId, conversationId: prepared.conversationId });
    expect(await listConversations(db, fresh.userId)).toHaveLength(1);
    expect(await loadCardputerHistory(db, fresh.userId, prepared.conversationId)).toEqual([{ role: 'user', content: input.transcriptText }]);
    expect(await loadCardputerHistory(db, fresh.userId, prepared.conversationId, input.userMessageId)).toEqual([]);
    const turn = { pinnedRef: prepared.conversationId, sessionId: 'session', turnRef: 'turn', transcriptText: input.transcriptText, replyText: 'hello', prepared };
    await persistDeviceTurn(db, fresh.userId, turn, { publish: () => undefined });
    await persistDeviceTurn(db, fresh.userId, turn, { publish: () => undefined });
    expect(await loadCardputerHistory(db, fresh.userId, prepared.conversationId)).toEqual([
      { role: 'user', content: input.transcriptText }, { role: 'assistant', content: 'hello' },
    ]);
  });
  it('prepares a pinned turn in two statements: the account setup and one prepare call', async () => {
    const fresh = await addAccount(pg, {});
    const conversation = await createConversation(db, fresh.userId, 'Pinned');
    const statements: string[] = [];
    const counted = (inner: Db): Db => ({
      query: (sql, params) => { statements.push(sql); return inner.query(sql, params); },
      tx: (fn) => inner.tx((tx) => fn(counted(tx))),
    });
    const prepared = await preparePrivateDeviceTurn(counted(db), fresh.userId, { pinnedRef: conversation.id,
      transcriptText: 'pinned turn', deviceId: null, userMessageId: newId('message'), replyMessageId: newId('message') });
    expect(prepared).toMatchObject({ conversationId: conversation.id, created: false, scope: { spaceKind: 'private', title: 'Pinned' } });
    expect(statements).toHaveLength(2);
    expect(await getActive(db, fresh.userId)).toMatchObject({ conversationId: conversation.id, surface: 'device' });
    expect(await loadCardputerHistory(db, fresh.userId, conversation.id)).toEqual([{ role: 'user', content: 'pinned turn' }]);
  });
  it('refuses unknown and another owner scope before preparing any private anchor', async () => {
    const fresh = await addAccount(pg, {});
    const foreign = await createConversation(db, userId, 'foreign');
    for (const pinnedRef of [foreign.id, 'thr_missing', 'conv_missing']) {
      const result = await preparePrivateDeviceTurn(db, fresh.userId, { pinnedRef, transcriptText: 'private', deviceId: null,
        userMessageId: newId('message'), replyMessageId: newId('message') });
      expect(result).toBeNull();
    }
    expect(await listConversations(db, fresh.userId)).toEqual([]);
  });
  it('cannot finalize a prepared anchor under another owner', async () => {
    const fresh = await addAccount(pg, {});
    const prepared = await preparePrivateDeviceTurn(db, userId, { pinnedRef: undefined, transcriptText: 'private', deviceId: null,
      userMessageId: newId('message'), replyMessageId: newId('message') });
    if (!prepared) throw new Error('missing prepared');
    await expect(persistDeviceTurn(db, fresh.userId, { prepared, pinnedRef: prepared.conversationId,
      sessionId: 'session', turnRef: 'turn', transcriptText: 'private', replyText: 'reply' }, { publish: () => undefined }))
      .rejects.toThrow('device_turn_anchor_invalid');
  });
  it('replays prepared tools before final reply text and excludes only the current user anchor', async () => {
    const fresh = await addAccount(pg, {});
    const conversation = await createConversation(db, fresh.userId, 'History');
    await persistDeviceTurn(db, fresh.userId, conversation.id, 'prior user', 'prior reply');
    const prepared = await preparePrivateDeviceTurn(db, fresh.userId, { pinnedRef: conversation.id, transcriptText: 'current user', deviceId: null,
      userMessageId: newId('message'), replyMessageId: newId('message') });
    if (!prepared) throw new Error('missing prepared');
    expect(await loadCardputerHistory(db, fresh.userId, conversation.id, prepared.userMessageId)).toEqual([
      { role: 'user', content: 'prior user' }, { role: 'assistant', content: 'prior reply' },
    ]);
    await persistDeviceTurn(db, fresh.userId, { prepared, pinnedRef: conversation.id, sessionId: 's', turnRef: 't',
      transcriptText: 'current user', replyText: 'Done.', toolParts: [{ type: 'step-start' }, {
        type: 'tool-set_timer', toolCallId: 'call1', state: 'output-available', input: { seconds: 10 }, output: { id: 'timer1' },
      }] }, { publish: () => undefined });
    expect((await loadCardputerHistory(db, fresh.userId, conversation.id)).map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  });
  it('returns an empty history for an unknown conversation id', async () => {
    expect(await loadCardputerHistory(db, userId, 'cnv_does_not_exist')).toEqual([]);
  });

  it('persists a completed turn and sets the pointer with surface device', async () => {
    const conversation = await createConversation(db, userId, 'seeded');

    const result = await persistDeviceTurn(db, userId, conversation.id, 'what time is it', 'it is noon');

    expect(result.conversationId).toBe(conversation.id);
    expect(result.created).toBe(false);
    expect(result.title).toBe('seeded');
    expect(await loadCardputerHistory(db, userId, conversation.id)).toEqual([
      { role: 'user', content: 'what time is it' },
      { role: 'assistant', content: 'it is noon' },
    ]);
    const active = await getActive(db, userId);
    expect(active?.conversationId).toBe(conversation.id);
    expect(active?.surface).toBe('device');
  });

  it('creates a conversation titled deriveTitle(transcript) when the pointer is absent', async () => {
    const fresh = await addAccount(pg, {});
    const result = await persistDeviceTurn(db, fresh.userId, undefined, 'hello cardputer', 'hello back');

    expect(result.created).toBe(true);
    expect(result.title).toBe('hello cardputer');
    expect(await loadCardputerHistory(db, fresh.userId, result.conversationId)).toEqual([
      { role: 'user', content: 'hello cardputer' },
      { role: 'assistant', content: 'hello back' },
    ]);
    const active = await getActive(db, fresh.userId);
    expect(active?.conversationId).toBe(result.conversationId);
    expect(active?.surface).toBe('device');
    // Exactly one conversation was created: the pointer names the new one.
    expect(await listConversations(db, fresh.userId)).toHaveLength(1);
  });

  it('creates a fresh conversation when the pinned conversation was deleted', async () => {
    const doomed = await createConversation(db, userId, 'doomed');
    await deleteConversation(db, userId, doomed.id);

    const result = await persistDeviceTurn(db, userId, doomed.id, 'still talking', 'still here');

    expect(result.created).toBe(true);
    expect(result.conversationId).not.toBe(doomed.id);
    expect((await getActive(db, userId))?.conversationId).toBe(result.conversationId);
  });

  it('reuses the pinned conversation even when the pointer has moved (FR-025 shape)', async () => {
    const pinned = await createConversation(db, userId, 'pinned');
    const other = await createConversation(db, userId, 'other');
    await persistDeviceTurn(db, userId, other.id, 'move', 'moved');

    const result = await persistDeviceTurn(db, userId, pinned.id, 'stay', 'stayed');

    expect(result.conversationId).toBe(pinned.id);
    expect(await loadCardputerHistory(db, userId, pinned.id)).toEqual([
      { role: 'user', content: 'stay' },
      { role: 'assistant', content: 'stayed' },
    ]);
  });

  it('flattens text parts into ChatMessage in position order', async () => {
    const conversation = await createConversation(db, userId, 'ordered');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'world' }] });

    expect(await loadCardputerHistory(db, userId, conversation.id)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
  });

  it('prefers the selected version over an unselected one', async () => {
    const conversation = await createConversation(db, userId, 'versions');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a3' }]);

    // Newest version (a3) is selected by default.
    expect(await loadCardputerHistory(db, userId, conversation.id)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a3' },
    ]);
  });

  it('renders a file part as a short placeholder and never inlines its payload', async () => {
    const conversation = await createConversation(db, userId, 'files');
    const sentinel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await appendMessage(db, userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'file', mediaType: 'image/png', url: sentinel, filename: 'pixel.png' }],
    });

    const history = await loadCardputerHistory(db, userId, conversation.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ role: 'user', content: '[file: image/png]' });
    expect(JSON.stringify(history)).not.toContain('base64');
    expect(JSON.stringify(history)).not.toContain('iVBORw0KGgo');
  });

  it('skips a message that flattens to empty content', async () => {
    const conversation = await createConversation(db, userId, 'empties');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'real' }] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [] });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'reasoning', text: 'ignored' }] });

    expect(await loadCardputerHistory(db, userId, conversation.id)).toEqual([{ role: 'user', content: 'real' }]);
  });

  it('applies the shared chunked trim: starts on a 20-message boundary, newest last', async () => {
    const conversation = await createConversation(db, userId, 'long');
    const total = MAX_HISTORY_MESSAGES + 5;
    for (let index = 0; index < total; index += 1) {
      await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: `m${index}` }] });
    }

    const history = await loadCardputerHistory(db, userId, conversation.id);
    expect(history).toHaveLength(total - 20);
    expect(history[0]!.content).toBe('m20');
    expect(history.at(-1)!.content).toBe(`m${total - 1}`);
  });
});

/** The parity oracle: the full read, selected-else-first, flatten, the shared
 *  chunked trim over the stored positions, then the empty-skip. */
async function fullReadHistory(conversationId: string): Promise<ChatMessage[]> {
  const detail = await getConversation(db, userId, conversationId);
  if (detail === null) return [];
  const messages: ChatMessage[] = [];
  for (const message of detail.messages) {
    const version = message.versions.find((candidate) => candidate.selected) ?? message.versions[0];
    if (!version) continue;
    const pieces: string[] = [];
    for (const part of version.parts as Array<{ type?: unknown; text?: unknown; mediaType?: unknown }>) {
      if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text);
      else if (part.type === 'file') {
        pieces.push(typeof part.mediaType === 'string' && part.mediaType.length > 0 ? `[file: ${part.mediaType}]` : '[file]');
      }
    }
    messages.push({ role: message.role, content: pieces.join(' ').trim() });
  }
  return trimHistory(messages, MAX_HISTORY_MESSAGES, 0).filter((message) => message.content.length > 0);
}

/** Bulk-seeds `count` alternating messages; `empty(g)` marks ones whose only part is reasoning. */
async function seeded(count: number, empty: (g: number) => boolean = () => false): Promise<string> {
  const conversation = await createConversation(db, userId, `seeded ${count}`);
  const empties = Array.from({ length: count }, (_, g) => g).filter(empty);
  await withUserRaw(pg, userId, async (tx) => {
    await tx.query(
      `INSERT INTO bob.messages (id, conversation_id, user_id, role, position, origin, created_at)
       SELECT $1 || '_m' || g, $1, $2::uuid, CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END, g, 'device', now()
       FROM generate_series(0, $3::int - 1) AS g`,
      [conversation.id, userId, count],
    );
    await tx.query(
      `INSERT INTO bob.message_versions (id, message_id, user_id, parts, version_index, is_selected, created_at)
       SELECT $1 || '_v' || g, $1 || '_m' || g, $2::uuid,
              CASE WHEN g = ANY($4::int[]) THEN '[{"type":"reasoning","text":"hidden"}]'::jsonb
                   ELSE jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'm' || g)) END,
              0, true, now()
       FROM generate_series(0, $3::int - 1) AS g`,
      [conversation.id, userId, count, empties],
    );
  });
  return conversation.id;
}

describe('bounded history read (#415)', () => {
  beforeEach(() => {
    vi.mocked(loadRecentHistory).mockClear();
  });

  for (const count of [0, 1, 40, 41, 200]) {
    it(`equals the full-read loader for M = ${count}`, async () => {
      const id = await seeded(count);
      const history = await loadCardputerHistory(db, userId, id);
      expect(history).toEqual(await fullReadHistory(id));
      expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    });
  }

  it('equals the full-read loader for a regenerated message whose selected version is not the first', async () => {
    const conversation = await createConversation(db, userId, 'regenerated');
    await appendMessage(db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'q' }] });
    const answer = await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] });
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a2' }]);
    await addReplyVersion(db, userId, conversation.id, [{ type: 'text', text: 'a3' }]);
    await selectVersion(db, userId, answer!.id, 1);

    const history = await loadCardputerHistory(db, userId, conversation.id);
    expect(history).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a2' }]);
    expect(history).toEqual(await fullReadHistory(conversation.id));
  });

  it('reads image parts text-only: placeholders out, no data: URL in the rows read', async () => {
    const conversation = await createConversation(db, userId, 'images');
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await appendMessage(db, userId, conversation.id, {
      role: 'user',
      parts: [{ type: 'text', text: 'what is this' }, { type: 'file', mediaType: 'image/png', url, filename: 'a.png' }],
    });
    await appendMessage(db, userId, conversation.id, { role: 'assistant', parts: [{ type: 'text', text: 'a pixel' }] });

    const history = await loadCardputerHistory(db, userId, conversation.id);
    expect(history).toEqual([
      { role: 'user', content: 'what is this [file: image/png]' },
      { role: 'assistant', content: 'a pixel' },
    ]);
    expect(history).toEqual(await fullReadHistory(conversation.id));

    const calls = vi.mocked(loadRecentHistory).mock;
    expect(calls.calls.every((args) => args[4]?.textOnly === true)).toBe(true);
    const rows: RecentMessage[][] = await Promise.all(calls.results.map((result) => result.value as Promise<RecentMessage[]>));
    expect(rows.flat()).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('data:');
  });
});

describe('chunked history window (#413)', () => {
  for (const [count, first, kept] of [[0, -1, 0], [40, 0, 40], [41, 20, 21], [60, 20, 40], [61, 40, 21], [100, 60, 40]] as const) {
    it(`M = ${count} stored: starts at m${first}, keeps ${kept}`, async () => {
      const id = await seeded(count);
      const history = await loadCardputerHistory(db, userId, id);
      expect(history).toHaveLength(kept);
      if (kept > 0) {
        expect(history[0]!.content).toBe(`m${first}`);
        expect(history.at(-1)!.content).toBe(`m${count - 1}`);
      }
    });
  }

  it('keeps the same first message while 20 more are appended past the cap', async () => {
    const id = await seeded(41);
    const firsts = new Set<string>();
    for (let index = 41; index <= 60; index += 1) {
      const history = await loadCardputerHistory(db, userId, id);
      expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
      firsts.add(String(history[0]?.content));
      await appendMessage(db, userId, id, { role: index % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: `m${index}` }] });
    }
    expect([...firsts]).toEqual(['m20']);
  });

  it('takes the window by position before skipping empties, in one bounded read', async () => {
    // 61 stored, position 45 empty: the window is m40..m60 minus m45.
    const id = await seeded(61, (g) => g === 45);
    vi.mocked(loadRecentHistory).mockClear();
    const history = await loadCardputerHistory(db, userId, id);
    expect(history[0]!.content).toBe('m40');
    expect(history).toHaveLength(20);
    expect(history.map((message) => message.content)).not.toContain('m45');
    expect(vi.mocked(loadRecentHistory)).toHaveBeenCalledTimes(1);
  });
});
