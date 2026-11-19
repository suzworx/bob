import { asServer, withUser, type Db } from '../platform/db/db.ts';
import { PushRegistrationSchema, type PushRegistration } from './push-schemas.ts';

export interface PushDevice {
  id: string; userId: string; installationId: string; token: string;
  environment: 'sandbox' | 'production'; topic: string; appVersion: string;
  localTimerIds: string[]; generation: string;
}

export async function registerPushDevice(db: Db, userId: string, sessionId: string, input: PushRegistration): Promise<boolean> {
  const p = PushRegistrationSchema.parse(input);
  const rows = await asServer(db, (tx) => tx.query<{ registered: boolean }>(
    'select bob_private.push_register($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) as registered',
    [userId,sessionId,p.installation_id,p.token,p.environment,p.topic,p.app_version,p.local_timer_ids]));
  return rows[0]?.registered === true;
}

export async function listPushDevices(db: Db, userId: string): Promise<PushDevice[]> {
  return withUser(db,userId,(tx) => tx.query<PushDevice>(`select id,user_id as "userId",installation_id as "installationId",
    token,environment,topic,app_version as "appVersion",local_timer_ids as "localTimerIds",generation
    from bob.push_devices where user_id=$1 and last_seen_at > now()-interval '30 days'`,[userId]));
}

export async function removePushDevice(db: Db, userId: string, installationId: string): Promise<void> {
  await withUser(db,userId,(tx) => tx.query('delete from bob.push_devices where installation_id=$1',[installationId]));
}

export async function invalidatePushDevice(db: Db, device: PushDevice): Promise<void> {
  await withUser(db,device.userId,(tx) => tx.query('delete from bob.push_devices where id=$1 and generation=$2',
    [device.id,device.generation]));
}

export async function pushWasSent(db: Db, device: PushDevice, outboxId: string): Promise<boolean> {
  const rows = await withUser(db,device.userId,(tx) => tx.query<{ present: boolean }>(
    'select exists(select 1 from bob.push_receipts where device_id=$1 and outbox_id=$2) as present',[device.id,outboxId]));
  return rows[0]?.present === true;
}

export async function markPushSent(db: Db, device: PushDevice, outboxId: string): Promise<void> {
  await withUser(db,device.userId,(tx) => tx.query(`insert into bob.push_receipts(device_id,outbox_id,user_id)
    select id,$2,user_id from bob.push_devices where id=$1 on conflict do nothing`,[device.id,outboxId]));
}
