// A bare local server in system-test mode must boot and answer: an unknown
// device token gets pairing_required (never a 503), and /api/test-token issues
// a JWT the guarded routes accept. The database is the per-file real Postgres
// (createTestDb) shared with getDb(), as every server-booting test uses.
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, setSharedDb } from '../../src/platform/db/db.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { messageId, V2_VERSION } from '../../src/voice/protocol.ts';
import { SimDevice } from '../helpers/sim-device.ts';
import { asDb, closeTestDb, createTestDb, TEST_DATABASE_URL, type TestDb } from '../support/test-db.ts';

/** A well-shaped random device token (olxd_ + 43 base64url chars). */
function randomDeviceToken(): string {
  return `olxd_${randomBytes(32).toString('base64url')}`;
}

describe('system-test server boot', () => {
  let pg: TestDb;

  beforeAll(async () => {
    pg = await createTestDb();
    setSharedDb(Promise.resolve(asDb(pg)));
  });

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    await closeTestDb(pg).catch(() => undefined);
    delete process.env.BOB_SYSTEM_TEST;
    delete process.env.BOB_V2_HOST;
  });

  it('answers device and web routes', async () => {
    process.env.BOB_SYSTEM_TEST = '1';
    process.env.BOB_V2_HOST = '127.0.0.1';
    setJournalSink(null);
    // The dynamic import pulls in @bob/ai's config module, which loads the
    // root .env with dotenv and can set BOB_DATABASE_URL. System-test mode
    // refuses a hosted URL, so name the tests' loopback one after the import and
    // before the server resolves its auth.
    const { createV2Server } = await import('../../src/server.ts');
    const originalDatabaseUrl = process.env.BOB_DATABASE_URL;
    process.env.BOB_DATABASE_URL = TEST_DATABASE_URL;
    const server: Server = (await createV2Server()).server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/v2/cardputer`;
    try {
      // An unknown olxd_ token is unpaired with reason 'unknown' — never 503.
      const device = new SimDevice(wsUrl, { auth: randomDeviceToken() });
      expect((await device.open()).connected).toBe(true);
      device.sendControl({
        v: V2_VERSION,
        type: 'hello',
        id: messageId('hello'),
        payload: { format_id: 1 },
      });
      const required = await device.waitFor('pairing_required', 10000);
      expect(required.payload.reason).toBe('unknown');
      device.close();

      // test-token issues a real JWT; the guarded list answers 200 [].
      const issued = await fetch(`${baseUrl}/api/test-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: randomUUID() }),
      });
      expect(issued.status).toBe(200);
      const { token } = (await issued.json()) as { token: string };
      const list = await fetch(`${baseUrl}/api/conversations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ conversations: [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (originalDatabaseUrl !== undefined) process.env.BOB_DATABASE_URL = originalDatabaseUrl;
    }
  }, 30000);
});
