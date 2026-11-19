import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import {
  Blocks,
  Brain,
  CalendarDays,
  ListTodo,
  MessageSquarePlus,
  MessagesSquare,
  MonitorSmartphone,
  Plus,
  Settings,
  StickyNote,
  Sun,
  Users,
} from 'lucide-react';
import { CommandPalette as AstryxCommandPalette, CommandPaletteInput } from '@astryxdesign/core/CommandPalette';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { createStaticSource, type SearchableItem, type SearchSource } from '@astryxdesign/core/Typeahead';
import type { ConversationSummary } from '@/features/chat/use-conversations';
import { useOptionalSpaces } from '@/features/spaces/use-spaces';
import { conversationPath, navigateTo, spacePath } from '../../app/routes';
import { searchResources, type SearchResourceType, type SearchResult } from './search-api';
import { fetchConversations, useConversationList } from './use-conversation-list';

// The sidebar's Search item dispatches this window event to open the palette.
const OPEN_PALETTE_EVENT = 'bob:open-palette';

const CONVERSATION_LIMIT = 20;
const LOAD_WAIT_MS = 1000;
const OPEN_HIGHLIGHT_FRAMES = 30;
const SEARCH_DEBOUNCE_MS = 250;
const MIN_SERVER_QUERY = 2;
const SERVER_RESULT_LIMIT = 20;

type PaletteItem = SearchableItem<{
  group: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  path: string;
  spaceId?: string;
  // The space a found item lives in, shown beside it so same-named items differ.
  spaceName?: string;
}>;

const SEARCH_FAILED = "Search isn't working right now. Try again.";

// Server search results are grouped and ordered by resource type.
const RESULT_GROUPS: Record<SearchResourceType, { group: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
  task: { group: 'Tasks', icon: ListTodo },
  note: { group: 'Notes', icon: StickyNote },
  event: { group: 'Events', icon: CalendarDays },
  thread: { group: 'Threads', icon: MessagesSquare },
};
const GROUP_ORDER: SearchResourceType[] = ['task', 'note', 'event', 'thread'];

// Each destination is one keystroke away; the shell follows the URL.
const GO_TO_ITEMS: PaletteItem[] = [
  { id: 'go:new-chat', label: 'New chat', auxiliaryData: { group: 'Go to', icon: Plus, path: '/' } },
  { id: 'go:today', label: 'Today', auxiliaryData: { group: 'Go to', icon: Sun, path: '/today' } },
  { id: 'go:calendar', label: 'Calendar', auxiliaryData: { group: 'Go to', icon: CalendarDays, path: '/calendar' } },
  { id: 'go:memory', label: 'Memory', auxiliaryData: { group: 'Go to', icon: Brain, path: '/memory' } },
  {
    id: 'go:devices',
    label: 'Devices',
    auxiliaryData: { group: 'Go to', icon: MonitorSmartphone, path: '/devices' },
  },
  { id: 'go:spaces', label: 'All spaces', auxiliaryData: { group: 'Go to', icon: Users, path: '/spaces' } },
  { id: 'go:integrations', label: 'Integrations', auxiliaryData: { group: 'Go to', icon: Blocks, path: '/integrations' } },
  { id: 'go:settings', label: 'Settings', auxiliaryData: { group: 'Go to', icon: Settings, path: '/settings' } },
];

/** Where a found item opens: the item itself, not its space's front page. */
function resultPath(result: SearchResult): string {
  const id = encodeURIComponent(result.resource_id);
  switch (result.resource_type) {
    case 'thread':
      return spacePath(result.space_id, 'threads', result.resource_id);
    case 'task':
      return `${spacePath(result.space_id, 'tasks')}?task=${id}`;
    case 'note':
      return `${spacePath(result.space_id, 'notes')}?note=${id}`;
    case 'event':
      return `${spacePath(result.space_id, 'agenda')}?event=${id}`;
  }
}

function toPaletteItems(results: SearchResult[], spaceNames: ReadonlyMap<string, string>): PaletteItem[] {
  const byType = new Map<SearchResourceType, SearchResult[]>();
  for (const result of results) {
    const list = byType.get(result.resource_type);
    if (list) list.push(result);
    else byType.set(result.resource_type, [result]);
  }
  return GROUP_ORDER.flatMap((type) =>
    (byType.get(type) ?? []).map((result): PaletteItem => {
      const { group, icon } = RESULT_GROUPS[type];
      return {
        id: `s:${type}:${result.resource_id}`,
        label: result.title || 'Untitled',
        auxiliaryData: {
          group,
          icon,
          path: resultPath(result),
          spaceId: result.space_id,
          spaceName: spaceNames.get(result.space_id),
        },
      };
    }),
  );
}

function toConversationItem(conversation: ConversationSummary): PaletteItem {
  return {
    id: `c:${conversation.id}`,
    label: conversation.title,
    auxiliaryData: { group: 'Conversations', icon: MessageSquarePlus, path: conversationPath(conversation.id) },
  };
}

function paletteInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>('dialog[open] [role="combobox"]');
}

function highlightFirst(): void {
  paletteInput()?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', code: 'Home', bubbles: true, cancelable: true }),
  );
}

// The palette registers its items a beat after it mounts (and again once a
// server search resolves), so Home is retried (it is idempotent) until the
// input reports a highlight. Returns a cancel function.
function highlightUntilShown(): () => void {
  let frame = 0;
  let attempts = 0;
  const tick = (): void => {
    if (paletteInput()?.hasAttribute('aria-activedescendant')) return;
    highlightFirst();
    if (++attempts < OPEN_HIGHLIGHT_FRAMES) frame = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(frame);
}

// The Astryx palette calls search() on every keystroke and calls cancel()
// before each search and on close, so the debounce lives here rather than
// inside the palette itself.
function createPaletteSource(
  local: PaletteItem[],
  onServerItems: (items: PaletteItem[]) => void,
  spaceNames: ReadonlyMap<string, string>,
  onSearchFailed: (failed: boolean) => void,
): SearchSource<PaletteItem> {
  const localSource = createStaticSource(local);
  const localIds = new Set(local.map((item) => item.id));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let settle: ((items: PaletteItem[]) => void) | null = null;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    settle?.([]);
    settle = null;
  };
  return {
    bootstrap: () => local,
    cancel,
    async search(query) {
      const localMatches = await localSource.search(query);
      const q = query.trim();
      if (q.length < MIN_SERVER_QUERY) return localMatches;
      const serverItems = await new Promise<PaletteItem[]>((resolve) => {
        settle = resolve;
        timer = setTimeout(() => {
          timer = null;
          const ctl = new AbortController();
          controller = ctl;
          // Either request failing leaves the other's matches (and the local ones)
          // in place; a failure is reported, so it never reads as "no results".
          let failed = false;
          const fail = (): PaletteItem[] => {
            if (!ctl.signal.aborted) failed = true;
            return [];
          };
          void Promise.all([
            // The server's title search, so a conversation older than the local
            // CONVERSATION_LIMIT is still found.
            fetchConversations({ query: q, signal: ctl.signal })
              .then((found) =>
                found
                  .slice(0, SERVER_RESULT_LIMIT)
                  .map(toConversationItem)
                  .filter((item) => !localIds.has(item.id)),
              )
              .catch(fail),
            searchResources(q, { limit: SERVER_RESULT_LIMIT, signal: ctl.signal })
              .then((results) => toPaletteItems(results, spaceNames))
              .catch(fail),
          ]).then(([conversations, resources]) => {
            if (!ctl.signal.aborted) onSearchFailed(failed);
            resolve([...conversations, ...resources]);
          });
        }, SEARCH_DEBOUNCE_MS);
      });
      if (serverItems.length > 0) onServerItems(serverItems);
      return [...localMatches, ...serverItems];
    },
  };
}

// Mounted only while the palette is open, so its own conversation list is
// fetched on each open rather than on every render of the app. The Astryx
// palette reads its source once, so it mounts after the fetch settles; a hung
// request must not leave Ctrl+K dead, so it mounts anyway after LOAD_WAIT_MS.
function PaletteDialog({ onClose }: { onClose: () => void }): ReactElement | null {
  const { conversations, state } = useConversationList();
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), LOAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const settled = state === 'ready' || state === 'empty' || state === 'failed';
  return settled || gaveUp ? <PaletteList conversations={conversations} onClose={onClose} /> : null;
}

function PaletteList({
  conversations,
  onClose,
}: {
  conversations: ConversationSummary[];
  onClose: () => void;
}): ReactElement {
  const spaces = useOptionalSpaces();
  const serverItems = useRef(new Map<string, PaletteItem>());
  const [searchFailed, setSearchFailed] = useState(false);
  const spaceList = spaces?.spaces;
  const spaceNames = useMemo(
    () => new Map((spaceList ?? []).map((space) => [space.id, space.name])),
    [spaceList],
  );
  const items = useMemo<PaletteItem[]>(
    () => [...GO_TO_ITEMS, ...conversations.slice(0, CONVERSATION_LIMIT).map(toConversationItem)],
    [conversations],
  );
  const source = useMemo(
    () =>
      createPaletteSource(
        items,
        (found) => {
          serverItems.current = new Map(found.map((item) => [item.id, item]));
          highlightUntilShown();
        },
        spaceNames,
        setSearchFailed,
      ),
    [items, spaceNames],
  );
  useEffect(() => () => source.cancel?.(), [source]);

  // v1 (cmdk) keeps the first visible match highlighted, so typing then Enter runs
  // it. The Astryx palette has no default-highlight prop: it highlights by index,
  // starts with none, and keeps a stale index when the list shrinks. Its input maps
  // Home to "first item", so a Home keydown on the combobox, on open and after every
  // edit of the query, is the only public way to ask for it. Arrow keys still move it.
  useEffect(() => {
    const stop = highlightUntilShown();
    const searchInput = { type: 'text', label: 'Command palette search', onChange: highlightFirst };
    const onInput = (event: Event): void => {
      if (event.target === paletteInput()) searchInput.onChange();
    };
    document.addEventListener('input', onInput);
    return () => {
      stop();
      document.removeEventListener('input', onInput);
    };
  }, []);

  // Close before navigating so a route change never leaves a stray dialog behind.
  const run = (id: string): void => {
    const item = items.find((candidate) => candidate.id === id) ?? serverItems.current.get(id);
    onClose();
    if (item?.auxiliaryData) {
      if (item.auxiliaryData.spaceId) spaces?.setActiveSpace(item.auxiliaryData.spaceId);
      navigateTo(item.auxiliaryData.path);
    }
  };

  return (
    <AstryxCommandPalette
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      searchSource={source}
      input={<CommandPaletteInput placeholder="Search chats, tasks, notes…" />}
      emptySearchText={searchFailed ? SEARCH_FAILED : 'No results.'}
      emptyBootstrapText="No results."
      onValueChange={run}
      renderItem={(item: PaletteItem) => (
        <HStack gap={2} vAlign="center">
          {item.auxiliaryData && <Icon icon={item.auxiliaryData.icon} size="sm" />}
          <StackItem size="fill">
            <Text type="body" maxLines={1}>
              {item.label}
            </Text>
          </StackItem>
          {item.auxiliaryData?.spaceName && (
            <Text type="supporting" maxLines={1}>
              {item.auxiliaryData.spaceName}
            </Text>
          )}
        </HStack>
      )}
    />
  );
}

/**
 * The Cmd+K / Ctrl+K command palette and the app's one search: Go-to
 * destinations and the latest conversations one keystroke away, and from two
 * typed characters every conversation by title plus space tasks, notes, events
 * and threads from the server. It owns its open state; the key listener toggles
 * it and the sidebar's Search item opens it through a window event.
 */
export function CommandPalette(): ReactElement {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const commands = { onToggle: () => setIsOpen((open) => !open), onOpen: () => setIsOpen(true) };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commands.onToggle();
      }
    };
    const handleOpen = (): void => commands.onOpen();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, handleOpen);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, handleOpen);
    };
  }, []);

  return <>{isOpen && <PaletteDialog onClose={() => setIsOpen(false)} />}</>;
}
