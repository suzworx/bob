import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { asDb,closeTestDb,createTestDb,type TestDb } from './support/test-db.ts';
import { enqueueOutbox,claimOutboxBatch } from '../src/platform/outbox/store.ts';
import { createOutboxWorker } from '../src/platform/outbox/worker.ts';
import { OutboxDeferredError } from '../src/platform/outbox/deferred.ts';
let pg: TestDb;
beforeAll(async () => { pg=await createTestDb(); });
afterAll(async () => { await closeTestDb(pg); });
it('delays a quiet-hours notification without consuming attempts or acknowledging it',async () => {
 const db=asDb(pg);
 await enqueueOutbox(db,[{ eventType:'push.notification',resourceType:'notification',resourceId:randomUUID(),effectKey:randomUUID(),payload:{} }]);
 const now=Date.now()+60_000;
 const worker=createOutboxWorker({ db,owner:'push-test',now:() => now,maxAttempts:1,
 handlers:{ 'push.notification':async () => { throw new OutboxDeferredError(3_600_000); } } });
 await worker.tick();
 expect(await claimOutboxBatch(db,{ owner:'other',limit:10,leaseMs:30_000,now:now+3_599_999 })).toEqual([]);
 const due=await claimOutboxBatch(db,{ owner:'other',limit:10,leaseMs:30_000,now:now+3_600_001 });
 expect(due).toHaveLength(1);
 expect(due[0]?.attempts).toBe(0);
 await worker.stop();
});
