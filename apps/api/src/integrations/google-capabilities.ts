import type { GoogleCapability } from './google-credentials.ts';

/** Interpret actual provider-granted scopes, never requested scopes or local
 * account metadata. This does not verify token identity, expiry or revocation. */
export function googleCapabilitiesFromScopes(scopes: readonly string[]): GoogleCapability[] {
  const granted = new Set(scopes);
  const has = (scope: string): boolean => granted.has(`https://www.googleapis.com/auth/${scope}`);
  const calendarList = has('calendar') || has('calendar.readonly')
    || has('calendar.calendarlist') || has('calendar.calendarlist.readonly');
  const eventRead = has('calendar') || has('calendar.readonly')
    || has('calendar.events') || has('calendar.events.readonly');
  const eventWrite = has('calendar') || has('calendar.events');
  const capabilities: GoogleCapability[] = [];
  if (calendarList && eventRead) capabilities.push('calendar.read');
  if (calendarList && eventWrite) capabilities.push('calendar.write');
  return [...capabilities, ...mailCapabilities(granted)];
}

function mailCapabilities(granted: Set<string>): GoogleCapability[] {
  const has = (scope: string): boolean => granted.has(`https://www.googleapis.com/auth/${scope}`);
  const fullMail = granted.has('https://mail.google.com/') || has('gmail.modify');
  const mailRead = fullMail || has('gmail.readonly');
  const draftWrite = fullMail || has('gmail.compose');
  const capabilities: GoogleCapability[] = [];
  if (mailRead) capabilities.push('gmail.read');
  // Draft and send tools both need to read the source or reviewed draft.
  if (mailRead && draftWrite) capabilities.push('gmail.draft', 'gmail.send');
  if (fullMail) capabilities.push('gmail.modify');
  return capabilities;
}

/** Provider grants cannot widen the product permissions explicitly selected by the owner.
 * Read dependencies are implicit; send, draft and modify remain independent. */
export function consentedGoogleCapabilities(
  granted: readonly GoogleCapability[], requested: readonly GoogleCapability[],
): GoogleCapability[] {
  const allowed = new Set(requested);
  if (allowed.has('calendar.write')) allowed.add('calendar.read');
  if (allowed.has('gmail.draft') || allowed.has('gmail.send') || allowed.has('gmail.modify')) allowed.add('gmail.read');
  return granted.filter((capability) => allowed.has(capability));
}
