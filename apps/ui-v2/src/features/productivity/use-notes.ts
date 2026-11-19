/**
 * Shared-notes data hook for the notes API (apps/api/src/notes/http.ts). Notes
 * and their trash live in one `all` array; `notes` and `trashed` are pure
 * derivations, kept in sync by a single `upsert`. A stale save (409) never
 * loses the caller's draft -- the hook hands back the server's current row so
 * the UI can decide what to do, it never overwrites the edit on its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '../../lib/auth/use-session';

export type NoteSummary = {
  id: string;
  space_id: string;
  title: string;
  body: string;
  pinned: boolean;
  revision: number;
  created_by: string;
  updated_by: string;
  ai_assisted: boolean;
  trashed_at: number | null;
  created_at: number;
  updated_at: number;
};

export type NoteRevision = {
  id: string;
  note_id: string;
  revision: number;
  title: string;
  body: string;
  editor_user_id: string;
  ai_assisted: boolean;
  created_at: number;
};

type NoteEdit = { title: string; body: string };

type SaveNoteResult =
  | { status: 'saved'; note: NoteSummary }
  | { status: 'conflict'; current: NoteSummary | null; currentRevision: number | null }
  | { status: 'failed' };

export type UseNotesResult = {
  notes: NoteSummary[];
  trashed: NoteSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  createNote: (title: string, body?: string) => Promise<NoteSummary | null>;
  saveNote: (noteId: string, baseRevision: number, edit: NoteEdit) => Promise<SaveNoteResult>;
  setPinned: (note: NoteSummary, pinned: boolean) => Promise<boolean>;
  trashNote: (note: NoteSummary) => Promise<boolean>;
  restoreNote: (note: NoteSummary) => Promise<boolean>;
  searchNotes: (query: string) => Promise<NoteSummary[] | null>;
  listRevisions: (noteId: string) => Promise<NoteRevision[] | null>;
};

export const NOTES_LIST_ERROR = 'Notes could not be loaded.';
export const NOTE_CONFLICT_MESSAGE =
  'Someone saved this note while you were editing. Your text is kept — check the latest version, then save again.';

/** Copies and sorts: pinned first, then by most recently updated. */
export function sortNotes(notes: NoteSummary[]): NoteSummary[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updated_at - a.updated_at;
  });
}

/**
 * `refreshKey` is the caller's wake-up channel, exactly as in useTasks: bump
 * it to refetch the list.
 */
export function useNotes(spaceId: string, refreshKey = 0): UseNotesResult {
  const [all, setAll] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const notes = useMemo(() => sortNotes(all.filter((note) => note.trashed_at === null)), [all]);
  const trashed = useMemo(
    () =>
      all
        .filter((note) => note.trashed_at !== null)
        .sort((a, b) => (b.trashed_at ?? 0) - (a.trashed_at ?? 0)),
    [all],
  );

  const upsert = useCallback((note: NoteSummary): void => {
    setAll((prev) => {
      const index = prev.findIndex((n) => n.id === note.id);
      if (index === -1) return [note, ...prev];
      const next = [...prev];
      next[index] = note;
      return next;
    });
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/spaces/${spaceId}/notes?trashed=true`);
      if (!response.ok) throw new Error('list_failed');
      const body = (await response.json()) as { notes: NoteSummary[] };
      if (request !== requestRef.current) return;
      setAll(body.notes);
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setError(NOTES_LIST_ERROR);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const createNote = useCallback(
    async (title: string, body?: string): Promise<NoteSummary | null> => {
      try {
        const response = await fetchWithAuth(`/api/spaces/${spaceId}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            ...(body !== undefined && body !== '' ? { body } : {}),
          }),
        });
        if (!response.ok) return null;
        const created = (await response.json()) as NoteSummary;
        upsert(created);
        return created;
      } catch {
        return null;
      }
    },
    [spaceId, upsert],
  );

  const saveNote = useCallback(
    async (noteId: string, baseRevision: number, edit: NoteEdit): Promise<SaveNoteResult> => {
      try {
        const response = await fetchWithAuth(`/api/notes/${noteId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: baseRevision, title: edit.title, body: edit.body }),
        });
        if (response.ok) {
          const note = (await response.json()) as NoteSummary;
          upsert(note);
          return { status: 'saved', note };
        }
        if (response.status === 409) {
          const conflictBody = (await response.json().catch(() => null)) as {
            error?: { current_revision?: number | null };
          } | null;
          const bodyRevision = conflictBody?.error?.current_revision;
          const currentRevision = typeof bodyRevision === 'number' ? bodyRevision : null;
          const getResponse = await fetchWithAuth(`/api/notes/${noteId}`);
          if (getResponse.ok) {
            const current = (await getResponse.json()) as NoteSummary;
            upsert(current);
            return { status: 'conflict', current, currentRevision: current.revision };
          }
          return { status: 'conflict', current: null, currentRevision };
        }
        return { status: 'failed' };
      } catch {
        return { status: 'failed' };
      }
    },
    [upsert],
  );

  const setPinned = useCallback(
    async (note: NoteSummary, pinned: boolean): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/notes/${note.id}/pin`, {
          method: pinned ? 'PUT' : 'DELETE',
        });
        if (!response.ok) return false;
        const updated = (await response.json()) as NoteSummary;
        upsert(updated);
        return true;
      } catch {
        return false;
      }
    },
    [upsert],
  );

  const trashNote = useCallback(
    async (note: NoteSummary): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/notes/${note.id}`, { method: 'DELETE' });
        if (response.status !== 204 && !response.ok) return false;
        upsert({ ...note, trashed_at: Date.now() });
        return true;
      } catch {
        return false;
      }
    },
    [upsert],
  );

  const restoreNote = useCallback(
    async (note: NoteSummary): Promise<boolean> => {
      try {
        const response = await fetchWithAuth(`/api/notes/${note.id}/restore`, { method: 'POST' });
        if (!response.ok) return false;
        const updated = (await response.json()) as NoteSummary;
        upsert(updated);
        return true;
      } catch {
        return false;
      }
    },
    [upsert],
  );

  const searchNotes = useCallback(
    async (query: string): Promise<NoteSummary[] | null> => {
      const q = query.trim();
      if (q.length === 0) return [];
      try {
        const response = await fetchWithAuth(
          `/api/spaces/${spaceId}/notes/search?q=${encodeURIComponent(q)}`,
        );
        if (!response.ok) return null;
        const body = (await response.json()) as { notes: NoteSummary[] };
        return body.notes;
      } catch {
        return null;
      }
    },
    [spaceId],
  );

  const listRevisions = useCallback(async (noteId: string): Promise<NoteRevision[] | null> => {
    try {
      const response = await fetchWithAuth(`/api/notes/${noteId}/revisions`);
      if (!response.ok) return null;
      const body = (await response.json()) as { revisions: NoteRevision[] };
      return body.revisions;
    } catch {
      return null;
    }
  }, []);

  return {
    notes,
    trashed,
    loading,
    error,
    reload: load,
    createNote,
    saveNote,
    setPinned,
    trashNote,
    restoreNote,
    searchNotes,
    listRevisions,
  };
}
