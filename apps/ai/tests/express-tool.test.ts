import { describe, expect, it, vi } from 'vitest';
import { createDeviceTools, EXPRESS_EMOTIONS } from '../src/device-tools.ts';
import type { DeviceCallbacks } from '../src/device-tools.ts';

type ExpressTool = {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  description: string;
};

function expressTool(express: DeviceCallbacks['express']): ExpressTool {
  const cb: DeviceCallbacks = { setVolume: vi.fn(), setMode: vi.fn(), express };
  return createDeviceTools(cb).express as unknown as ExpressTool;
}

describe('express tool', () => {
  it('shows the emotion for six seconds by default', async () => {
    const express = vi.fn(async () => undefined);
    const out = await expressTool(express).execute({ emotion: 'love' }, {});
    expect(express).toHaveBeenCalledWith({ emotion: 'love', seconds: 6 });
    expect(out).toMatchObject({ ok: true });
  });

  it('passes explicit seconds and rejects unknown emotions and bad seconds', async () => {
    const express = vi.fn(async () => undefined);
    const tool = expressTool(express);
    await tool.execute({ emotion: 'music', seconds: 10 }, {});
    expect(express).toHaveBeenCalledWith({ emotion: 'music', seconds: 10 });
    expect(tool.inputSchema.safeParse({ emotion: 'grr' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ emotion: 'love', seconds: 16 }).success).toBe(false);
    expect(EXPRESS_EMOTIONS).toHaveLength(47);
  });

  it('returns { ok: false, reason } when the device is not reachable', async () => {
    const out = await expressTool(async () => { throw new Error('your device is not connected'); }).execute({ emotion: 'love' }, {});
    expect(out).toEqual({ ok: false, reason: 'your device is not connected' });
  });

  it('describes when to use it', () => {
    expect(expressTool(vi.fn()).description).toMatch(/love|affection/i);
  });
});
