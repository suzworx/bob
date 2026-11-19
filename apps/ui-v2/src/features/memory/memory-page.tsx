import { BRAND } from '@/lib/brand';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import {
  MemoryUnavailableError,
  SecretRefusedError,
  correctMemory,
  createMemory,
  deleteMemory,
  listMemories,
  listMoreMemories,
  type Memory,
  type MemoryKind,
} from './memory-api';
import { isAboutPeople, memoryForReader, memoryForStorage } from './memory-voice';
import { GroupedList } from '../../app/grouped-list';
import { PAGE_WIDTH, PageAction, PageSubtitle, PageTitle, usePagePadding } from '../../app/page-width';
import { conversationPath, navigateTo } from '../../app/routes';
import { useRefreshOnFocus } from '../../lib/use-refresh-on-focus';

type MemoryState = 'loading' | 'ready' | 'failed' | 'unavailable';
type MemoryGroup = 'people' | 'preferences' | 'facts';
type MemoryTab = 'all' | MemoryGroup;

const NAME = BRAND.assistantName;
const LIST_ERROR = "Couldn't load your memories.";
const MORE_ERROR = "Couldn't load more memories.";
const CORRECT_ERROR = "Couldn't save the change. Try again.";
const CREATE_ERROR = "Couldn't add the memory. Try again.";
const SECRET_ERROR = `That looks like a password, PIN or other secret. ${NAME} never stores those.`;
const DELETE_ERROR = "Couldn't delete the memory.";
const TOO_LONG = 'Too long';
const MAX_CONTENT = 2000;
/** Below this the extractor was unsure; the row says so in a word. */
const LOW_CONFIDENCE = 0.6;
const SEARCH_DELAY_MS = 250;

const GROUPS: { value: MemoryGroup; label: string }[] = [
  { value: 'people', label: 'People' },
  { value: 'preferences', label: 'Preferences' },
  { value: 'facts', label: 'Facts' },
];

const ADD_KINDS: { value: MemoryKind; label: string }[] = [
  { value: 'fact', label: 'Fact' },
  { value: 'preference', label: 'Preference' },
];

// Memory is facts and preferences. Intents and to-dos (action items) are not
// listed here: to-dos live on Today.
function isListed(memory: Memory): boolean {
  return memory.kind === 'fact' || memory.kind === 'preference';
}

function groupOf(memory: Memory): MemoryGroup {
  if (memory.kind === 'preference') return 'preferences';
  return isAboutPeople(memory.content) ? 'people' : 'facts';
}

function kindLabel(memory: Memory): string {
  return memory.kind === 'preference' ? 'Preference' : 'Fact';
}

function quoted(memory: Memory): string {
  return `“${memoryForReader(memory.content)}”`;
}

// The message for a failed save: a secret gets its own, anything else the page's.
function failureMessage(caught: unknown, fallback: string): string {
  return caught instanceof SecretRefusedError ? SECRET_ERROR : fallback;
}

function MemoryRowMenu({
  memory,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  onEdit?: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}): ReactElement {
  // The items are built only while the menu is open: a long list mounts one
  // trigger per row and nothing else.
  const [open, setOpen] = useState(false);
  const conversationId = memory.source.conversation_id;
  const items = open
    ? [
        ...(onEdit ? [{ label: 'Edit', icon: <Icon icon={PencilIcon} size="sm" />, onClick: () => onEdit(memory) }] : []),
        ...(conversationId !== null
          ? [{ label: 'View conversation', onClick: () => navigateTo(conversationPath(conversationId)) }]
          : []),
        { type: 'divider' as const },
        {
          label: 'Delete',
          icon: <Icon icon={Trash2Icon} size="sm" />,
          variant: 'destructive' as const,
          onClick: () => onDelete(memory),
        },
      ]
    : [];
  return (
    <MoreMenu
      label={`Actions for ${memoryForReader(memory.content)}`}
      size="sm"
      alignment="end"
      presentation="adaptive"
      isMenuOpen={open}
      onOpenChange={setOpen}
      items={items}
    />
  );
}

function MemoryRow({
  memory,
  onEdit,
  onDelete,
}: {
  memory: Memory;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}): ReactElement {
  return (
    <ListItem
      label={memoryForReader(memory.content)}
      description={
        <>
          {`${kindLabel(memory)} · `}
          <Timestamp value={memory.created_at} format="relative" type="supporting" size="sm" />
        </>
      }
      endContent={
        <HStack gap={2} vAlign="center">
          {memory.confidence < LOW_CONFIDENCE && <Token label="Not sure" size="sm" color="yellow" />}
          {memory.sensitive && <Token label="Sensitive" size="sm" color="gray" />}
          <MemoryRowMenu memory={memory} onEdit={onEdit} onDelete={onDelete} />
        </HStack>
      }
    />
  );
}

function MemoryLists({
  memories,
  tab,
  onEdit,
  onDelete,
}: {
  memories: Memory[];
  tab: MemoryTab;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}): ReactElement {
  const current = memories.filter((memory) => memory.superseded_by === null);
  const older = memories.filter((memory) => memory.superseded_by !== null);
  const groups = GROUPS.filter((group) => tab === 'all' || tab === group.value)
    .map((group) => ({ ...group, rows: current.filter((memory) => groupOf(memory) === group.value) }))
    .filter((group) => group.rows.length > 0);
  const { isMobile } = useAppShellMobile();
  // On a phone the list sits right under the tabs: no extra top padding, a
  // smaller gap between groups.
  return (
    <VStack gap={isMobile ? 2 : 6}>
      <Section variant="transparent" padding={isMobile ? 0 : 6} paddingInline={isMobile ? 0 : 4}>
        {/* Phone: a Section's padding only re-applies what it escapes, so the spacing sits on this
            stack: 16px inline lands GroupedList's card inside the 16px gutter, and the top padding
            clears the tabs' underline so the group label does not sit on it. */}
        <VStack gap={isMobile ? 2 : 6} paddingInline={isMobile ? 4 : undefined} paddingBlockStart={isMobile ? 3 : undefined}>
          {groups.map((group) => (
            <GroupedList key={group.value} label={group.label} count={group.rows.length}>
              {group.rows.map((memory) => (
                <MemoryRow key={memory.id} memory={memory} onEdit={onEdit} onDelete={onDelete} />
              ))}
            </GroupedList>
          ))}
        </VStack>
      </Section>
      {tab === 'all' && older.length > 0 && (
        <Collapsible trigger={`Older versions (${older.length})`} defaultIsOpen={false} value="older-memories">
          <Section variant="transparent" padding={6} paddingInline={4}>
            <List hasDividers density="compact">
              {older.map((memory) => (
                <ListItem
                  key={memory.id}
                  label={memoryForReader(memory.content)}
                  description="Replaced by a newer memory"
                  endContent={<MemoryRowMenu memory={memory} onDelete={onDelete} />}
                />
              ))}
            </List>
          </Section>
        </Collapsible>
      )}
    </VStack>
  );
}

function LoadingRows(): ReactElement {
  return (
    <VStack gap={4} role="status" aria-label="Loading memories">
      {[0, 1, 2, 3].map((index) => (
        <VStack key={index} gap={1}>
          <Skeleton height={16} width="60%" index={index} />
          <Skeleton height={12} width="30%" index={index} />
        </VStack>
      ))}
    </VStack>
  );
}

// One dialog for adding a memory and for editing one: the same field, the
// same rules. Errors sit on the field, not at the bottom of the page.
function MemoryTextDialog({
  title,
  submitLabel,
  initialContent,
  withKind,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initialContent: string;
  withKind: boolean;
  onClose: () => void;
  onSubmit: (content: string, kind: MemoryKind) => Promise<string | null>;
}): ReactElement {
  const [draft, setDraft] = useState(initialContent);
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const content = draft.trim();
  const tooLong = content.length > MAX_CONTENT;

  const submit = async (): Promise<void> => {
    if (!content || tooLong || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSubmit(content, kind);
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  const status = tooLong
    ? { type: 'error' as const, message: TOO_LONG }
    : error !== null
      ? { type: 'error' as const, message: error }
      : undefined;

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={title} onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextArea
                label={`What should ${NAME} remember?`}
                placeholder="e.g. I'm vegetarian"
                value={draft}
                maxLength={MAX_CONTENT}
                hasAutoFocus
                isDisabled={saving}
                status={status}
                statusVariant="detached"
                onChange={(value) => {
                  setDraft(value);
                  setError(null);
                }}
              />
              {withKind && (
                <SegmentedControl
                  label="Kind"
                  value={kind}
                  size="sm"
                  layout="fill"
                  onChange={(value) => {
                    const next = ADD_KINDS.find((option) => option.value === value);
                    if (next) setKind(next.value);
                  }}
                >
                  {ADD_KINDS.map((option) => (
                    <SegmentedControlItem key={option.value} value={option.value} label={option.label} />
                  ))}
                </SegmentedControl>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" isDisabled={saving} onClick={onClose} />
              <Button
                label={submitLabel}
                variant="primary"
                isLoading={saving}
                isDisabled={!content || tooLong}
                onClick={() => void submit()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

// Follows the cursor until the list covers `covered` memories, the count the
// reader had loaded. Pass 0 to take the first page as it is.
async function loadCovering(
  first: Awaited<ReturnType<typeof listMemories>>,
  query: string,
  covered: number,
): Promise<{ loaded: Memory[]; cursor: string | null }> {
  let loaded = first.memories;
  let cursor = first.nextCursor;
  while (cursor !== null && loaded.length < covered) {
    const page = await listMoreMemories(cursor, query);
    loaded = [...loaded, ...page.memories];
    cursor = page.nextCursor;
    if (page.memories.length === 0) break;
  }
  return { loaded, cursor };
}

// The loaded list and its paging, searched on the server. A 503 is "off", not
// a failure.
function useMemoryList(query: string) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [state, setState] = useState<MemoryState>('loading');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const request = useRef(0);

  // How many memories the reader has paged in, so a refetch can cover them.
  const loadedCount = useRef(0);
  useEffect(() => {
    loadedCount.current = memories.length;
  }, [memories]);

  // `quiet` is for the refetch on focus and after a change. It follows the
  // cursor until it has as many memories as the reader had loaded, and a
  // failure keeps the list on screen.
  const load = useCallback(
    async (quiet = false): Promise<void> => {
      const id = ++request.current;
      if (!quiet) setState((prev) => (prev === 'ready' ? prev : 'loading'));
      try {
        const first = await listMemories(query);
        const { loaded, cursor } = await loadCovering(first, query, quiet ? loadedCount.current : 0);
        if (id !== request.current) return;
        setMemories(loaded);
        setNextCursor(cursor);
        setMoreError(false);
        setState('ready');
      } catch (caught) {
        if (id !== request.current) return;
        const failure = caught instanceof MemoryUnavailableError ? 'unavailable' : 'failed';
        setState((prev) => (quiet && failure === 'failed' && prev === 'ready' ? prev : failure));
      }
    },
    [query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await listMoreMemories(nextCursor, query);
      setMemories((prev) => [...prev, ...page.memories]);
      setNextCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return { memories, setMemories, state, nextCursor, loadingMore, moreError, loadMore, reload: load };
}

function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

// The page renders in a fixed-height slot of the shell, so Layout fills it and
// LayoutContent (scrollable by default) scrolls the content itself.
export function MemoryPage(): ReactElement {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), SEARCH_DELAY_MS);
  const list = useMemoryList(query);
  const { memories, setMemories, state, nextCursor, loadingMore, reload } = list;
  const [tab, setTab] = useState<MemoryTab>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [inFlight, setInFlight] = useState(0);

  const listed = memories.filter(isListed);
  const currentCount = listed.filter((memory) => memory.superseded_by === null).length;

  // Refetch when the reader comes back to the tab, unless a change is still in
  // flight: an answer that predates it would undo an optimistic delete. Only a
  // new focus asks for a refetch, so `busy` is deliberately not a dependency.
  const refreshKey = useRefreshOnFocus();
  const busy = inFlight > 0 || loadingMore || editing !== null || adding;
  useEffect(() => {
    if (refreshKey > 0 && !busy) void reload(true);
  }, [reload, refreshKey]);

  const track = async <T,>(work: () => Promise<T>): Promise<T> => {
    setInFlight((count) => count + 1);
    try {
      return await work();
    } finally {
      setInFlight((count) => count - 1);
    }
  };

  const create = (content: string, kind: MemoryKind): Promise<string | null> =>
    track(async () => {
      try {
        await createMemory(content, kind);
        await reload(true);
        return null;
      } catch (caught) {
        return failureMessage(caught, CREATE_ERROR);
      }
    });

  const saveEdit = (memory: Memory, content: string): Promise<string | null> =>
    track(async () => {
      try {
        const updated = await correctMemory(memory.id, memoryForStorage(content));
        setMemories((prev) => prev.map((candidate) => (candidate.id === memory.id ? updated : candidate)));
        return null;
      } catch (caught) {
        return failureMessage(caught, CORRECT_ERROR);
      }
    });

  // Optimistic: the row goes at once and comes back to its place on failure.
  const remove = (memory: Memory): Promise<void> =>
    track(async () => {
      const index = memories.findIndex((candidate) => candidate.id === memory.id);
      setMemories((prev) => prev.filter((candidate) => candidate.id !== memory.id));
      try {
        await deleteMemory(memory.id);
        toast({ body: 'Memory deleted', isAutoHide: true });
      } catch {
        setMemories((prev) => {
          const next = [...prev];
          next.splice(Math.min(Math.max(index, 0), next.length), 0, memory);
          return next;
        });
        toast({ body: DELETE_ERROR, isAutoHide: true });
      }
    });

  const padding = usePagePadding();
  const { isMobile } = useAppShellMobile();
  const addButton = (
    <PageAction label="Add memory" icon={<Icon icon={PlusIcon} size="sm" />} size="sm" onClick={() => setAdding(true)} />
  );
  const searching = query !== '';

  return (
    <>
      <Layout
        height="fill"
        padding={padding}
        contentWidth={PAGE_WIDTH}
        header={
          <LayoutHeader>
            <HStack gap={2} vAlign="start">
              <StackItem size="fill">
                <VStack gap={1}>
                  <PageTitle>Memory</PageTitle>
                  <PageSubtitle>{`What ${NAME} knows about you. Only you can see this.`}</PageSubtitle>
                </VStack>
              </StackItem>
              {state !== 'unavailable' && addButton}
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent>
            <VStack gap={isMobile ? 2 : 4}>
              {state === 'unavailable' && (
                <EmptyState
                  title="Memory is off"
                  description={`${NAME} can't remember things on your account right now.`}
                  headingLevel={2}
                />
              )}
              {state === 'failed' && (
                <Banner
                  status="error"
                  title={LIST_ERROR}
                  container="card"
                  endContent={<Button label="Retry" size="sm" onClick={() => void reload()} />}
                />
              )}
              {state === 'loading' && <LoadingRows />}
              {state === 'ready' && currentCount === 0 && !searching && (
                <EmptyState
                  title="Nothing remembered yet"
                  description={`Tell ${NAME} something about you, or add it here.`}
                  headingLevel={2}
                  actions={addButton}
                />
              )}
              {state === 'ready' && (currentCount > 0 || searching) && (
                <VStack gap={isMobile ? 2 : 4}>
                  <TextInput
                    label="Search memories"
                    isLabelHidden
                    placeholder="Search memories"
                    startIcon={SearchIcon}
                    hasClear
                    value={search}
                    onChange={(value) => setSearch(value)}
                  />
                  <TabList value={tab} onChange={(value) => setTab(value as MemoryTab)} hasDivider isFullBleed={!isMobile}>
                    <Tab value="all" label="All" />
                    {GROUPS.map((group) => (
                      <Tab key={group.value} value={group.value} label={group.label} />
                    ))}
                  </TabList>
                  {currentCount === 0 ? (
                    <EmptyState
                      title={`No memories match “${query}”`}
                      headingLevel={2}
                      isCompact
                      actions={<Button label="Clear search" size="sm" onClick={() => setSearch('')} />}
                    />
                  ) : (
                    <MemoryLists memories={listed} tab={tab} onEdit={setEditing} onDelete={setPendingDelete} />
                  )}
                  {nextCursor !== null && (
                    <VStack gap={2}>
                      <HStack>
                        <Button label="Show more" variant="secondary" isLoading={loadingMore} onClick={() => void list.loadMore()} />
                      </HStack>
                      {list.moreError && <Text type="supporting">{MORE_ERROR}</Text>}
                    </VStack>
                  )}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
      />
      {adding && (
        <MemoryTextDialog
          title="Add a memory"
          submitLabel="Remember"
          initialContent=""
          withKind
          onClose={() => setAdding(false)}
          onSubmit={create}
        />
      )}
      {editing !== null && (
        <MemoryTextDialog
          key={editing.id}
          title="Edit memory"
          submitLabel="Save"
          initialContent={memoryForReader(editing.content)}
          withKind={false}
          onClose={() => setEditing(null)}
          onSubmit={(content) => saveEdit(editing, content)}
        />
      )}
      <AlertDialog
        isOpen={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={pendingDelete !== null ? `Delete ${quoted(pendingDelete)}?` : 'Delete memory?'}
        description={`${NAME} will forget this. This can't be undone.`}
        actionLabel="Delete"
        onAction={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target !== null) void remove(target);
        }}
      />
    </>
  );
}
