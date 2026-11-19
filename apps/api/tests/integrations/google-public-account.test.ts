import { describe, expect, it } from 'vitest';
import { publicGoogleAccount } from '../../src/integrations/google-http.ts';
import { GoogleAccountsResponseSchema } from '../../src/web-schemas.ts';

const base = { id: '6f9f2b2e-7c1a-4d3e-9a5b-0c1d2e3f4a5b', email: 'a@example.com', name: null, customName: null, selected: true, createdAt: 1 };

describe('public Google account', () => {
  it('returns the last requested access so Change access can start from it', () => {
    const account = publicGoogleAccount({ ...base, connectSubject: 'subject', authorizationCapabilities: ['calendar.write', 'gmail.draft'] });
    expect(account).toEqual({ ...base, access: ['calendar.write', 'gmail.draft'], needsReconnect: false });
    expect(GoogleAccountsResponseSchema.parse({ accounts: [account] }).accounts[0]).toEqual(account);
  });
  it('flags a legacy or selector-less row as needing reconnection and never exposes the subject', () => {
    const legacy = publicGoogleAccount({ ...base, connectSubject: null, authorizationCapabilities: null });
    expect(legacy).toEqual({ ...base, access: [], needsReconnect: true });
    expect(JSON.stringify(publicGoogleAccount({ ...base, connectSubject: 'secret-subject', authorizationCapabilities: [] }))).not.toContain('secret-subject');
  });
});
