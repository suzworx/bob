// appendNote (the AI note tool) and the revision history (#129): the newest
// revision is marked AI assisted and credited to the requesting user, and a
// human save between the tool's read and its write is never overwritten.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVoiceTools } from '@bob/ai';
import { type VoiceOutput } from '@bob/ai/testing';
import { bindVoiceTools } from '../../src/voice/voice-tools.ts';
import type { Db } from '../../src/platform/db/db.ts';
import { createNote, getNote, listRevisions, updateNote } from '../../src/notes/store.ts';
import { addMember, createSpace } from '../../src/spaces/store.ts';
import { addAccount, asDb, closeTestDb, createTestDb, type TestAccount, type TestDb } from '../support/test-db.ts';

let pg: TestDb;
let db: Db;
let me: TestAccount;
let human: TestAccount;
let spaceId: string;

beforeAll(async () => {
  pg = await createTestDb();
  db = asDb(pg);
  me = await addAccount(pg);
  human = await addAccount(pg);
  spaceId = (await createSpace(db, me.userId, { kind: 'group', name: 'Family' })).id;
  await addMember(db, me.userId, spaceId, human.userId, 'member');
});

afterAll(async () => {
  await closeTestDb(pg).catch(() => undefined);
});

/**
 * A Db whose transactions from the second on first run the next queued human
 * save. appendNote reads the note in its first transaction and writes in the
 * next, so each save lands exactly between a read and a write.
 */
function racing(real: Db, saves: Array<() => Promise<unknown>>): Db {
  let calls = 0;
  return {
    query: <T>(sql: string, params?: unknown[]): Promise<T[]> => real.query<T>(sql, params),
    tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      calls += 1;
      const save = calls >= 2 ? saves.shift() : undefined;
      if (save !== undefined) await save();
      return real.tx(fn);
    },
  };
}

async function appendNote(on: Db, note: string, text: string): Promise<VoiceOutput> {
  const tools = createVoiceTools(bindVoiceTools(on, me.userId, { spaceId, timeZone: 'UTC' }));
  return (await tools.append_note!.execute!({ note, text } as never, {
    toolCallId: 't', messages: [], context: {},
  })) as VoiceOutput;
}

/** The human edits the note at its current revision, as the notes panel would. */
function humanSave(noteId: string, body: string): () => Promise<unknown> {
  return async (): Promise<unknown> => {
    const current = await getNote(db, human.userId, noteId);
    return updateNote(db, human.userId, noteId, { revision: current.revision, body });
  };
}

describe('appendNote revisions', () => {
  it('the newest revision is AI assisted and credited to the requesting user', async () => {
    const note = await createNote(db, human.userId, spaceId, { title: 'Chores', body: 'bins' });
    const out = await appendNote(db, 'Chores', 'laundry');
    expect(out.ok).toBe(true);

    const [newest, first] = await listRevisions(db, me.userId, note.id);
    expect(newest).toMatchObject({ revision: 2, body: 'bins\nlaundry', aiAssisted: true, editorUserId: me.userId });
    expect(first).toMatchObject({ revision: 1, aiAssisted: false, editorUserId: human.userId });
  });

  it('a human save between the read and the write survives: the AI text is appended to it', async () => {
    const note = await createNote(db, human.userId, spaceId, { title: 'Packing', body: 'socks' });
    const saves = [humanSave(note.id, 'socks\ncharger')];
    const out = await appendNote(racing(db, saves), 'Packing', 'passport');
    expect(saves).toHaveLength(0);
    expect(out.ok).toBe(true);

    expect((await getNote(db, me.userId, note.id)).body).toBe('socks\ncharger\npassport');
    const [newest, humanRev] = await listRevisions(db, me.userId, note.id);
    expect(newest).toMatchObject({ revision: 3, body: 'socks\ncharger\npassport', aiAssisted: true, editorUserId: me.userId });
    expect(humanRev).toMatchObject({ revision: 2, body: 'socks\ncharger', aiAssisted: false, editorUserId: human.userId });
  });

  it('a human saving again during the retry: the tool fails honestly and the human text is unchanged', async () => {
    const note = await createNote(db, human.userId, spaceId, { title: 'Menu', body: 'dal' });
    const saves = [humanSave(note.id, 'dal\nrice'), humanSave(note.id, 'dal\nrice\nroti')];
    const out = await appendNote(racing(db, saves), 'Menu', 'curd');
    expect(saves).toHaveLength(0);
    expect(out).toEqual({ ok: false, reason: 'that note is being edited right now, try again in a moment' });

    const stored = await getNote(db, me.userId, note.id);
    expect(stored).toMatchObject({ body: 'dal\nrice\nroti', revision: 3, aiAssisted: false });
    const [newest] = await listRevisions(db, me.userId, note.id);
    expect(newest).toMatchObject({ revision: 3, aiAssisted: false, editorUserId: human.userId });
  });
});
