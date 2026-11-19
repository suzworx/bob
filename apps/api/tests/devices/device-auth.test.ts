/**
 * Unit tests for the /v2/cardputer upgrade guard (T018, contract
 * "Upgrade authentication"): the DB-free decision paths. The device-token
 * paths (P-13, P-20) live in device-auth-pairing.test.ts where a Postgres store
 * seeds real devices.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDeviceAuthGuard,
  resetUnpairedSockets,
  type DeviceAuth,
} from '../../src/devices/device-auth.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
function wsResponse() {
  let rejected: { code?: number; message?: string } | null = null;
  return {
    reject(code?: number, message?: string) { rejected = { code, message }; },
    rejected: () => rejected,
  } as never;
}

interface FakeSocket {
  remoteAddress: string;
  closeHandlers: Array<() => void>;
}

function makeSocket(remoteAddress: string): FakeSocket {
  return { remoteAddress, closeHandlers: [] };
}

function wsRequest(auth: string | undefined, socket: FakeSocket) {
  return {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? auth : undefined),
    socket: {
      remoteAddress: socket.remoteAddress,
      once: (event: string, handler: () => void): void => {
        if (event === 'close') socket.closeHandlers.push(handler);
      },
    },
    deviceAuth: undefined as DeviceAuth | undefined,
  } as never;
}

const originalLegacyOwner = process.env.BOB_LEGACY_DEVICE_OWNER;

afterEach(() => {
  resetUnpairedSockets();
  setJournalSink(null);
  if (originalLegacyOwner === undefined) delete process.env.BOB_LEGACY_DEVICE_OWNER;
  else process.env.BOB_LEGACY_DEVICE_OWNER = originalLegacyOwner;
});

describe('device WebSocket auth upgrade table', () => {
  it('accepts a missing header as an unpaired session with reason none', async () => {
    const next = vi.fn();
    const request = wsRequest(undefined, makeSocket('203.0.113.1'));
    await createDeviceAuthGuard('secret', appDeps.getDb)(request, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect((request as unknown as { deviceAuth?: DeviceAuth }).deviceAuth).toEqual({
      kind: 'unpaired',
      reason: 'none',
    });
  });

  it('rejects any other bearer with 401 invalid_token when no legacy owner is set', async () => {
    delete process.env.BOB_LEGACY_DEVICE_OWNER;
    const next = vi.fn();
    const res = wsResponse();
    await createDeviceAuthGuard('secret', appDeps.getDb)(wsRequest('Bearer wrong-secret', makeSocket('203.0.113.1')), res, next);
    expect(next).not.toHaveBeenCalled();
    expect((res as unknown as { rejected: () => { code?: number; message?: string } | null }).rejected()).toMatchObject({
      code: 401,
      message: 'invalid_token',
    });
  });

  it('accepts the matching shared secret as a legacy session only when BOB_LEGACY_DEVICE_OWNER is set', async () => {
    process.env.BOB_LEGACY_DEVICE_OWNER = '11111111-1111-4111-8111-111111111111';
    const next = vi.fn();
    const request = wsRequest('Bearer secret', makeSocket('203.0.113.1'));
    await createDeviceAuthGuard('secret', appDeps.getDb)(request, wsResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect((request as unknown as { deviceAuth?: DeviceAuth }).deviceAuth).toEqual({
      kind: 'legacy',
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: null,
    });
  });

  it('refuses a 4th concurrent unpaired socket from one IP with 503', async () => {
    const ip = '198.51.100.7';
    const sockets: FakeSocket[] = [];
    const guard = createDeviceAuthGuard('secret', appDeps.getDb);
    for (let index = 0; index < 3; index += 1) {
      const socket = makeSocket(ip);
      sockets.push(socket);
      const next = vi.fn();
      await guard(wsRequest(undefined, socket), wsResponse(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    const res = wsResponse();
    await guard(wsRequest(undefined, makeSocket(ip)), res, vi.fn());
    expect((res as unknown as { rejected: () => { code?: number; message?: string } | null }).rejected()).toMatchObject({
      code: 503,
      message: 'too_many_unpaired',
    });

    // A closed socket releases its slot; a fresh one is then accepted.
    sockets[0]!.closeHandlers.forEach((handler) => handler());
    const after = vi.fn();
    await guard(wsRequest(undefined, makeSocket(ip)), wsResponse(), after);
    expect(after).toHaveBeenCalledOnce();
  });

  it('journals the refusal reason without the secret or the submitted token', async () => {
    const lines: string[] = [];
    setJournalSink((line) => lines.push(line));
    await createDeviceAuthGuard('expected-secret', appDeps.getDb)(
      wsRequest('Bearer submitted-token', makeSocket('203.0.113.1')),
      wsResponse(),
      vi.fn(),
    );
    const joined = lines.join('');
    expect(joined).toContain('invalid_token');
    expect(joined).not.toContain('expected-secret');
    expect(joined).not.toContain('submitted-token');
  });
});