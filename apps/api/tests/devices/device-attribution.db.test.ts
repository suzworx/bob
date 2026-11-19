// test:db suite for #668 "Recent", against the local Supabase stack as
// bob_server under real RLS and grants. A Cardputer turn in General and in a
// space thread stores the speaking device's id on both saved messages (the
// column grant on bob.messages lets the stamp through); a web turn stores
// none. Skips cleanly when Docker is not available.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../../src/platform/db/db.ts';
import * as pairing from '../../src/devices/pairing-service.ts';
import { AccountEvents } from '../../src/account/events-bus.ts';
import { appendMessage, createConversation } from '../../src/conversations/store.ts';
import { createThread, postMessage } from '../../src/conversations/thread-store.ts';
import { persistDeviceTurn } from '../../src/voice/cardputer-conversation.ts';
import { threadRef } from '../../src/devices/conversation-ref.ts';
import { setupMemoryTestDb, type MemoryTestDb } from '../db-harness.ts';

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

describe.skipIf(!dockerUp)('device attribution on saved turns (#668, test:db)', () => {
  let env: MemoryTestDb;
  let userId: string;
  let deviceId: string;

  beforeAll(async () => {
    env = await setupMemoryTestDb();
    userId = env.a.userId;
    const issued = await pairing.issueCode(env.db, {
      model: 'M5Stack Cardputer', fwVersion: '0.9.0', claim: `claim-${randomUUID()}`, ip: '203.0.113.68',
    });
    deviceId = await pairing.approve(env.db, userId, issued.pairingId, 'Kitchen');
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  async function generalDevices(conversationId: string): Promise<Array<string | null>> {
    const rows = await withUser(env.db, userId, (tx) => tx.query<{ device_id: string | null }>(
      `SELECT device_id FROM bob.messages WHERE conversation_id = $1 ORDER BY position`, [conversationId],
    ));
    return rows.map((row) => row.device_id);
  }

  async function threadDevices(threadId: string): Promise<Array<string | null>> {
    const rows = await withUser(env.db, userId, (tx) => tx.query<{ device_id: string | null }>(
      `SELECT device_id FROM bob.messages WHERE conversation_id = $1 ORDER BY sequence`, [threadId],
    ));
    return rows.map((row) => row.device_id);
  }

  it('a General device turn stamps the transcript and the reply with the device', async () => {
    const saved = await persistDeviceTurn(env.db, userId, undefined, 'what is for dinner', 'Pasta.', deviceId);
    expect(await generalDevices(saved.conversationId)).toEqual([deviceId, deviceId]);
  });

  it('a space-thread device turn stamps the message and the reply with the device', async () => {
    const thread = await createThread(env.db, userId, { spaceId: env.spaces.groupABC, title: 'Dinner' });
    const saved = await persistDeviceTurn(env.db, userId, {
      pinnedRef: threadRef(thread.id), sessionId: `sess_${randomUUID().slice(0, 8)}`, deviceId, turnRef: 'turn_a1b2c3d4',
      transcriptText: 'add basil', replyText: 'Added basil.',
    }, new AccountEvents());
    expect(saved?.outcome).toBe('completed');
    expect(await threadDevices(thread.id)).toEqual([deviceId, deviceId]);
  });

  it('a web turn leaves device_id null in General and in a thread', async () => {
    const conversation = await createConversation(env.db, userId, 'Web chat');
    await appendMessage(env.db, userId, conversation.id, { role: 'user', parts: [{ type: 'text', text: 'hi' }], origin: 'web_text' });
    expect(await generalDevices(conversation.id)).toEqual([null]);
    const thread = await createThread(env.db, userId, { spaceId: env.spaces.groupABC, title: 'Web thread' });
    await postMessage(env.db, userId, { threadId: thread.id, body: 'hello', clientMessageId: `web-${randomUUID()}` });
    expect(await threadDevices(thread.id)).toEqual([null]);
  });
});
