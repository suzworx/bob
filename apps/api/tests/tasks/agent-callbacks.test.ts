import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/platform/db/db.ts';
import type { StoredNote } from '../../src/notes/store.ts';

const mocks = vi.hoisted(() => ({
  createNote: vi.fn(),
  getSpace: vi.fn(),
  notifyBobMessage: vi.fn(),
}));

vi.mock('../../src/notes/store.ts', () => ({
  createNote: mocks.createNote,
}));

vi.mock('../../src/spaces/store.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  getSpace: mocks.getSpace,
}));

vi.mock('../../src/notifications/notify.ts', () => ({
  notifyBobMessage: mocks.notifyBobMessage,
}));

import { bindPrivateCallbacks } from '../../src/tasks/agent-callbacks.ts';

const db = {} as Db;
const userId = 'user_1';
const spaceId = 'space_private_1';
const input = { title: 'Bring the checklist', body: 'Share the updated checklist.' };

function makeNote(overrides: Partial<StoredNote> = {}): StoredNote {
  return {
    id: 'note_1',
    spaceId,
    title: input.title,
    body: input.body,
    pinned: false,
    revision: 1,
    createdBy: userId,
    updatedBy: userId,
    aiAssisted: true,
    trashedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function notifyEmail() {
  const callback = bindPrivateCallbacks(db, userId, spaceId, {
    timeZone: 'UTC',
    localTimeDues: false,
  }, { allowNotifyEmail: true }).notifyEmail;
  if (!callback) throw new Error('notifyEmail callback is not available');
  return callback(input);
}

describe('bindPrivateCallbacks notifyEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSpace.mockResolvedValue({ kind: 'private', ownerUserId: userId });
    mocks.createNote.mockResolvedValue(makeNote());
    mocks.notifyBobMessage.mockResolvedValue({ status: 'delivered', enqueued: 2, muted: 0 });
  });

  it('does not expose notifyEmail unless the caller verifies a private context', () => {
    const callbacks = bindPrivateCallbacks(db, userId, spaceId, {
      timeZone: 'UTC',
      localTimeDues: false,
    });

    expect(callbacks.notifyEmail).toBeUndefined();
  });

  it('creates an AI-assisted private note and reports queueing, not delivery', async () => {
    await expect(notifyEmail()).resolves.toEqual({ noteId: 'note_1', delivery: 'queued' });

    expect(mocks.createNote).toHaveBeenCalledWith(db, userId, spaceId, {
      title: input.title,
      body: input.body,
      aiAssisted: true,
    });
    expect(mocks.notifyBobMessage).toHaveBeenCalledWith(
      db,
      userId,
      'note_1',
      'bob_message:note:note_1',
    );
  });

  it('reports muted without claiming inbox or email delivery', async () => {
    mocks.notifyBobMessage.mockResolvedValue({ status: 'muted', enqueued: 0, muted: 1 });

    await expect(notifyEmail()).resolves.toEqual({ noteId: 'note_1', delivery: 'muted' });
  });

  it('refuses to create or notify a note outside a verified private space', async () => {
    mocks.getSpace.mockResolvedValue({ kind: 'group', ownerUserId: userId });

    await expect(notifyEmail()).rejects.toThrow('notification is only available in a personal space');

    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.notifyBobMessage).not.toHaveBeenCalled();
  });

  it('sends again when the same message is asked for twice', async () => {
    mocks.createNote
      .mockResolvedValueOnce(makeNote({ id: 'note_1' }))
      .mockResolvedValueOnce(makeNote({ id: 'note_2' }));

    await expect(notifyEmail()).resolves.toEqual({ noteId: 'note_1', delivery: 'queued' });
    await expect(notifyEmail()).resolves.toEqual({ noteId: 'note_2', delivery: 'queued' });

    expect(mocks.notifyBobMessage).toHaveBeenNthCalledWith(1, db, userId, 'note_1', 'bob_message:note:note_1');
    expect(mocks.notifyBobMessage).toHaveBeenNthCalledWith(2, db, userId, 'note_2', 'bob_message:note:note_2');
  });

  it.each([
    [{ status: 'failed', reason: 'enqueue_failed' }],
    [{ status: 'failed', reason: 'preferences_unreadable' }],
    [{ status: 'none' }],
  ])('throws a safe error when notification is not queued (%o)', async (outcome) => {
    mocks.notifyBobMessage.mockResolvedValue(outcome);

    await expect(notifyEmail()).rejects.toThrow('notification could not be queued');
  });

  it('does not expose raw enqueue errors', async () => {
    mocks.notifyBobMessage.mockRejectedValue(new Error('private note body'));

    await expect(notifyEmail()).rejects.toThrow('notification could not be queued');
  });

  it('does not enqueue or report success when note creation fails', async () => {
    mocks.createNote.mockRejectedValue(new Error('note store unavailable'));

    await expect(notifyEmail()).rejects.toThrow('note store unavailable');
    expect(mocks.notifyBobMessage).not.toHaveBeenCalled();
  });
});
