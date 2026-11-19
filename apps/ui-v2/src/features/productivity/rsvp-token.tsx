import type { ReactElement } from 'react';
import { Token } from '@astryxdesign/core/Token';
import type { AttendeeResponse } from '@/features/productivity/use-events';

function rsvpLabel(response: AttendeeResponse): string {
  if (response === 'accepted') return 'Going';
  if (response === 'tentative') return 'Maybe';
  if (response === 'declined') return 'Not going';
  return 'Invited';
}

function rsvpColor(response: AttendeeResponse): 'green' | 'yellow' | 'gray' | 'blue' {
  if (response === 'accepted') return 'green';
  if (response === 'tentative') return 'yellow';
  if (response === 'declined') return 'gray';
  return 'blue';
}

export function RsvpToken({ response }: { response: AttendeeResponse | null | undefined }): ReactElement | null {
  if (response === null || response === undefined) return null;
  return <Token size="sm" label={rsvpLabel(response)} color={rsvpColor(response)} />;
}
