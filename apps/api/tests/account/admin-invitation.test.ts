import { describe, expect, it, vi } from 'vitest';
import { createAdminInvitationHandler } from '../../src/account/admin-invitation.ts';
import type { Db } from '../../src/platform/db/db.ts';
import type { StoredOutboxRow } from '../../src/platform/outbox/store.ts';

const row = { effectKey: 'admin-invite:recipient', resourceId: 'recipient' } as StoredOutboxRow;
/** A live (never aborted) signal, the workers' normal case for these handlers. */
const SIGNAL = new AbortController().signal;
function fixture(options: { sent?: boolean; eligible?: boolean; configured?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('email_effect_sent')) return [{ sent: options.sent ?? false }];
    if (sql.includes('admin_invitation_recipient'))
      return [{ email: options.eligible === false ? null : 'person@example.test' }];
    return [{ marked: true }];
  });
  const db: Db = { query: query as Db['query'], tx: async (fn) => fn(db) };
  const send = vi.fn(async () => undefined);
  return {
    query,
    send,
    handler: createAdminInvitationHandler({
      db,
      send,
      configured: () => options.configured ?? true,
    }),
  };
}
describe('admin invitation delivery', () => {
  it('uses the fixed Bob template and records SMTP acceptance only after send', async () => {
    const f = fixture();
    await f.handler(row, SIGNAL);
    expect(f.send).toHaveBeenCalledWith({
      template: 'bob-account-invite',
      to: 'person@example.test',
      data: {},
    });
    expect(f.query.mock.calls.at(-1)?.[0]).toContain('email_effect_mark');
  });
  it('does not resend a recorded effect', async () => {
    const f = fixture({ sent: true });
    await f.handler(row, SIGNAL);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('suppresses erased or banned recipients without recording sent', async () => {
    const f = fixture({ eligible: false });
    await f.handler(row, SIGNAL);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => sql.includes('email_effect_mark'))).toBe(false);
  });
  it('throws for unconfigured delivery so the worker retries without a sent marker', async () => {
    const f = fixture({ configured: false });
    await expect(f.handler(row, SIGNAL)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('preserves the unsent effect when SMTP fails', async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error('synthetic failure'));
    await expect(f.handler(row, SIGNAL)).rejects.toThrow('synthetic failure');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('email_effect_mark'))).toBe(false);
  });
});
