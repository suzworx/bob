import { describe, expect, it } from 'vitest';
import { googleCapabilitiesFromScopes, consentedGoogleCapabilities } from '../../src/integrations/google-capabilities.ts';

describe('Google provider and product capability boundaries', () => {
  const scope = (value: string): string => `https://www.googleapis.com/auth/${value}`;
  it('recognizes compose plus read as provider send capability without mailbox modification', () => {
    expect(googleCapabilitiesFromScopes([scope('gmail.readonly'), scope('gmail.compose')]))
      .toEqual(['gmail.read', 'gmail.draft', 'gmail.send']);
    expect(googleCapabilitiesFromScopes([scope('gmail.send')])).toEqual([]);
  });
  it('recognizes modify provider grants without authorizing other product choices', () => {
    const granted = googleCapabilitiesFromScopes([scope('gmail.modify')]);
    expect(granted).toEqual(['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify']);
    expect(consentedGoogleCapabilities(granted, ['gmail.modify'])).toEqual(['gmail.read', 'gmail.modify']);
    expect(consentedGoogleCapabilities(granted, ['gmail.draft'])).toEqual(['gmail.read', 'gmail.draft']);
    expect(consentedGoogleCapabilities(granted, ['gmail.send'])).toEqual(['gmail.read', 'gmail.send']);
    expect(consentedGoogleCapabilities(granted, [])).toEqual([]);
  });
});
