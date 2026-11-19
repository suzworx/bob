/**
 * The first-party tool providers: timers, voice and device. Productivity,
 * memory and game tools stay assembled by their callers (they resolve a Space
 * or a game scope asynchronously first). `ctx.device` is how device tools bind
 * on each surface (the calling device, or every connected device on the web).
 */
import { createDeviceTools, createTimerTools, createVoiceTools } from '@bob/ai';
import { bindTimerTools } from '../timers/tools.ts';
import { createBobAppTools } from '../bob-apps/tools.ts';
import type { Db } from '../platform/db/db.ts';
import { bindDeviceTools } from './device-tools.ts';
import { bindVoiceTools } from './voice-tools.ts';
import type { ToolProvider } from './tool-registry.ts';

export interface FirstPartyToolContext {
  db: Db;
  userId: string;
  timeZone: string;
  /** The Space voice tools read; null omits them. */
  spaceId: string | null;
  timersChanged(userId?: string): Promise<void>;
  /** How device tools bind on this surface; absent omits them. */
  device?: Parameters<typeof bindDeviceTools>[0];
}

/** Timers first (account-wide), then voice, then device: the order (and cache-v1 slots) turns have always had. */
export function firstPartyToolProviders(): ToolProvider<FirstPartyToolContext>[] {
  return [
    {
      id: 'bob.bob-apps', scopes: ['bob-apps'], slot: 'late', order: 40,
      needs: (ctx) => ctx.spaceId !== null,
      createTools: (ctx) => ctx.spaceId === null ? {} : createBobAppTools(ctx.db, ctx.userId, ctx.spaceId),
    },
    {
      id: 'bob.timers', scopes: ['timers'], slot: 'early', order: 10,
      needs: () => true,
      createTools: (ctx) => createTimerTools(bindTimerTools(ctx.db, ctx.userId, { timeZone: ctx.timeZone, onChange: ctx.timersChanged })),
    },
    {
      id: 'bob.voice', scopes: ['voice.query'], slot: 'late', order: 20,
      needs: (ctx) => ctx.spaceId !== null,
      createTools: (ctx) => createVoiceTools(bindVoiceTools(ctx.db, ctx.userId, { spaceId: ctx.spaceId as string, timeZone: ctx.timeZone })),
    },
    {
      id: 'bob.device', scopes: ['device.control'], slot: 'late', order: 30,
      needs: (ctx) => ctx.device !== undefined,
      createTools: (ctx) => {
        const device = ctx.device as NonNullable<FirstPartyToolContext['device']>;
        const { express, ...tools } = createDeviceTools(bindDeviceTools(device));
        // Offered only when a target device can show it: otherwise "show me some love" is a plain warm reply.
        return express !== undefined && device.registry.hasCap(device.userId, device.deviceId, 'express') ? { ...tools, express } : tools;
      },
    },
  ];
}
