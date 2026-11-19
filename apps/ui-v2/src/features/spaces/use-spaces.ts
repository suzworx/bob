import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';
import { uuidOf } from '../../lib/ids';

type SpaceKind = 'private' | 'pair' | 'group';

export type SpaceMember = {
  user_id: string;
  role: string;
  joined_at: number;
  display_name: string | null;
  handle: string;
  email: string | null;
};

export type SpaceSummary = {
  id: string;
  kind: SpaceKind;
  name: string;
  role: string;
  membership_revision: number;
  created_at: number;
  updated_at: number;
  archived_at?: number | null;
  /** GET /api/spaces only: the caller's unread messages across the space's open threads. */
  unread_count?: number;
  /** GET /api/spaces only: the space's open threads. */
  thread_count?: number;
  /** GET /api/spaces only: the newest activity in the space or its threads (epoch ms). */
  last_activity_at?: number;
};

export type Space = SpaceSummary & { members: SpaceMember[] };

/**
 * The one name for a space's kind, used by the header, All spaces and the
 * invite page: Private (just you), Partner (a pair), else Shared.
 */
export function spaceKindLabel(space: { kind: string }): string {
  if (space.kind === 'private') return 'Private';
  if (space.kind === 'pair') return 'Partner';
  return 'Shared';
}

/** "1 person", "3 people". */
export function peopleCount(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

/**
 * The spaces list's unread totals and activity are server data; anything that
 * moves them (a thread read, a new thread message) calls markSpacesStale and
 * the provider refetches the list. A module-level set, not a DOM event.
 */
const staleListeners = new Set<() => void>();
export function markSpacesStale(): void {
  for (const listener of staleListeners) listener();
}

type SpacesState = 'loading' | 'ready' | 'empty' | 'failed';

/** The active space is per person and local (S02): persisted so a reload keeps
 *  the same pick, and cleared when the space is no longer in the fetched list
 *  so a removed member never sits on a stale selection. */
const ACTIVE_KEY = 'bob.family.activeSpaceId';

// Accepts the stored uuid and its prefixed spc_ form alike (IDS); the API takes the uuid.
function readStoredActive(): string | null {
  try {
    const stored = window.localStorage.getItem(ACTIVE_KEY);
    return stored === null ? null : uuidOf('space', stored) ?? stored;
  } catch {
    return null;
  }
}

function storeActive(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_KEY);
    else window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Storage can be unavailable (private mode); the selection stays in memory.
  }
}

export type SpacesValue = {
  spaces: Space[];
  state: SpacesState;
  activeSpace: Space | null;
  activeSpaceId: string | null;
  setActiveSpace: (id: string) => void;
  createSpace: (name: string) => Promise<Space | null>;
  /** PATCH { name }; refetches on success. Resolves false on any failure. */
  renameSpace: (id: string, name: string) => Promise<boolean>;
  /** DELETE (archive, soft); refetches, which also drops an archived active pick. */
  archiveSpace: (id: string) => Promise<boolean>;
  /** GET /api/spaces?archived=true; null on failure. Never called on mount. */
  listArchivedSpaces: () => Promise<SpaceSummary[] | null>;
  /** PATCH { archived: false }; refetches on success. */
  restoreSpace: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
};

/** The one source of truth for the active space. The provider owns the single
 *  `useSpacesState` instance so a picker and every panel that hangs off the
 *  selection observe the same state rather than two independent copies (014,
 *  issue #150). */
const SpacesContext = createContext<SpacesValue | null>(null);

export function SpacesProvider({ children }: { children: ReactNode }): ReactElement {
  const value = useSpacesState();
  return createElement(SpacesContext.Provider, { value }, children);
}

export function useSpaces(): SpacesValue {
  const value = useContext(SpacesContext);
  if (value === null) {
    throw new Error('useSpaces must be used within a SpacesProvider');
  }
  return value;
}

/** useSpaces for a component that may render outside a SpacesProvider (the
 *  command palette, the notifications menu): null instead of a throw. */
export function useOptionalSpaces(): SpacesValue | null {
  return useContext(SpacesContext);
}

function useSpacesState(): SpacesValue {
  const [spaces, setSpaces] = useState<Space[]>([]);
  // The members last loaded per space, keyed by id: a refresh refetches a
  // space's members only when its membership_revision moved, so the unread
  // refresh after every thread message is one request, not one per space.
  const membersCache = useRef(new Map<string, { revision: number; members: SpaceMember[] }>());
  const [state, setState] = useState<SpacesState>('loading');
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => readStoredActive());

  const refresh = useCallback(async (): Promise<void> => {
    setState((prev) => (prev === 'ready' || prev === 'empty' ? prev : 'loading'));
    try {
      const response = await fetchWithAuth('/api/spaces');
      if (!response.ok) throw new Error('spaces_failed');
      const body = (await response.json()) as { spaces: SpaceSummary[] };
      const loaded: Space[] = await Promise.all(
        body.spaces.map(async (summary) => {
          const cached = membersCache.current.get(summary.id);
          if (cached !== undefined && cached.revision === summary.membership_revision) {
            return { ...summary, members: cached.members };
          }
          try {
            const membersResponse = await fetchWithAuth(`/api/spaces/${summary.id}/members`);
            if (!membersResponse.ok) throw new Error('members_failed');
            const membersBody = (await membersResponse.json()) as { members: SpaceMember[] };
            membersCache.current.set(summary.id, { revision: summary.membership_revision, members: membersBody.members });
            return { ...summary, members: membersBody.members };
          } catch {
            return { ...summary, members: [] };
          }
        }),
      );
      setSpaces(loaded);
      setState(loaded.length === 0 ? 'empty' : 'ready');
      setActiveSpaceId((prev) => {
        if (prev !== null && !loaded.some((space) => space.id === prev)) {
          storeActive(null);
          return null;
        }
        return prev;
      });
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Unread totals come from the server's list (see markSpacesStale).
  useEffect(() => {
    const stale = (): void => void refresh();
    staleListeners.add(stale);
    return () => {
      staleListeners.delete(stale);
    };
  }, [refresh]);

  const setActiveSpace = useCallback((id: string): void => {
    storeActive(id);
    setActiveSpaceId(id);
  }, []);

  const createSpace = useCallback(
    async (name: string): Promise<Space | null> => {
      const response = await fetchWithAuth('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) return null;
      const created = (await response.json()) as SpaceSummary;
      await refresh();
      setActiveSpace(created.id);
      return { ...created, members: [] };
    },
    [refresh, setActiveSpace],
  );

  const renameSpace = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/spaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (!response.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const archiveSpace = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/spaces/${id}`, { method: 'DELETE' });
        if (!response.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const listArchivedSpaces = useCallback(async (): Promise<SpaceSummary[] | null> => {
    try {
      const response = await fetchWithAuth('/api/spaces?archived=true');
      if (!response.ok) return null;
      const body = (await response.json()) as { spaces: SpaceSummary[] };
      return Array.isArray(body.spaces) ? body.spaces : null;
    } catch {
      return null;
    }
  }, []);

  const restoreSpace = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/spaces/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: false }),
        });
        if (!response.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  const activeSpace = useMemo(
    () => spaces.find((space) => space.id === activeSpaceId) ?? null,
    [spaces, activeSpaceId],
  );

  return {
    spaces,
    state,
    activeSpace,
    activeSpaceId,
    setActiveSpace,
    createSpace,
    renameSpace,
    archiveSpace,
    listArchivedSpaces,
    restoreSpace,
    refresh,
  };
}