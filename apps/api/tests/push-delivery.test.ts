import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { addAccount,asDb,closeTestDb,createTestDb,withAdminAuth,type TestDb } from './support/test-db.ts';
import { registerPushDevice,listPushDevices } from '../src/notifications/push-store.ts';
import { createPushHandler } from '../src/notifications/push-delivery.ts';
import { createTimer,markTimerFired } from '../src/timers/store.ts';
import { claimOutboxBatch,type StoredOutboxRow } from '../src/platform/outbox/store.ts';
import { createReminder,setRecipients } from '../src/reminders/store.ts';
import { addMember,createSpace } from '../src/spaces/store.ts';
import { createReminderFanout } from '../src/workflows/workflow-reminder-fire.ts';
import { upsertPreference } from '../src/notifications/store.ts';
import { OutboxDeferredError } from '../src/platform/outbox/deferred.ts';
let pg: TestDb;
beforeAll(async () => { pg=await createTestDb(); });
afterAll(async () => { await closeTestDb(pg); });
const signal=new AbortController().signal;
async function endpoint(userId: string,sessionId: string,local: string[]=[]): Promise<void> {
 await registerPushDevice(asDb(pg),userId,sessionId,{ installation_id:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),environment:'sandbox',topic:'xyz.heybob.ios',app_version:'1',local_timer_ids:local });
}
async function claim(kind: string): Promise<StoredOutboxRow[]> {
 return claimOutboxBatch(asDb(pg),{ owner:randomUUID(),limit:100,leaseMs:60_000,now:Date.now()+120_000,include:[kind] });
}
it('atomically enqueues a fired timer once, skips phones already scheduling it, dedupes replay, hides private labels',async () => {
 const owner=await addAccount(pg); const db=asDb(pg);
 const timer=await createTimer(db,owner.userId,{ durationMs:1000,label:'Private medication label',now:Date.now()-2000 });
 await endpoint(owner.userId,owner.sessionId,[timer.id]); await endpoint(owner.userId,owner.sessionId);
 await markTimerFired(db,owner.userId,timer.id); await markTimerFired(db,owner.userId,timer.id);
 const rows=(await claim('push.timer')).filter((r) => r.resourceId === timer.id);
 expect(rows).toHaveLength(1);
 const send=vi.fn(async () => 'sent' as const); const handler=createPushHandler({ db,send });
 const row=rows[0]; if (!row) throw new Error('missing timer outbox');
 await handler(row,signal); await handler(row,signal);
 expect(send).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(send.mock.calls)).not.toContain('Private medication');
});
it('invalid APNs endpoints are deleted and signed-out sessions cannot receive later sends',async () => {
 const owner=await addAccount(pg); const db=asDb(pg); await endpoint(owner.userId,owner.sessionId);
 const timer=await createTimer(db,owner.userId,{ durationMs:1000,now:Date.now()-2000 });
 await markTimerFired(db,owner.userId,timer.id);
 const row=(await claim('push.timer')).find((r) => r.resourceId === timer.id); if (!row) throw new Error('missing');
 const send=vi.fn(async () => 'invalid' as const);
 await createPushHandler({ db,send })(row,signal);
 expect(await listPushDevices(db,owner.userId)).toEqual([]);
 await endpoint(owner.userId,owner.sessionId);
 await withAdminAuth(pg,(admin) => admin.endSession(owner.sessionId));
 await createPushHandler({ db,send })(row,signal);
 expect(send).toHaveBeenCalledTimes(1);
});
it('a reminder pushes only to its chosen recipient and honors quiet hours before sending',async () => {
 const db=asDb(pg); const owner=await addAccount(pg); const chosen=await addAccount(pg); const other=await addAccount(pg);
 const space=await createSpace(db,owner.userId,{ kind:'group',name:'Push test' });
 await addMember(db,owner.userId,space.id,chosen.userId,'member'); await addMember(db,owner.userId,space.id,other.userId,'member');
 await endpoint(owner.userId,owner.sessionId); await endpoint(chosen.userId,chosen.sessionId); await endpoint(other.userId,other.sessionId);
 const at=Date.now()-1000;
 const reminder=await createReminder(db,owner.userId,space.id,{ title:'Private reminder',due:{ kind:'instant',at,zone:'UTC' } });
 await setRecipients(db,owner.userId,reminder.id,[chosen.userId]);
 await createReminderFanout({ db,now:() => at+1000,announce:() => undefined }).tick();
 const rows=await claim('push.notification');
 const row=rows.find((r) => r.payload.recipient_user_id === chosen.userId); if (!row) throw new Error('missing');
 const send=vi.fn(async () => 'sent' as const);
 await upsertPreference(db,chosen.userId,{ type:'reminder',quietHoursStart:'00:00:00',quietHoursEnd:'23:59:59',quietZone:'UTC' });
 const handler=createPushHandler({ db,send,now:() => new Date(at).setUTCHours(12,0,0,0) });
 await expect(handler(row,signal)).rejects.toBeInstanceOf(OutboxDeferredError);
 expect(send).not.toHaveBeenCalled();
 await upsertPreference(db,chosen.userId,{ type:'reminder',quietHoursStart:null,quietHoursEnd:null,quietZone:null });
 await createPushHandler({ db,send })(row,signal);
 expect(send).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(send.mock.calls)).not.toContain('Private reminder');
});
