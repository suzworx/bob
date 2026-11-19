import { randomUUID } from 'node:crypto';
import { createServer,type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { addAccount,asDb,closeTestDb,createTestDb,withAdminAuth,type TestDb,type TestAccount } from './support/test-db.ts';
import { createPushRouter } from '../src/notifications/push-http.ts';
import { listPushDevices } from '../src/notifications/push-store.ts';
import { webErrorHandler } from '../src/platform/http/errors.ts';
let pg: TestDb; let server: Server; let base: string; let owner: TestAccount; let other: TestAccount;
beforeAll(async () => {
 pg=await createTestDb(); owner=await addAccount(pg); other=await addAccount(pg);
 const app=express(); app.use(express.json());
 app.use((req,_res,next) => {
   const account=req.get('authorization') === 'owner' ? owner : req.get('authorization') === 'other' ? other : null;
   if (account) req.account={ ...account,exp:2_000_000_000 };
   next();
 });
 app.use('/api',createPushRouter({ getDb:async () => asDb(pg),topics:() => ['xyz.heybob.ios'] }));
 app.use(webErrorHandler); server=createServer(app);
 await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeTestDb(pg); });
async function post(account: string,body: unknown): Promise<Response> {
 return fetch(`${base}/api/push/devices`,{ method:'POST',headers:{ authorization:account,'content-type':'application/json' },body:JSON.stringify(body) });
}
it('registers through active authentication, validates topic and refuses forged owner fields',async () => {
 const input={ installation_id:randomUUID(),token:'12'.repeat(32),environment:'sandbox',topic:'xyz.heybob.ios',app_version:'1' };
 expect((await post('',input)).status).toBe(401);
 expect((await post('owner',{ ...input,user_id:other.userId })).status).toBe(400);
 expect((await post('owner',{ ...input,topic:'foreign.app' })).status).toBe(400);
 expect((await post('owner',{ ...input,token:'not-a-token' })).status).toBe(400);
 expect(await (await post('owner',input)).json()).toEqual({ registered:true,delivery_available:false });
 expect(await listPushDevices(asDb(pg),owner.userId)).toHaveLength(1);
 const url=`${base}/api/push/devices/${input.installation_id}`;
 expect((await fetch(url,{ method:'DELETE',headers:{ authorization:'other' } })).status).toBe(204);
 expect(await listPushDevices(asDb(pg),owner.userId)).toHaveLength(1);
 expect((await fetch(url,{ method:'DELETE',headers:{ authorization:'owner' } })).status).toBe(204);
 expect(await listPushDevices(asDb(pg),owner.userId)).toEqual([]);
});
it('denies a revoked session before token registration',async () => {
 await withAdminAuth(pg,(admin) => admin.endSession(other.sessionId));
 expect((await post('other',{ installation_id:randomUUID(),token:'34'.repeat(32),environment:'sandbox',topic:'xyz.heybob.ios',app_version:'1' })).status).toBe(401);
});
