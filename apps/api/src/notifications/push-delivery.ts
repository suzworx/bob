import { z } from 'zod';
import { withUser, type Db } from '../platform/db/db.ts';
import type { StoredOutboxRow } from '../platform/outbox/store.ts';
import type { OutboxHandler } from '../platform/outbox/worker.ts';
import { OutboxDeferredError } from '../platform/outbox/deferred.ts';
import { moduleJournal } from '../platform/logger.ts';
import { getNotificationByEffectKey,getPreferences,isMuted,type StoredNotification } from './store.ts';
import { describeNotifications } from './describe.ts';
import { configuredApnsSender,pushTopics } from './push-apns.ts';
import { invalidatePushDevice,listPushDevices,markPushSent,pushWasSent,type PushDevice } from './push-store.ts';
import { pushQuietDelay } from './push-policy.ts';

const journal = moduleJournal('notifications');
const UUID = z.string().uuid();
export const PUSH_NOTIFICATION_EVENT = 'push.notification';
export const PUSH_TIMER_EVENT = 'push.timer';
type Sender = NonNullable<ReturnType<typeof configuredApnsSender>>;
type PushPlan = { payload: Record<string,unknown>; expiresAt: number; timerId?: string };

async function notificationPlan(db: Db,userId: string,row: StoredOutboxRow,now: number): Promise<PushPlan | null> {
  const keys = await withUser(db,userId,(tx) => tx.query<{ effectKey: string }>(
    'select effect_key as "effectKey" from bob.notifications where id=$1',[row.resourceId]));
  const effectKey = keys[0]?.effectKey;
  if (!effectKey) return null;
  const n = await getNotificationByEffectKey(db,userId,effectKey);
  if (!n || n.readAt !== null || now-n.createdAt > 86_400_000) return null;
  const prefs = await getPreferences(db,userId);
  if (isMuted(prefs,{ spaceId:n.spaceId,threadId:n.resourceType === 'thread' ? n.resourceId : null,type:n.type })) return null;
  const delay = pushQuietDelay(prefs,n,now);
  if (delay > 0) throw new OutboxDeferredError(delay);
  const described = await describeNotifications(db,userId,[n]);
  if (described.failed > 0) throw new Error('push_resource_unavailable');
  if (!described.about[0]) return null;
  return { expiresAt:n.createdAt+86_400_000,payload:notificationPayload(userId,n) };
}

function notificationPayload(userId: string,n: StoredNotification): Record<string,unknown> {
  return {
    aps:{ alert:{ title:'Bob',body:n.type === 'reminder' ? 'You have a reminder.' : 'You have a new update.' },sound:'default' },
    bob:{ version:1,account_id:userId,kind:'notification',notification_id:n.id,
      resource_type:n.resourceType,resource_id:n.resourceId,space_id:n.spaceId },
  };
}

async function timerPlan(db: Db,userId: string,row: StoredOutboxRow,now: number): Promise<PushPlan | null> {
  const timers = await withUser(db,userId,(tx) => tx.query<{ firesAt: number; kind: string }>(
    `select floor(extract(epoch from due_at)*1000)::bigint as "firesAt",kind from bob.reminders
     where id=$1 and created_by=$2 and kind in ('timer','alarm') and status='fired'`,[row.resourceId,userId]));
  const timer = timers[0];
  if (!timer || now-Number(timer.firesAt) > 15*60_000) return null;
  return { timerId:row.resourceId,expiresAt:Number(timer.firesAt)+15*60_000,payload:{
    aps:{ alert:{ title:'Bob',body:timer.kind === 'alarm' ? 'Your alarm is ready.' : 'Your timer is ready.' },sound:'default' },
    bob:{ version:1,account_id:userId,kind:'timer',timer_id:row.resourceId },
  } };
}

/** Shared by both outbox event types. Recipient-bound reads are repeated at delivery, never inferred from a space roster. */
export function createPushHandler(deps: { db: Db; send?: Sender | null; now?: () => number }): OutboxHandler {
  const { db } = deps;
  const send = deps.send === undefined ? configuredApnsSender() : deps.send;
  const now = deps.now ?? Date.now;
  return async (row,signal): Promise<void> => {
    if (!send) return;
    const parsed = UUID.safeParse(row.payload.recipient_user_id);
    if (!parsed.success) return;
    const devices = await listPushDevices(db,parsed.data);
    if (devices.length === 0) return;
    const plan = row.eventType === PUSH_TIMER_EVENT
      ? await timerPlan(db,parsed.data,row,now()) : await notificationPlan(db,parsed.data,row,now());
    if (!plan) return;
    const { sent,invalid } = await deliverDevices(db,devices,plan,row,signal,send);
    journal('v2.push_delivery',{ sent,invalid });
  };
}

async function isCurrent(db: Db,device: PushDevice): Promise<boolean> {
  return (await listPushDevices(db,device.userId)).some((current) => current.id === device.id && current.generation === device.generation);
}

async function deliverDevices(db: Db,devices: PushDevice[],plan: PushPlan,row: StoredOutboxRow,
  signal: AbortSignal,send: Sender): Promise<{ sent: number; invalid: number }> {
  let sent = 0;
  let invalid = 0;
  for (const device of devices) {
    if (signal.aborted) throw new Error('push_aborted');
    if (!pushTopics().includes(device.topic) || (plan.timerId && device.localTimerIds.includes(plan.timerId))) continue;
    if (await pushWasSent(db,device,row.id)) continue;
    if (!await isCurrent(db,device)) continue;
    const result = await send({ token:device.token,environment:device.environment,topic:device.topic,
      id:row.id,payload:plan.payload,expiresAt:plan.expiresAt,signal });
    if (result === 'invalid') { await invalidatePushDevice(db,device); invalid += 1; }
    else { await markPushSent(db,device,row.id); sent += 1; }
  }
  return { sent,invalid };
}
