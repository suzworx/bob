import { useRef, useState, type ReactElement } from 'react';
import { LogOut, UserMinus, UserPlus, X } from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { memberDisplayName } from '@/lib/display-name';
import {
  useMembers,
  type InvitationSummary,
  type InviteInput,
  type InviteRole,
  type IssuedInvite,
  type MemberSummary,
} from '@/features/spaces/use-members';
import type { Space } from '@/features/spaces/use-spaces';
import { useInitialLoading, useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { SPACE_GUTTER } from './space-header';

const LOADING = 'Loading members…';
const EMPTY = 'No members yet.';

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  if (role === 'member') return 'Member';
  return role;
}

function isPrivileged(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** A divider between two non-empty groups, none otherwise. */
function withDivider(first: DropdownMenuOption[], second: DropdownMenuOption[]): DropdownMenuOption[] {
  return first.length > 0 && second.length > 0 ? [...first, { type: 'divider' }, ...second] : [...first, ...second];
}

/** A member row's menu: role changes, then Remove or Leave space (destructive, last). */
function memberMenuItems(options: {
  role: string;
  isSelf: boolean;
  canChangeRole: boolean;
  canMakeOwner: boolean;
  canRemove: boolean;
  onChangeRole: (role: InviteRole) => void;
  onMakeOwner: () => void;
  onRemove: () => void;
}): DropdownMenuOption[] {
  const next: InviteRole = options.role === 'admin' ? 'member' : 'admin';
  const roles: DropdownMenuOption[] = [];
  if (options.canChangeRole) roles.push({ label: `Make ${next}`, onClick: () => options.onChangeRole(next) });
  if (options.canMakeOwner) roles.push({ label: 'Make owner', onClick: options.onMakeOwner });
  if (!options.canRemove) return roles;
  const remove: DropdownMenuOption = options.isSelf
    ? { label: 'Leave space', icon: LogOut, variant: 'destructive', onClick: options.onRemove }
    : { label: 'Remove', icon: UserMinus, variant: 'destructive', onClick: options.onRemove };
  return withDivider(roles, [remove]);
}

/**
 * One member row: Avatar, name, a neutral role Token and one MoreMenu whose
 * items are built only while it is open (grouped by intent, destructive last).
 */
function MemberRow({
  label,
  isSelf,
  canRemove,
  onRemove,
  canMakeOwner,
  onMakeOwner,
  role,
  canChangeRole,
  rolePending,
  onChangeRole,
}: {
  canChangeRole: boolean;
  rolePending: boolean;
  onChangeRole: (role: InviteRole) => void;
  label: string;
  isSelf: boolean;
  canRemove: boolean;
  onRemove: () => void;
  canMakeOwner: boolean;
  onMakeOwner: () => void;
  role: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const items = (): DropdownMenuOption[] =>
    memberMenuItems({ role, isSelf, canChangeRole, canMakeOwner, canRemove, onChangeRole, onMakeOwner, onRemove });
  const hasActions = canChangeRole || canMakeOwner || canRemove;
  return (
    <ListItem
      label={isSelf ? `${label} (you)` : label}
      startContent={<Avatar name={label} size="sm" />}
      endContent={
        <HStack gap={2} vAlign="center">
          <Token label={roleLabel(role)} size="sm" />
          {hasActions && (
            <MoreMenu
              label={`Member actions for ${label}`}
              size="sm"
              alignment="end"
              presentation="adaptive"
              isDisabled={rolePending}
              isMenuOpen={open}
              onOpenChange={setOpen}
              items={open ? items() : []}
            />
          )}
        </HStack>
      }
    />
  );
}

function InvitationRow({
  invitation,
  onRevoke,
}: {
  invitation: InvitationSummary;
  onRevoke: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <ListItem
      label={invitation.invited_email}
      startContent={<Avatar name={invitation.invited_email} size="sm" />}
      description={
        <>
          {'Invited · expires '}
          <Timestamp value={invitation.expires_at} format="date" type="inherit" color="inherit" />
        </>
      }
      endContent={
        <MoreMenu
          label={`Invitation actions for ${invitation.invited_email}`}
          size="sm"
          alignment="end"
          presentation="adaptive"
          isMenuOpen={open}
          onOpenChange={setOpen}
          items={open ? [{ label: 'Revoke invitation', icon: X, variant: 'destructive', onClick: onRevoke }] : []}
        />
      }
    />
  );
}

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];
const COPY_FAILED = 'Copy failed — select the link text to copy it manually.';

export type { IssuedInvite };

// The server returns the raw invite token exactly once (only a hash is stored),
// so it lives in this component's state alone: never persisted, never logged.
// A bare token string is still accepted and means no email was reported.
export function InviteForm({
  onInvite,
  onCancel,
}: {
  onInvite: (input: InviteInput) => Promise<string | IssuedInvite | null>;
  onCancel: () => void;
}): ReactElement {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<({ email: string } & IssuedInvite) | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // Enter fires both onEnter and the form's submit, so the in-flight guard is a
  // ref: a state flag would not be visible to the second call yet.
  const inFlight = useRef(false);

  const submit = async (): Promise<void> => {
    const trimmed = email.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setInviting(true);
    try {
      const result = await onInvite({ email: trimmed, role });
      // A failed invite keeps the typed email; the hook's shared error reports it.
      if (result === null) return;
      setIssued({ email: trimmed, ...(typeof result === 'string' ? { token: result, emailSent: false } : result) });
      setCopyFailed(false);
      setEmail('');
    } finally {
      inFlight.current = false;
      setInviting(false);
    }
  };

  const inviteLink = issued !== null ? `${window.location.origin}/invite/${issued.token}` : null;

  const copyLink = async (): Promise<void> => {
    if (inviteLink === null) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(inviteLink);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <VStack gap={3}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <HStack gap={2} vAlign="end" wrap="wrap">
          <StackItem size="fill">
            <TextInput
              label="Invite email"
              isLabelHidden
              hasAutoFocus
              type="email"
              value={email}
              onChange={(value) => setEmail(value)}
              onEnter={submit}
              placeholder="person@example.com"
            />
          </StackItem>
          <Selector
            label="Role"
            isLabelHidden
            options={ROLE_OPTIONS}
            value={role}
            onChange={(value) => setRole(value as InviteRole)}
          />
          <Button label="Invite" type="submit" isDisabled={inviting || email.trim().length === 0} />
          <Button label="Cancel invite" variant="ghost" onClick={onCancel} />
        </HStack>
      </form>

      {issued !== null && inviteLink !== null && (
        <Banner
          status="info"
          container="card"
          title={
            issued.emailSent
              ? `Invitation emailed to ${issued.email}.`
              : `Invite link for ${issued.email} — shown once, save it now. It will not be shown again.`
          }
          description={
            <VStack gap={1}>
              {issued.emailSent && <Text>Or share this link. It is shown once and will not be shown again.</Text>}
              <Text type="code" wordBreak="break-all">
                {inviteLink}
              </Text>
            </VStack>
          }
          endContent={<Button label="Copy link" size="sm" onClick={() => void copyLink()} />}
        />
      )}
      {copyFailed && <Banner status="warning" container="card" title={COPY_FAILED} />}
    </VStack>
  );
}

// "Invite people", opening the invite form on demand. Owner/admin only, as the
// server enforces. The form stays open after an invite so its one-time link
// can be copied. `startOpen` is the header menu's "Invite people".
function InviteControl({
  onInvite,
  startOpen = false,
}: {
  onInvite: (input: InviteInput) => Promise<IssuedInvite | null>;
  startOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(startOpen);
  if (!open) {
    return (
      <HStack>
        <Button label="Invite people" variant="primary" size="sm" icon={<Icon icon={UserPlus} size="sm" />} onClick={() => setOpen(true)} />
      </HStack>
    );
  }
  return <InviteForm onInvite={onInvite} onCancel={() => setOpen(false)} />;
}

const REVOKE_UNDO_MS = 6000;

export function MembersPanel({
  space,
  onSpaceChanged,
  onLeave,
  inviteOpen = false,
}: {
  space: Space;
  onSpaceChanged?: () => void;
  /** Your own row's "Leave space": the page confirms it (the same dialog as the header's). */
  onLeave?: () => void;
  /** Open the invite form on arrival (the header menu's "Invite people"). */
  inviteOpen?: boolean;
}): ReactElement {
  const refreshKey = useRefreshOnFocus();
  const {
    members,
    invitations,
    loading: fetching,
    error,
    invite,
    revokeInvite,
    removeMember,
    transferOwner,
    rolePending,
    changeRole,
  } = useMembers(space.id, refreshKey);
  // Only the first load shows the loading rows: a refetch on focus keeps the
  // list, the scroll position and the invite form (which holds the one-time
  // invite link) mounted.
  const loading = useInitialLoading(fetching);
  const toast = useToast();
  const { session } = useSession();
  const callerUserId = session?.user.id ?? null;
  const privileged = isPrivileged(space.role);
  const [pendingOwner, setPendingOwner] = useState<MemberSummary | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<MemberSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  // Invitations revoked but still undoable: hidden now, deleted when the toast closes.
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());

  const nameOf = (userId: string): string => memberDisplayName(space.members, userId);

  const confirmTransfer = async (): Promise<void> => {
    if (pendingOwner === null || transferring) return;
    setTransferring(true);
    const ok = await transferOwner(pendingOwner.user_id);
    setTransferring(false);
    setPendingOwner(null);
    if (ok) onSpaceChanged?.();
  };

  const confirmRemove = async (): Promise<void> => {
    if (pendingRemove === null || removing) return;
    setRemoving(true);
    const removed = pendingRemove;
    const ok = await removeMember(removed.user_id);
    setRemoving(false);
    setPendingRemove(null);
    if (ok) {
      toast({ body: `Removed ${nameOf(removed.user_id)}` });
      onSpaceChanged?.();
    }
  };

  // Revoke is undoable: the row goes now, the DELETE waits until the toast
  // closes without Undo (no un-revoke on the server, so nothing to roll back).
  const revoke = (invitation: InvitationSummary): void => {
    setRevoking((prev) => new Set(prev).add(invitation.id));
    let undone = false;
    const restore = (): void =>
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(invitation.id);
        return next;
      });
    const dismiss = toast({
      body: `Invitation for ${invitation.invited_email} revoked`,
      uniqueID: `invite-revoked-${invitation.id}`,
      autoHideDuration: REVOKE_UNDO_MS,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="secondary"
          onClick={() => {
            undone = true;
            restore();
            dismiss();
          }}
        />
      ),
      onHide: () => {
        if (undone) return;
        void revokeInvite(invitation.id).finally(restore);
      },
    });
  };

  const visibleInvitations = invitations.filter((invitation) => !revoking.has(invitation.id));

  return (
    // Section, not a bare <section>: it carries the landmark AND takes part in
    // layout, so the scrollable list below it gets a height to scroll inside.
    <Section variant="transparent" padding={SPACE_GUTTER} height="100%" role="region" aria-label="Members">
      <VStack height="100%">
        <StackItem size="fill" isScrollable>
          <VStack gap={4}>
            {privileged && !loading && !space.archived_at && <InviteControl onInvite={invite} startOpen={inviteOpen} />}
            {loading && (
              <VStack gap={3} role="status" aria-label={LOADING}>
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} index={index} height={40} />
                ))}
              </VStack>
            )}
            {!loading && error !== null && <Banner status="error" title={error} container="card" />}
            {!loading && error === null && members.length === 0 && <Text type="supporting">{EMPTY}</Text>}

            {!loading && members.length > 0 && (
              <List aria-label="Members" density="compact" hasDividers>
                {members.map((member) => {
                  const isSelf = callerUserId !== null && member.user_id === callerUserId;
                  return (
                    <MemberRow
                      key={member.user_id}
                      label={nameOf(member.user_id)}
                      role={member.role}
                      isSelf={isSelf}
                      canRemove={isSelf ? space.kind !== 'private' && member.role !== 'owner' && onLeave !== undefined : privileged && member.role !== 'owner'}
                      onRemove={isSelf ? () => onLeave?.() : () => setPendingRemove(member)}
                      canMakeOwner={
                        space.role === 'owner' && space.kind === 'group' && !isSelf && member.role !== 'owner'
                      }
                      onMakeOwner={() => setPendingOwner(member)}
                      canChangeRole={
                        space.role === 'owner' &&
                        space.kind === 'group' &&
                        !space.archived_at &&
                        !isSelf &&
                        (member.role === 'admin' || member.role === 'member')
                      }
                      rolePending={rolePending}
                      onChangeRole={(next) =>
                        void changeRole(member.user_id, next).then((ok) => {
                          if (ok) onSpaceChanged?.();
                        })
                      }
                    />
                  );
                })}
              </List>
            )}

            {privileged && !loading && visibleInvitations.length > 0 && (
              <VStack gap={2}>
                <Heading level={3}>Pending invitations</Heading>
                <List aria-label="Pending invitations" density="compact" hasDividers>
                  {visibleInvitations.map((invitation) => (
                    <InvitationRow key={invitation.id} invitation={invitation} onRevoke={() => revoke(invitation)} />
                  ))}
                </List>
              </VStack>
            )}
          </VStack>
        </StackItem>
      </VStack>

      <AlertDialog
        isOpen={pendingOwner !== null}
        onOpenChange={(open) => {
          if (!open && !transferring) setPendingOwner(null);
        }}
        title={pendingOwner ? `Make ${nameOf(pendingOwner.user_id)} the owner?` : 'Make owner?'}
        description="They can then archive this space and manage its admins. You stay in the space as a member, and only the new owner can give ownership back."
        actionLabel="Make owner"
        isActionLoading={transferring}
        onAction={() => void confirmTransfer()}
      />
      <AlertDialog
        isOpen={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemove(null);
        }}
        title={pendingRemove ? `Remove ${nameOf(pendingRemove.user_id)} from ${space.name}?` : 'Remove member?'}
        description="They lose access to its threads, tasks and notes straight away. You can invite them again later."
        actionLabel="Remove"
        isActionLoading={removing}
        onAction={() => void confirmRemove()}
      />
    </Section>
  );
}
