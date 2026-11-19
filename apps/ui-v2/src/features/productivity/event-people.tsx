import { useEffect, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { memberDisplayName } from '@/lib/display-name';
import {
  addAttendee,
  listAttendees,
  removeAttendee,
  setRsvp,
  type Attendee,
  type AttendeeResponse,
  type EventSummary,
} from '@/features/productivity/use-events';
import { useMembers, type MemberSummary } from '@/features/spaces/use-members';
import type { SpaceMember } from '@/features/spaces/use-spaces';
import { RsvpToken } from './rsvp-token';

// Who is invited to an event and the reader's own answer: the People part of
// the event dialog, in its own file so the dialog stays one screen of reading.
const NO_ATTENDEES = 'No one invited yet.';
const ATTENDEES_FAILED_ERROR = "Who's invited could not be loaded.";
const ORGANIZER_ONLY_NOTE = "Only the organizer can change who's invited.";
const PEOPLE_FORBIDDEN_ERROR = "Only the organizer can change who's invited.";
const PEOPLE_FAILED_ERROR = 'That change could not be saved.';

// use-members.ts's MemberSummary doesn't type a `handle` field, but
// /api/spaces/:id/members always sends one (web-spaces.ts toMemberSummary) --
// exactly what use-spaces.ts's SpaceMember models -- so this bridges the two
// shapes for the one shared display-name helper, without editing that file.
function asSpaceMembers(members: MemberSummary[]): SpaceMember[] {
  return members.map((member) => ({
    user_id: member.user_id,
    role: member.role,
    joined_at: member.joined_at,
    display_name: member.display_name ?? null,
    handle: (member as MemberSummary & { handle?: string }).handle ?? '',
    email: member.email ?? null,
  }));
}

// The matching member's own name if there is one, else -- only for an
// attendee with no matching member -- their own email, then a neutral
// fallback. Never a member's email and never a shortened id.
function attendeeName(attendee: Attendee, members: SpaceMember[]): string {
  if (attendee.user_id !== null) {
    const member = members.find((candidate) => candidate.user_id === attendee.user_id);
    if (member !== undefined) return memberDisplayName(members, attendee.user_id);
  }
  // An invitee who was invited by email and has never joined has no member
  // record and no name to show -- their email is the only honest thing to print.
  if (attendee.email && attendee.email.trim() !== '') return attendee.email.trim();
  return 'Someone';
}

/** Attendees and the caller's own RSVP for one event, mounted only once the
 *  event dialog has loaded the event -- it calls hooks unconditionally, so a
 *  closed or create-mode dialog must never render it. */
export function EventPeople({
  event,
  onChanged,
  canManage,
}: {
  event: EventSummary;
  onChanged: () => void;
  canManage: boolean;
}): ReactElement {
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const { members } = useMembers(event.space_id);
  const spaceMembers = asSpaceMembers(members);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [error, setError] = useState<'forbidden' | 'failed' | null>(null);
  // A failed read is said as one, never as "No one invited yet".
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListState('loading');
    void (async () => {
      const result = await listAttendees(event.id);
      if (cancelled) return;
      if (result.ok) {
        setAttendees(result.value);
        setListState('ready');
      } else {
        setListState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event.id, attempt]);

  const reload = async (): Promise<void> => {
    const result = await listAttendees(event.id);
    if (result.ok) {
      setAttendees(result.value);
      setListState('ready');
    }
  };

  const invite = async (userId: string): Promise<void> => {
    setError(null);
    const result = await addAttendee(event.id, userId);
    if (!result.ok) {
      setError(result.reason === 'forbidden' ? 'forbidden' : 'failed');
      return;
    }
    await reload();
    onChanged();
  };

  const remove = async (userId: string): Promise<void> => {
    setError(null);
    const result = await removeAttendee(event.id, userId);
    if (!result.ok) {
      setError(result.reason === 'forbidden' ? 'forbidden' : 'failed');
      return;
    }
    await reload();
    onChanged();
  };

  const respond = async (response: AttendeeResponse): Promise<void> => {
    setError(null);
    const result = await setRsvp(event.id, response);
    if (!result.ok) {
      setError(result.reason === 'forbidden' ? 'forbidden' : 'failed');
      return;
    }
    setAttendees((prev) => prev.map((attendee) => (attendee.user_id === me ? result.value : attendee)));
    onChanged();
  };

  const invitedIds = new Set(attendees.map((attendee) => attendee.user_id).filter((id): id is string => id !== null));
  const inviteOptions = members
    .filter((member) => !invitedIds.has(member.user_id))
    .map((member) => ({ value: member.user_id, label: memberDisplayName(spaceMembers, member.user_id) }));
  const mine = attendees.find((attendee) => attendee.user_id === me);

  return (
    <VStack gap={2}>
      <Text type="label">People</Text>
      {listState === 'failed' ? (
        <Banner
          status="error"
          title={ATTENDEES_FAILED_ERROR}
          container="card"
          endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)} />}
        />
      ) : listState === 'loading' ? (
        <Skeleton height={32} />
      ) : attendees.length === 0 ? (
        <Text type="supporting">{NO_ATTENDEES}</Text>
      ) : (
        <List hasDividers>
          {attendees.map((attendee) => {
            const name = attendeeName(attendee, spaceMembers);
            return (
              <ListItem
                key={`${attendee.user_id ?? ''}-${attendee.email ?? ''}`}
                label={name}
                endContent={
                  <HStack gap={2} vAlign="center">
                    <RsvpToken response={attendee.response} />
                    {canManage && attendee.user_id !== null && (
                      <IconButton
                        label={`Remove ${name}`}
                        icon={<Icon icon="close" size="sm" />}
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove(attendee.user_id as string)}
                      />
                    )}
                  </HStack>
                }
              />
            );
          })}
        </List>
      )}
      {canManage ? (
        <Selector
          label="Invite someone"
          placeholder="Add a member…"
          options={inviteOptions}
          value=""
          onChange={(id) => void invite(id)}
        />
      ) : (
        <Text type="supporting">{ORGANIZER_ONLY_NOTE}</Text>
      )}
      {mine !== undefined && (
        <SegmentedControl
          label="Your answer"
          value={mine.response === 'needs_action' ? '' : mine.response}
          onChange={(value) => void respond(value as AttendeeResponse)}
        >
          <SegmentedControlItem value="accepted" label="Going" />
          <SegmentedControlItem value="tentative" label="Maybe" />
          <SegmentedControlItem value="declined" label="Not going" />
        </SegmentedControl>
      )}
      {error === 'forbidden' && <Banner status="warning" title={PEOPLE_FORBIDDEN_ERROR} container="card" />}
      {error === 'failed' && <Banner status="error" title={PEOPLE_FAILED_ERROR} container="card" />}
    </VStack>
  );
}
