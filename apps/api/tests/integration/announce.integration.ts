/**
 * Announce flow (#551): a timer the scheduler fires, and a reminder the fan-out
 * delivers, both reach the connected device as `announce`; the device's
 * announce_ack clears it from the account's outbox. The reminder also lands as
 * an inbox row the web reads back.
 */
import type { Tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootIntegrationServer, connectDevice, control, events, waitUntil, type IntegrationServer,
} from '../integration-helpers.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
let server: IntegrationServer;
let tools: Record<string, Tool>;
let stopScheduler: () => void = () => undefined;

async function call<T>(name: string, input: unknown): Promise<T> {
  return (await tools[name]!.execute!(input as never, { toolCallId: `call_${name}`, messages: [], context: {} })) as T;
}

beforeAll(async () => {
  server = await bootIntegrationServer();
  const { ensurePrivateSpace } = await import('../../src/spaces/store.ts');
  const { webTurnTools } = await import('../../src/conversations/chat-tools.ts');
  const { startDeviceScheduler } = await import('../../src/workflows/workflow-timer-ring.ts');
  const spaceId = (await ensurePrivateSpace(server.db, server.userId)).id;
  tools = webTurnTools(appDeps, server.db, server.userId, 'UTC', spaceId);
  // server.ts main() starts the scheduler after listen; createV2Server does not.
  const scheduler = await startDeviceScheduler(appDeps);
  stopScheduler = (): void => {
    scheduler?.stop();
    appDeps.timerScheduler.reschedule = null;
  };
});

afterAll(async () => {
  stopScheduler();
  await server?.close();
});

describe('announce and ack', () => {
  it('a fired timer rings on the device and the ack clears it', async () => {
    const { getDeviceSessions } = await import('../../src/voice/device-sessions.ts');
    const device = await connectDevice(server);
    device.reset();
    const before = server.journal.length;
    const output = await call<{ ok: boolean; id: string }>('set_timer', { duration: 1, label: 'integration egg' });
    expect(output.ok).toBe(true);

    const ring = await device.waitFor('announce', 15_000);
    expect(ring.payload).toMatchObject({ announce_id: `tm_${output.id}`, kind: 'timer', ring: true });
    expect(getDeviceSessions().pendingAnnouncements(server.userId).map((item) => item.announce_id)).toContain(`tm_${output.id}`);
    expect(events(server.journal, 'v2.announce_queued', before)).toHaveLength(1);

    device.sendControl(control('announce_ack', { announce_id: ring.payload.announce_id, action: 'dismissed' }));
    await waitUntil(() => events(server.journal, 'v2.announce_acked', before).length === 1, 'v2.announce_acked');
    expect(events(server.journal, 'v2.announce_acked', before)[0]).toMatchObject({ action: 'dismissed', known: true });
    expect(getDeviceSessions().pendingAnnouncements(server.userId)).toHaveLength(0);
    device.close();
  });

  it('a due reminder fans out to an inbox row and an announce the device acks', async () => {
    const { createReminderFanout } = await import('../../src/workflows/workflow-reminder-fire.ts');
    const { getDeviceSessions } = await import('../../src/voice/device-sessions.ts');
    const created = await call<{ ok: boolean; reminderId: string }>('create_reminder', {
      text: 'Integration water the plants', when: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.ok).toBe(true);
    const device = await connectDevice(server);
    device.reset();
    const before = server.journal.length;

    // The clock is two hours on, so the reminder is due without waiting an hour.
    const fanout = createReminderFanout({ announce: (userId, announcement) => appDeps.deviceSessions.announce(userId, announcement), db: server.db, now: () => Date.now() + 2 * 3600_000 });
    expect(await fanout.tick()).toBeGreaterThanOrEqual(1);
    const fanned = events(server.journal, 'v2.reminder_fanout', before);
    expect(fanned).toHaveLength(1);
    expect(fanned[0]).toMatchObject({ due: 1, failed: 0, delivery_failed: 0, announced: 1, announce_failed: 0 });

    const inbox = await server.api<{ notifications: Array<{ type: string; resource_id: string }> }>('/api/notifications');
    expect(inbox.status).toBe(200);
    expect(inbox.body.notifications.filter((item) => item.type === 'reminder' && item.resource_id === created.reminderId))
      .toHaveLength(1);

    const announced = await device.waitFor('announce', 15_000);
    expect(announced.payload).toMatchObject({ kind: 'reminder', ring: false });
    device.sendControl(control('announce_ack', { announce_id: announced.payload.announce_id, action: 'played' }));
    await waitUntil(() => events(server.journal, 'v2.announce_acked', before).length === 1, 'v2.announce_acked');
    expect(getDeviceSessions().pendingAnnouncements(server.userId)).toHaveLength(0);

    // A second tick finds the occurrence recorded: no second inbox row.
    await fanout.tick();
    const again = await server.api<{ notifications: Array<{ resource_id: string }> }>('/api/notifications');
    expect(again.body.notifications.filter((item) => item.resource_id === created.reminderId)).toHaveLength(1);
    device.close();
  });
});
