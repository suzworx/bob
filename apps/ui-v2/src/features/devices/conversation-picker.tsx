import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Hash, MessageSquare, Plus, Search } from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { useConversationList } from '@/features/chat/use-conversation-list';
import { useOptionalSpaces, type Space } from '@/features/spaces/use-spaces';
import { useThreads, type Thread } from '@/features/spaces/use-threads';
import type { ActiveSpace, Device } from './devices-api';
import { useDevices } from './use-devices';
import { deviceStatusText, threadRef, type DeviceConversation, type DeviceTarget } from './use-device-conversation';

// "Change conversation" (#668): the one picker behind the device page and the
// chat and thread header control. The current conversation comes first, then
// recent chats (General conversations and space threads merged by when they
// last changed), then "New conversation"; search reaches everything. A General
// pick keeps the device's default space; a thread pick moves it to the
// thread's own space, since the API requires space_id to be the thread's.
// "New conversation" clears the pointer, so the device's next turn creates it
// in the default space (docs/design/device-conversation.md); "New in a space"
// creates a thread with POST /api/spaces/:id/threads and points at it.

const RECENT_LIMIT = 8;
// The API needs a title; the thread is renamed once it has turns.
export const NEW_THREAD_TITLE = 'Device conversation';

type Row = { key: string; ref: string; title: string; where: string; updatedAt: number; target: DeviceTarget };

function matches(title: string, query: string): boolean {
  return title.toLowerCase().includes(query.trim().toLowerCase());
}

type Creator = (title: string) => Promise<Thread | null>;

/** Whether two reads of a space's threads show the same rows (ids, titles, times). */
function sameThreads(a: Thread[] | undefined, b: Thread[]): boolean {
  if (a === b) return true;
  if (a === undefined || a.length !== b.length) return false;
  return a.every((t, i) => t.id === b[i].id && t.title === b[i].title && t.updated_at === b[i].updated_at && t.archived_at === b[i].archived_at);
}

/** Reads one space's threads (the same query the spaces nav uses) and hands
 *  them, and that space's create, up, so the picker merges every space into
 *  one list. Renders nothing. */
function SpaceThreads({ space, onThreads }: {
  space: Space; onThreads: (spaceId: string, threads: Thread[], create: Creator) => void;
}): null {
  const { threads, createThread } = useThreads(space.id);
  useEffect(() => onThreads(space.id, threads, createThread), [onThreads, space.id, threads, createThread]);
  return null;
}

/** "New in a space": one menu of spaces; hidden when there are none. */
function NewInSpace({ spaces, isDisabled, onCreate }: { spaces: Space[]; isDisabled: boolean; onCreate: (space: Space) => void }): ReactElement | null {
  if (spaces.length === 0) return null;
  return (
    <DropdownMenu
      button={{ label: 'New in a space', variant: 'secondary', icon: <Icon icon={Hash} size="sm" />, isDisabled }}
      presentation="adaptive"
      alignment="end"
      items={spaces.map((space) => ({ id: space.id, label: space.name, icon: Hash, onClick: () => onCreate(space) }))}
    />
  );
}

type PickerProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  // The surface's one useDeviceConversation().
  device: DeviceConversation;
  statusKey: string;
  // #900: every paired device, and the one this picker is scoped to.
  devices?: Device[];
  deviceId?: string;
  // The chat header offers the choice of device (2+ devices); the device page
  // is already scoped to one and does not.
  canChooseDevice?: boolean;
  // Where a new conversation on the scoped device starts, when the caller
  // knows it exactly (the device page); otherwise read from the device list.
  defaultSpace?: ActiveSpace | null;
};

/** The space a General pick, or a new conversation, starts in on this device:
 *  its own, else the account's. */
function defaultSpaceOf(
  chosen: Device | undefined, account: ActiveSpace | null, spaces: Space[],
): ActiveSpace | null {
  const ownId = chosen?.active_space_id ?? null;
  if (ownId === null) return account;
  const found = spaces.find((space) => space.id === ownId);
  return found ? { id: found.id, name: found.name } : account;
}

/** General conversations and every space's open threads, newest first. */
function mergeRows(
  conversations: Array<{ id: string; title: string; updatedAt: number }>, spaces: Space[], threadsBySpace: Record<string, Thread[]>,
): Row[] {
  const general: Row[] = conversations.map((c) => ({
    key: c.id, ref: c.id, title: c.title, where: 'General', updatedAt: c.updatedAt,
    target: { conversationId: c.id, spaceId: null },
  }));
  const threads: Row[] = spaces.flatMap((space) =>
    (threadsBySpace[space.id] ?? [])
      .filter((t) => t.archived_at === null)
      .map((t) => ({
        key: t.id, ref: threadRef(t.id), title: t.title, where: space.name, updatedAt: t.updated_at,
        target: { conversationId: null, spaceId: space.id, threadId: t.id },
      })),
  );
  return [...general, ...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The current row and the others to show: recent (top 8), or every match while searching. */
function visibleRows(rows: Row[], activeId: string | null, query: string) {
  const current = rows.find((row) => row.ref === activeId);
  const searching = query.trim() !== '';
  const fits = (row: Row): boolean => !searching || matches(row.title, query);
  const others = rows.filter((row) => row.ref !== activeId && fits(row));
  const shown = searching ? others : others.slice(0, RECENT_LIMIT);
  return { current, shown, searching, currentShown: current !== undefined && fits(current) };
}

type PickerRowsProps = {
  visible: ReturnType<typeof visibleRows>;
  device: DeviceConversation;
  query: string;
  busy: boolean;
  startsInName: string;
  onPick: (target: DeviceTarget) => void;
};

/** Current first, then recent (or matches), then "Start new". */
function PickerRows({ visible, device, query, busy, startsInName, onPick }: PickerRowsProps): ReactElement {
  const { current, shown, searching, currentShown } = visible;
  const row = (r: Row, isCurrent: boolean): ReactElement => (
    <ListItem
      key={r.key}
      label={r.title}
      description={isCurrent ? `${r.where} · Current` : r.where}
      startContent={<Icon icon={r.target.threadId === undefined ? MessageSquare : Hash} size="sm" />}
      endContent={isCurrent ? <Icon icon="check" size="sm" /> : undefined}
      isSelected={isCurrent}
      isDisabled={busy}
      onClick={() => onPick(r.target)}
    />
  );
  // The current conversation is not in the lists yet (still loading): show its title.
  const unlistedTitle = !currentShown && !searching && device.activeId !== null ? device.activeTitle : null;
  return (
    <>
      {currentShown && current && <List header={<Text type="label">Current</Text>} density="compact">{row(current, true)}</List>}
      {unlistedTitle && (
        <List header={<Text type="label">Current</Text>} density="compact">
          <ListItem label={unlistedTitle} description="Current" endContent={<Icon icon="check" size="sm" />} isSelected />
        </List>
      )}
      {shown.length > 0 && (
        <List header={<Text type="label">{searching ? 'Matches' : 'Recent'}</Text>} density="compact">
          {shown.map((r) => row(r, false))}
        </List>
      )}
      {searching && shown.length === 0 && !currentShown && (
        <EmptyState title={`No chats match "${query.trim()}"`} icon={<Icon icon="search" size="md" />} isCompact headingLevel={3} />
      )}
      {!searching && (
        <List header={<Text type="label">Start new</Text>} density="compact">
          <ListItem
            label="New conversation"
            description={`Starts in ${startsInName}`}
            startContent={<Icon icon={Plus} size="sm" />}
            isDisabled={busy}
            onClick={() => onPick({ conversationId: null, spaceId: null })}
          />
        </List>
      )}
    </>
  );
}

export function ConversationPicker({
  isOpen, onOpenChange, device, statusKey, devices = [], deviceId, canChooseDevice = false, defaultSpace,
}: PickerProps): ReactElement {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [chosenId, setChosenId] = useState<string | undefined>(deviceId);
  const [threadsBySpace, setThreadsBySpace] = useState<Record<string, Thread[]>>({});
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const spaces = useOptionalSpaces()?.spaces ?? [];
  const { conversations } = useConversationList();
  const store = useDevices();
  const creators = useRef<Record<string, Creator>>({});

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setQuery('');
    setChosenId(deviceId);
  }, [isOpen, deviceId]);

  const known = store.devices.length > 0 ? store.devices : devices;
  const chosen = known.find((candidate) => candidate.id === chosenId);
  const chosenName = chosen?.name ?? device.deviceName ?? null;
  const fixedSpace = chosenId === deviceId ? defaultSpace : undefined;
  const startsIn = fixedSpace !== undefined ? fixedSpace : defaultSpaceOf(chosen, store.activeSpace, spaces);
  const startsInName = startsIn?.name ?? 'General';
  const showDeviceChoice = canChooseDevice && devices.length > 1;
  const busy = device.isSending === true || creating;

  const onThreads = useMemo(
    () => (spaceId: string, threads: Thread[], create: Creator) => {
      creators.current[spaceId] = create;
      setThreadsBySpace((prev) => (sameThreads(prev[spaceId], threads) ? prev : { ...prev, [spaceId]: threads }));
    },
    [],
  );

  const rows: Row[] = useMemo(() => mergeRows(conversations, spaces, threadsBySpace), [conversations, spaces, threadsBySpace]);
  const { current, shown, searching, currentShown } = visibleRows(rows, device.activeId, query);

  const pick = async (target: DeviceTarget): Promise<void> => {
    if (busy) return;
    setError(null);
    const spaceId = target.threadId === undefined ? (startsIn ? startsIn.id : null) : target.spaceId;
    const result = await device.send({ ...target, spaceId }, statusKey, chosenId);
    // A second pick while one is in flight is ignored, never a failure.
    if (result === 'busy') return;
    if (result === 'sent' || result === 'pending') {
      toast({ body: deviceStatusText(result, chosenName), uniqueID: `device-pick-${statusKey}`, isAutoHide: true });
      onOpenChange(false);
      return;
    }
    setError(deviceStatusText(result, chosenName));
  };

  const createIn = async (space: Space): Promise<void> => {
    if (busy) return;
    setCreating(true);
    const create = creators.current[space.id];
    const thread = create === undefined ? null : await create(NEW_THREAD_TITLE).catch(() => null);
    setCreating(false);
    if (thread === null) {
      toast({ body: `Couldn't start a chat in ${space.name}.`, type: 'error', isAutoHide: true });
      return;
    }
    await pick({ conversationId: null, spaceId: space.id, threadId: thread.id });
  };

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={520}>
      <Layout
        header={
          <DialogHeader
            title="Change conversation"
            subtitle={chosenName === null ? undefined : `for ${chosenName}`}
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            {isOpen && (
              <VStack gap={3}>
                {spaces.map((space) => (
                  <SpaceThreads key={space.id} space={space} onThreads={onThreads} />
                ))}
                {showDeviceChoice && (
                  <Selector
                    label="Device"
                    options={devices.map((d) => ({ value: d.id, label: d.name }))}
                    value={chosenId ?? devices[0].id}
                    onChange={setChosenId}
                  />
                )}
                <TextInput
                  label="Search conversations"
                  isLabelHidden
                  placeholder="Search"
                  startIcon={Search}
                  autoComplete="off"
                  hasAutoFocus
                  value={query}
                  onChange={setQuery}
                />
                {error && (
                  <Banner
                    status="error"
                    title={error}
                    endContent={<Button label="Dismiss" size="sm" variant="ghost" onClick={() => setError(null)} />}
                  />
                )}
                <PickerRows
                  visible={{ current, shown, searching, currentShown }}
                  device={device}
                  query={query}
                  busy={busy}
                  startsInName={startsInName}
                  onPick={(target) => void pick(target)}
                />
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end" wrap="wrap">
              <NewInSpace spaces={spaces} isDisabled={busy} onCreate={(space) => void createIn(space)} />
              <Button label="Done" variant="ghost" onClick={() => onOpenChange(false)} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
