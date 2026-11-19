/**
 * Type-prefixed ids (IDS epic, P1): the registry, newId, canonicalId, uuidOf and
 * the tolerant EntityId schema. Expected values are literals (the md5 forms were
 * computed once with node:crypto), never recomputed the way the code does.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalId, EntityId, ID_PREFIX, newId, uuidOf, type IdKind } from '../../src/platform/ids.ts';

const UUID = '1c3434d3-d78b-4dbf-b83b-9d6c1667d84b';
const HEX = '1c3434d3d78b4dbfb83b9d6c1667d84b';
const NANOID = 'aB3dE5fG7hJ9kL1m';
const NANOID_MD5 = 'a5732ea4152c064794f8001453379ecd';
const MSG_DASH = 'msg-0123456789abcdef0123456789abcdef';
const MSG_DASH_MD5 = 'fc16f96c92a9c37a323bb7d0f47a4e22';

describe('ID_PREFIX', () => {
  it('is the owner-approved registry, exactly', () => {
    expect(ID_PREFIX).toEqual({
      conversation: 'conv', message: 'msg', message_version: 'ver', memory: 'mem', action_item: 'act',
      space: 'spc', space_membership: 'mbr', space_invitation: 'inv', device: 'dev', pairing_request: 'prq',
      ai_invocation: 'aiv', game_session: 'game', google_account: 'gacc', task: 'task', task_subscriber: 'tsub',
      note: 'note', note_revision: 'nrev', calendar: 'cal', calendar_event: 'evt', event_attendee: 'att',
      event_exception: 'exc', reminder: 'rem', reminder_recipient: 'rrcp', reminder_occurrence: 'rocc',
      notification: 'ntf', notification_preference: 'npref', outbox: 'obx', publication: 'pub', waitlist: 'wl',
    });
  });

  it('has no prefix shared by two kinds', () => {
    const prefixes = Object.values(ID_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('keeps space and pairing ids within the 36-char Cardputer buffers', () => {
    expect(newId('space')).toHaveLength(36);
    expect(newId('pairing_request')).toHaveLength(36);
  });
});

describe('newId', () => {
  it.each(Object.keys(ID_PREFIX) as IdKind[])('%s: prefix + 32 lowercase hex of a v4 uuid', (kind) => {
    const id = newId(kind);
    expect(id).toMatch(new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$`));
    expect(canonicalId(kind, id)).toBe(id);
  });

  it('is unique', () => {
    expect(newId('conversation')).not.toBe(newId('conversation'));
  });
});

describe('canonicalId', () => {
  it.each<[IdKind, string, string]>([
    ['space', `spc_${HEX}`, `spc_${HEX}`],
    ['space', UUID, `spc_${HEX}`],
    ['space', UUID.toUpperCase(), `spc_${HEX}`],
    ['space', HEX, `spc_${HEX}`],
    ['conversation', `conv_${HEX}`, `conv_${HEX}`],
    ['conversation', `cnv_${UUID}`, `conv_${HEX}`],
    ['conversation', `thr_${UUID}`, `conv_${HEX}`],
    ['conversation', `conv_${UUID}`, `conv_${HEX}`],
    ['conversation', UUID, `conv_${HEX}`],
    ['message', `msg_${UUID}`, `msg_${HEX}`],
    ['memory', `mem_${UUID}`, `mem_${HEX}`],
    ['action_item', `act_${UUID}`, `act_${HEX}`],
    ['message_version', `ver_${UUID}`, `ver_${HEX}`],
    ['message', NANOID, `msg_${NANOID_MD5}`],
    ['message', MSG_DASH, `msg_${MSG_DASH_MD5}`],
  ])('%s %s -> %s', (kind, input, expected) => {
    expect(canonicalId(kind, input)).toBe(expected);
  });

  it('is idempotent on the md5 form', () => {
    expect(canonicalId('message', `msg_${NANOID_MD5}`)).toBe(`msg_${NANOID_MD5}`);
  });

  it.each<[IdKind, string]>([
    ['space', ''],
    ['space', 'short'],
    ['space', 'has space in it'],
    ['space', 'semi;colon-id'],
    ['space', 'x'.repeat(65)],
    ['conversation', `spc_${HEX}`],
    ['space', `conv_${HEX}`],
    ['message', `mem_${HEX}`],
  ])('%s %j -> null (garbage or another kind\'s id)', (kind, input) => {
    expect(canonicalId(kind, input)).toBeNull();
  });

  it('keeps every conversation id within 64 chars', () => {
    for (const input of [UUID, `cnv_${UUID}`, `thr_${UUID}`, 'z'.repeat(64), newId('conversation')]) {
      expect(canonicalId('conversation', input)!.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('uuidOf', () => {
  it('returns the dashed uuid of a prefixed id', () => {
    expect(uuidOf('space', `spc_${HEX}`)).toBe(UUID);
    expect(uuidOf('conversation', `thr_${UUID}`)).toBe(UUID);
  });

  it('round-trips with canonicalId', () => {
    for (let i = 0; i < 50; i += 1) {
      const uuid = randomUUID();
      expect(uuidOf('conversation', canonicalId('conversation', uuid)!)).toBe(uuid);
      const id = newId('reminder');
      expect(canonicalId('reminder', uuidOf('reminder', id)!)).toBe(id);
    }
  });

  it('is null for garbage', () => {
    expect(uuidOf('space', 'nope')).toBeNull();
  });
});

describe('EntityId', () => {
  it('accepts every legacy form and outputs the canonical id', () => {
    const schema = EntityId('conversation');
    expect(schema.parse(`cnv_${UUID}`)).toBe(`conv_${HEX}`);
    expect(schema.parse(`thr_${UUID}`)).toBe(`conv_${HEX}`);
    expect(schema.parse(UUID)).toBe(`conv_${HEX}`);
    expect(schema.parse(`conv_${HEX}`)).toBe(`conv_${HEX}`);
  });

  it('rejects garbage and non-strings', () => {
    const schema = EntityId('space');
    expect(schema.safeParse('bad id!').success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(`conv_${HEX}`).success).toBe(false);
  });
});
