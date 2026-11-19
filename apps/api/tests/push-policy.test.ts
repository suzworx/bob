import { expect,it } from 'vitest';
import { pushQuietDelay } from '../src/notifications/push-policy.ts';
import type { StoredPreference } from '../src/notifications/store.ts';
const pref: StoredPreference={ id:'p',userId:'u',spaceId:null,threadId:null,type:null,muted:false,
 quietHoursStart:'22:00:00',quietHoursEnd:'07:00:00',quietZone:'America/Los_Angeles' };
const notification={ spaceId:null,type:'reminder' as const,resourceType:'reminder',resourceId:'r' };
it('holds overnight windows through the repeated autumn hour and releases at local07:00',() => {
 expect(pushQuietDelay([pref],notification,Date.parse('2026-11-01T08:30:00Z'))).toBe(6.5*3_600_000);
 expect(pushQuietDelay([pref],notification,Date.parse('2026-11-01T15:00:00Z'))).toBe(0);
});
it('does not apply another space or type quiet setting',() => {
 expect(pushQuietDelay([{ ...pref,spaceId:'different' },{ ...pref,type:'mention' }],notification,Date.parse('2026-11-01T08:30:00Z'))).toBe(0);
});
