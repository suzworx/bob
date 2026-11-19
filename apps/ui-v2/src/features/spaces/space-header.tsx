import { useState, type ReactElement, type ReactNode } from 'react';
import { Archive, LogOut, Pencil, UserPlus } from 'lucide-react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Button } from '@astryxdesign/core/Button';
import { AvatarGroup, AvatarGroupOverflow } from '@astryxdesign/core/AvatarGroup';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { LayoutHeader } from '@astryxdesign/core/Layout';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { spaceKindLabel, type Space } from '@/features/spaces/use-spaces';
import { PageTitle } from '../../app/page-width';
import { navigateTo, SPACE_SECTIONS, type SpaceSection } from '../../app/routes';
import { SpaceNameDialog } from './create-space-controls';

/**
 * The Spaces surface's one gutter, as a spacing step: the page's Layout padding
 * AND every tab's root Section padding. A Section nested in a padded container
 * escapes that padding (Astryx `nestedStyles.outer`) and re-applies only its
 * own, so each tab's Section must re-apply this same step for its content to
 * start where the space name starts. `padding={0}` puts it 24px to the left.
 */
export const SPACE_GUTTER = 6;
/** The phone gutter: the main chat's 16px side gutter (spacing 4). */
export const SPACE_PHONE_GUTTER = 4;
const AVATARS_SHOWN = 4;

const SECTION_LABELS: Record<SpaceSection, string> = {
  threads: 'Threads',
  tasks: 'Tasks',
  notes: 'Notes',
  agenda: 'Agenda',
  members: 'Members',
  apps: 'Apps',
};

/**
 * The tabs a space shows. Private is just you: its conversations are your
 * personal chats (the rail's Chats) and it has no one to manage, so it has
 * neither Threads nor Members.
 */
export function spaceSections(space: Pick<Space, 'kind'> & { conversation_id?: string | null }): SpaceSection[] {
  const available = SPACE_SECTIONS.filter((section) => section !== 'apps' || (space.kind === 'group' && !space.conversation_id));
  return space.kind === 'private'
    ? available.filter((section) => section !== 'threads' && section !== 'members')
    : available;
}

/** Who may do what from the header menu; the server enforces the same rules. */
function spaceActions(space: Space): { canRename: boolean; canArchive: boolean; canLeave: boolean; canInvite: boolean } {
  const shared = space.kind !== 'private';
  const privileged = space.role === 'owner' || space.role === 'admin';
  return {
    canRename: shared && privileged,
    canArchive: space.kind === 'group' && space.role === 'owner',
    canLeave: shared && space.role !== 'owner',
    canInvite: shared && privileged && !space.archived_at,
  };
}

export function SpaceHeader({
  space,
  section,
  threadBar,
  onSelectSection,
  onRename,
  onArchive,
  onLeave,
  onInvite,
}: {
  space: Space;
  section: SpaceSection;
  /** The open thread's bar, shown on its own row under the tabs. */
  threadBar?: ReactNode;
  onSelectSection: (section: SpaceSection) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  /** Archive is reversible: no dialog here, the caller archives and offers Undo. */
  onArchive: () => void;
  /** Leave space: the caller confirms it (it is irreversible for you). */
  onLeave?: () => void;
  onInvite?: () => void;
}): ReactElement {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const allowed = spaceActions(space);
  const isPrivate = space.kind === 'private';
  const { isMobile: isPhone } = useAppShellMobile();

  // Built only while the menu is open; grouped by intent, destructive last.
  // On a phone Tools has no button in the row, so the menu holds it first.
  const items = (): DropdownMenuOption[] => {
    const manage: DropdownMenuOption[] = [
      ...(isPhone ? [{ label: 'Tools', onClick: () => navigateTo(`/tools?spaceId=${encodeURIComponent(space.id)}`) }] : []),
      ...(allowed.canInvite && onInvite ? [{ label: 'Invite people', icon: UserPlus, onClick: onInvite }] : []),
      ...(allowed.canRename ? [{ label: 'Rename', icon: Pencil, onClick: () => setRenaming(true) }] : []),
    ];
    const destructive: DropdownMenuOption[] = [
      ...(allowed.canArchive ? [{ label: 'Archive', icon: Archive, variant: 'destructive' as const, onClick: onArchive }] : []),
      ...(allowed.canLeave && onLeave ? [{ label: 'Leave space', icon: LogOut, variant: 'destructive' as const, onClick: onLeave }] : []),
    ];
    return manage.length > 0 && destructive.length > 0 ? [...manage, { type: 'divider' }, ...destructive] : [...manage, ...destructive];
  };
  const hasItems =
    isPhone || (allowed.canInvite && onInvite !== undefined) || allowed.canRename || allowed.canArchive || (allowed.canLeave && onLeave !== undefined);
  const shown = space.members.slice(0, AVATARS_SHOWN);
  const hidden = space.members.length - shown.length;
  // On a phone the open thread's bar is the only header under the top bar: the
  // name, tabs and avatars wait until you leave the thread; the space name stays
  // as the page's h1, visually hidden, for assistive tech.
  const collapsed = isPhone && threadBar !== undefined;
  const renameDialog = renaming ? <SpaceNameDialog mode="rename" space={space} onRename={onRename} onClose={() => setRenaming(false)} /> : null;

  if (collapsed) {
    return (
      <>
        <LayoutHeader hasDivider paddingBlockEnd={0}>
          <PageTitle>{space.name}</PageTitle>
          {threadBar}
        </LayoutHeader>
        {renameDialog}
      </>
    );
  }

  return (
    <>
      <LayoutHeader hasDivider paddingBlockEnd={0}>
        <VStack gap={2}>
          <HStack vAlign="center" gap={2}>
            <StackItem size="fill">
              <HStack vAlign="center" gap={2}>
                <Heading level={1} maxLines={1}>{space.name}</Heading>
                {!isPhone && <Token label={spaceKindLabel(space)} color="default" />}
              </HStack>
            </StackItem>
            {!isPhone && <Button label="Tools" variant="ghost" size="sm" href={`/tools?spaceId=${encodeURIComponent(space.id)}`} />}
            {!isPhone && !isPrivate && space.members.length > 1 && (
              <AvatarGroup size="sm">
                {shown.map((member) => (
                  <Avatar key={member.user_id} name={member.display_name ?? member.handle} />
                ))}
                {hidden > 0 && <AvatarGroupOverflow count={hidden} onClick={() => onSelectSection('members')} />}
              </AvatarGroup>
            )}
            {hasItems && (
              <MoreMenu
                label="Space actions"
                alignment="end"
                presentation="adaptive"
                isMenuOpen={menuOpen}
                onOpenChange={setMenuOpen}
                items={menuOpen ? items() : []}
              />
            )}
          </HStack>
          <TabList
            isFullBleed
            hasDivider={false}
            value={section}
            onChange={(value) => onSelectSection(value as SpaceSection)}
          >
            {spaceSections(space).map((value) => (
              <Tab key={value} value={value} label={SECTION_LABELS[value]} />
            ))}
          </TabList>
          {threadBar}
        </VStack>
      </LayoutHeader>
      {renameDialog}
    </>
  );
}
