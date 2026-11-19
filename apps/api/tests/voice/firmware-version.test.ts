/**
 * #345: the firmware version and caps in hello, the BOB_MIN_FW_VERSION gate
 * (welcome min_fw_version, update_required, refused turns) and the caps gate
 * on reply_text. Sessions here carry no upgrade auth, so no store is touched;
 * the exact wire bytes are pinned in wire-fixtures.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createSession, sendDto, updateRequiredReason, type DeviceSession } from '../../src/voice/session-handlers.ts';
import { handleControl } from '../../src/voice/session.ts';
import {
  ClientControlDtoSchema,
  compareFirmwareVersions,
  FirmwareVersionSchema,
  replyTextDto,
  type ClientControlDto,
} from '../../src/voice/protocol.ts';
import { setJournalSink } from '../../src/platform/logger.ts';

import { createAppDeps } from '../../src/app-deps.ts';
const appDeps = createAppDeps();
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn> }
const makeSocket = (): FakeSocket => ({ readyState: 1, send: vi.fn() });
const hello = (payload: Record<string, unknown>): unknown => ({ v: 1, type: 'hello', id: 'hello_123456_v2', payload });
const control = (type: string, extra: Record<string, unknown> = {}): ClientControlDto =>
  ({ v: 1, type, id: 'test_ctrl_000001', payload: {}, ...extra }) as unknown as ClientControlDto;
const sentTypes = (socket: FakeSocket): string[] =>
  socket.send.mock.calls.map((call) => (JSON.parse(call[0] as string) as { type: string }).type);

let journalLines: string[];
/** The journal entries for one event, parsed. */
const journaled = (event: string): Record<string, unknown>[] =>
  journalLines.filter((line) => line.includes(`"${event}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);

async function connect(socket: FakeSocket, payload: Record<string, unknown>): Promise<DeviceSession> {
  const session = createSession();
  await handleControl(appDeps, socket as unknown as WebSocket, session, ClientControlDtoSchema.parse(hello(payload)), vi.fn());
  return session;
}

beforeEach(() => {
  journalLines = [];
  setJournalSink((line: string) => journalLines.push(line));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('hello fw_version and caps (strict Zod, never fatal to the hello)', () => {
  it.each(['0.1.0', '1.12.3', '0.2.0-dev+abc1234', '10.0.0-rc.1'])('accepts %s', (version) => {
    expect(FirmwareVersionSchema.safeParse(version).success).toBe(true);
    const parsed = ClientControlDtoSchema.parse(hello({ format_id: 2, fw_version: version }));
    expect(parsed.type === 'hello' && parsed.payload.fw_version).toBe(version);
  });

  it.each([
    ['not semver', '1.2'], ['a path', '../../etc/passwd'], ['over 32 chars', `1.2.3-${'a'.repeat(27)}`],
    ['a number', 7], ['empty', ''], ['leading zero', '01.2.3'],
  ])('reads %s as invalid and keeps the hello', (_label, version) => {
    const parsed = ClientControlDtoSchema.safeParse(hello({ format_id: 2, fw_version: version }));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.type === 'hello' && parsed.data.payload.fw_version).toBe('invalid');
  });

  it('the old hello has neither field; malformed caps read as absent', () => {
    const old = ClientControlDtoSchema.parse(hello({ format_id: 1 }));
    expect(old.type === 'hello' && old.payload).toEqual({ format_id: 1 });
    for (const caps of [['Reply Text'], 'reply_text', Array.from({ length: 17 }, () => 'announce')]) {
      const parsed = ClientControlDtoSchema.parse(hello({ format_id: 2, caps }));
      expect(parsed.type === 'hello' && parsed.payload.caps).toBeUndefined();
    }
    // HELLO-COMPAT: an undeclared key is stripped, not fatal to the hello.
    const extra = ClientControlDtoSchema.parse(hello({ format_id: 2, extra: 1 }));
    expect(extra.type === 'hello' && extra.payload).toEqual({ format_id: 2 });
  });

  it('journals v2.hello with the version (or unknown/invalid) and caps_count only', async () => {
    await connect(makeSocket(), { format_id: 2, fw_version: '0.3.0', caps: ['reply_text', 'announce'] });
    await connect(makeSocket(), { format_id: 2 });
    await connect(makeSocket(), { format_id: 2, fw_version: 'x'.repeat(40) });
    const entries = journaled('v2.hello');
    expect(entries.map((entry) => [entry.fw_version, entry.caps_count])).toEqual([
      ['0.3.0', 2], ['unknown', undefined], ['invalid', undefined],
    ]);
  });
});

describe('compareFirmwareVersions and updateRequiredReason', () => {
  it.each([
    ['0.1.0', '0.2.0', -1], ['0.10.0', '0.9.9', 1], ['1.2.3', '1.2.3', 0], ['1.2.3+abc', '1.2.3+def', 0],
    ['1.2.0-dev+abc', '1.2.0', -1], ['1.2.0-dev', '1.1.9', 1], ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-1', '1.0.0-alpha', -1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareFirmwareVersions(a, b))).toBe(sign);
    expect(Math.sign(compareFirmwareVersions(b, a))).toBe(-sign || 0);
  });

  it('nothing is required without a minimum; unknown and invalid cannot prove they are new enough', () => {
    expect(updateRequiredReason('unknown', undefined)).toBeUndefined();
    expect(updateRequiredReason('0.0.1', undefined)).toBeUndefined();
    expect(updateRequiredReason('unknown', '0.2.0')).toBe('unknown_version');
    expect(updateRequiredReason('invalid', '0.2.0')).toBe('unknown_version');
    expect(updateRequiredReason('0.1.9', '0.2.0')).toBe('below_minimum');
    expect(updateRequiredReason('0.2.0', '0.2.0')).toBeUndefined();
    expect(updateRequiredReason('0.2.1-dev+abc', '0.2.0')).toBeUndefined();
  });
});

describe('the BOB_MIN_FW_VERSION gate', () => {
  it('unset: an old hello without fw_version keeps working', async () => {
    const socket = makeSocket();
    const session = await connect(socket, { format_id: 2 });
    expect(sentTypes(socket)).toEqual(['welcome']);
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), vi.fn());
    expect(session.stage).toBe('capturing');
  });

  it.each(['0.2.0', '0.2.1', '1.0.0'])('at or above the minimum (%s): welcome only, turns work', async (version) => {
    vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
    const socket = makeSocket();
    const session = await connect(socket, { format_id: 2, fw_version: version });
    expect(sentTypes(socket)).toEqual(['welcome']);
    expect(session.updateRequired).toBeUndefined();
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('turn_start', { turn_ref: 'turn_0001_abcd' }), vi.fn());
    expect(session.stage).toBe('capturing');
  });

  it('below: update_required, then turns and pickers are refused while pong and device_state are not', async () => {
    vi.stubEnv('BOB_MIN_FW_VERSION', '0.2.0');
    const socket = makeSocket();
    const session = await connect(socket, { format_id: 2, fw_version: '0.2.0-dev+abc1234' });
    expect(sentTypes(socket)).toEqual(['welcome', 'update_required']);
    expect(journaled('v2.update_required')[0]).toMatchObject({ reason: 'below_minimum', fw_version: '0.2.0-dev+abc1234', min_version: '0.2.0' });
    socket.send.mockClear();
    for (const dto of [control('turn_start', { turn_ref: 'turn_0001_abcd' }), control('list_conversations'), control('cancel')]) {
      await handleControl(appDeps, socket as unknown as WebSocket, session, dto, vi.fn());
    }
    await handleControl(appDeps, socket as unknown as WebSocket, session, control('pong'), vi.fn());
    expect(sentTypes(socket)).toEqual(['error', 'error', 'error']);
    expect(socket.send.mock.calls.every((call) => (call[0] as string).includes('"UPDATE_REQUIRED"'))).toBe(true);
    expect(session.stage).toBe('ready');
  });

  it('a malformed BOB_MIN_FW_VERSION is journaled and ignored, never a lockout', async () => {
    vi.stubEnv('BOB_MIN_FW_VERSION', 'latest');
    const socket = makeSocket();
    await connect(socket, { format_id: 2 });
    expect(sentTypes(socket)).toEqual(['welcome']);
    expect(journaled('v2.min_fw_version_invalid')).toHaveLength(1);
  });
});

describe('caps gate reply_text', () => {
  const reply = replyTextDto('turn_0001_abcd', 'heard', 'reply');

  it.each([
    ['caps without reply_text', { caps: ['device_control', 'announce'] }, []],
    ['caps with reply_text', { caps: ['reply_text'] }, ['reply_text']],
    ['no caps (older firmware)', {}, ['reply_text']],
    ['malformed caps', { caps: 'reply_text' }, ['reply_text']],
  ])('%s', async (_label, extra, expected) => {
    const socket = makeSocket();
    await connect(socket, { format_id: 2, fw_version: '0.3.0', ...extra });
    socket.send.mockClear();
    sendDto(socket as unknown as WebSocket, reply);
    expect(sentTypes(socket)).toEqual(expected);
    expect(journaled('v2.message_skipped')).toHaveLength(expected.length === 0 ? 1 : 0);
  });
});
