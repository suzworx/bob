import { describe, expect, it } from 'vitest';
import { googleCapabilitiesFromScopes } from '../../src/integrations/google-capabilities.ts';

describe('Google capabilities from actual granted scopes', () => {
  it('does not turn metadata or requested-looking unknown scopes into mailbox access', () => {
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/gmail.send',
      'gmail.readonly',
    ])).toEqual([]);
  });

  it('requires source-message access as well as compose permission for reply drafts', () => {
    expect(googleCapabilitiesFromScopes(['https://www.googleapis.com/auth/gmail.compose'])).toEqual([]);
    expect(googleCapabilitiesFromScopes(['https://www.googleapis.com/auth/gmail.readonly'])).toEqual(['gmail.read']);
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose',
    ])).toEqual(['gmail.read', 'gmail.draft', 'gmail.send']);
  });

  it('requires calendar discovery alongside event access for the current Calendar service', () => {
    expect(googleCapabilitiesFromScopes(['https://www.googleapis.com/auth/calendar.events'])).toEqual([]);
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ])).toEqual(['calendar.read']);
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ])).toEqual(['calendar.read', 'calendar.write']);
  });

  it('does not promote owned-only, public-only or freebusy access to unrestricted event tools', () => {
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.public.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ])).toEqual([]);
  });

  it('recognizes provider send and modify grants independently of product consent', () => {
    expect(googleCapabilitiesFromScopes([
      'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.modify',
    ])).toEqual(['calendar.read', 'calendar.write', 'gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify']);
    expect(googleCapabilitiesFromScopes(['https://mail.google.com/'])).toEqual(['gmail.read', 'gmail.draft', 'gmail.send', 'gmail.modify']);
  });

  it('returns no capabilities for absent grants and keeps readonly Calendar readonly', () => {
    expect(googleCapabilitiesFromScopes([])).toEqual([]);
    expect(googleCapabilitiesFromScopes(['https://www.googleapis.com/auth/calendar.readonly'])).toEqual(['calendar.read']);
  });
});
