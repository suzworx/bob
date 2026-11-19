import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  CopyIcon,
  HistoryIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { memberDisplayName } from '@/lib/display-name';
import {
  useNotes,
  NOTES_LIST_ERROR,
  NOTE_CONFLICT_MESSAGE,
  type NoteRevision,
  type NoteSummary,
  type UseNotesResult,
} from '@/features/productivity/use-notes';
import { fetchWithAuth } from '@/lib/auth/use-session';
import { useOptionalSpaces, type Space, type SpaceMember } from '@/features/spaces/use-spaces';
import { clearDraft, getDraft, setDraft as storeDraft } from '../chat/drafts';
import { useInitialLoading, useRefreshOnFocus } from '../../lib/use-refresh-on-focus';
import { SPACE_GUTTER } from '../spaces/space-header';
import { RowMenu, rowClick, useScrollOnce } from './task-row-menu';

const NOTE_TITLE_MAX = 200;
const NOTE_BODY_MAX = 20000;
/** Search shows up once the list is long enough to need it. */
const SEARCH_AFTER = 5;
const SEARCH_DELAY_MS = 250;
const SKELETON_ROWS = 3;
const CREATE_ERROR = 'The note could not be created.';
const SAVE_ERROR = 'The note could not be saved.';
const PIN_ERROR = 'The note could not be pinned.';
const TRASH_ERROR = 'The note could not be moved to trash.';
const RESTORE_ERROR = 'The note could not be restored.';
const SEARCH_ERROR = 'Search failed. Try again.';

type NoteDraft = { revision: number; title: string; body: string };

const noteDraftKey = (noteId: string): string => `note:${noteId}`;

// Only a positive integer revision with string title/body counts as a usable
// draft; anything else (or invalid JSON) is discarded so it never blocks a save.
function readNoteDraft(noteId: string): NoteDraft | null {
  const key = noteDraftKey(noteId);
  const raw = getDraft(key);
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NoteDraft>;
    if (
      typeof parsed.revision === 'number' &&
      Number.isInteger(parsed.revision) &&
      parsed.revision > 0 &&
      typeof parsed.title === 'string' &&
      typeof parsed.body === 'string'
    ) {
      return { revision: parsed.revision, title: parsed.title, body: parsed.body };
    }
  } catch {
    // fall through to clear
  }
  clearDraft(key);
  return null;
}

function NoteDescription({ note }: { note: NoteSummary }): ReactElement {
  const collapsed = note.body.replace(/\s+/g, ' ').trim();
  const cut = collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
  return (
    <>
      {note.pinned && 'Pinned · '}
      {collapsed !== '' && `${cut} · `}
      {'Edited '}
      <Timestamp value={note.updated_at} format="date" type="inherit" color="inherit" />
    </>
  );
}

export function NotesPanel({
  space,
  focusNoteId = null,
}: {
  space: Space;
  /** A deep-linked note (?note=): opened, highlighted and scrolled into view once loaded. */
  focusNoteId?: string | null;
}): ReactElement {
  const refreshKey = useRefreshOnFocus();
  const {
    notes,
    trashed,
    loading: fetching,
    error,
    reload,
    createNote,
    saveNote,
    setPinned,
    trashNote,
    restoreNote,
    searchNotes,
    listRevisions,
  } = useNotes(space.id, refreshKey);
  const loading = useInitialLoading(fetching);
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'notes' | 'trash'>('notes');
  const focusRef = useScrollOnce();
  const focusLoaded = focusNoteId !== null && notes.some((n) => n.id === focusNoteId);
  // Open the deep-linked note once it arrives; the user may close it after.
  useEffect(() => {
    if (focusLoaded) setSelectedId(focusNoteId);
  }, [focusLoaded, focusNoteId]);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState<NoteSummary | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  // Enter fires both onEnter and the form's submit, and a state flag would not
  // be visible to the second call yet, so the in-flight guard is a ref.
  const inFlight = useRef(false);
  // A monotonic id, not a boolean, so a response for an older query can never
  // win over one for a query issued after it.
  const searchRequestId = useRef(0);
  const canCopy = space.kind === 'private';

  const selected = notes.find((n) => n.id === selectedId) ?? results?.find((n) => n.id === selectedId) ?? null;
  const listFailed = !loading && error === NOTES_LIST_ERROR;
  const showSearch = notes.length > SEARCH_AFTER || query !== '';

  const runSearch = useCallback(async (q: string): Promise<void> => {
    const id = ++searchRequestId.current;
    const found = await searchNotes(q);
    if (id !== searchRequestId.current) return;
    setSearchFailed(found === null);
    setResults(found);
  }, [searchNotes]);

  // Live search: results follow the query as it is typed, a moment after the
  // last key, and an empty query brings the whole list back.
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      searchRequestId.current += 1;
      setResults(null);
      setSearchFailed(false);
      return undefined;
    }
    const timer = setTimeout(() => void runSearch(q), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const submit = async (): Promise<void> => {
    const title = newTitle.trim();
    if (title === '' || inFlight.current) return;
    inFlight.current = true;
    setAdding(true);
    try {
      const created = await createNote(title);
      if (created !== null) {
        setNewTitle('');
        setSelectedId(created.id);
      } else {
        toast({ body: CREATE_ERROR, type: 'error' });
      }
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  };

  const togglePin = async (note: NoteSummary): Promise<void> => {
    const ok = await setPinned(note, !note.pinned);
    if (!ok) toast({ body: PIN_ERROR, type: 'error' });
  };

  const restore = async (note: NoteSummary): Promise<boolean> => {
    const ok = await restoreNote(note);
    if (!ok) toast({ body: RESTORE_ERROR, type: 'error' });
    return ok;
  };

  // Trash is reversible, so it asks nothing: the toast undoes it. Trashing
  // leaves the draft in place, so Undo and reopening bring unsaved text back.
  const trash = async (note: NoteSummary): Promise<void> => {
    const ok = await trashNote(note);
    if (!ok) {
      toast({ body: TRASH_ERROR, type: 'error' });
      return;
    }
    if (selectedId === note.id) setSelectedId(null);
    let dismiss: () => void = () => undefined;
    dismiss = toast({
      body: `Moved ${note.title} to trash`,
      uniqueID: `note-trashed-${note.id}`,
      isAutoHide: true,
      autoHideDuration: 8000,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="secondary"
          onClick={() => {
            dismiss();
            void restore(note);
          }}
        />
      ),
    });
  };

  const noteItems = (note: NoteSummary): DropdownMenuOption[] => [
    note.pinned
      ? { label: 'Unpin', icon: PinOffIcon, onClick: () => void togglePin(note) }
      : { label: 'Pin', icon: PinIcon, onClick: () => void togglePin(note) },
    ...(canCopy ? [{ label: 'Copy to another space', icon: CopyIcon, onClick: () => setCopying(note) }] : []),
    { type: 'divider' },
    { label: 'Move to trash', icon: Trash2Icon, variant: 'destructive', onClick: () => void trash(note) },
  ];

  const renderNoteItem = (note: NoteSummary): ReactElement => (
    <ListItem
      key={note.id}
      ref={note.id === focusNoteId ? focusRef : undefined}
      label={note.title}
      description={<NoteDescription note={note} />}
      isSelected={note.id === selectedId}
      onClick={rowClick(() => setSelectedId(note.id))}
      endContent={<RowMenu label={`Actions for ${note.title}`} items={() => noteItems(note)} />}
    />
  );

  return (
    // Section, not a bare <section>: it carries the landmark AND takes part in
    // layout, so the scrollable list below it gets a height to scroll inside.
    <Section variant="transparent" padding={SPACE_GUTTER} height="100%" role="region" aria-label="Notes">
      <VStack gap={4} height="100%">
        {view === 'trash' ? (
          <HStack gap={2} vAlign="center">
            <Button
              label="Back to notes"
              variant="ghost"
              size="sm"
              icon={<Icon icon="chevronLeft" size="sm" />}
              onClick={() => setView('notes')}
            />
            <Text type="label">Trash</Text>
          </HStack>
        ) : (
          <>
            {/* The add row comes first and is the empty state too: an empty space shows only this. */}
            <HStack gap={2} vAlign="center">
              <StackItem size="fill">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <TextInput
                    label="New note title"
                    isLabelHidden
                    value={newTitle}
                    onChange={(value) => setNewTitle(value.slice(0, NOTE_TITLE_MAX))}
                    onEnter={submit}
                    placeholder="New note"
                    startIcon={PlusIcon}
                    isDisabled={adding}
                  />
                </form>
              </StackItem>
              <RowMenu
                label="Notes options"
                items={() => [{ label: `Trash (${trashed.length})`, icon: Trash2Icon, onClick: () => setView('trash') }]}
              />
            </HStack>
            {showSearch && (
              <TextInput
                label="Search notes"
                isLabelHidden
                startIcon={SearchIcon}
                hasClear
                value={query}
                placeholder="Search notes"
                onChange={(v) => setQuery(v)}
              />
            )}
            {searchFailed && (
              <Banner
                status="error"
                title={SEARCH_ERROR}
                container="card"
                endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void runSearch(query.trim())} />}
              />
            )}
          </>
        )}

        <StackItem size="fill" isScrollable>
          <VStack gap={4}>
            {view === 'trash' ? (
              trashed.length === 0 ? (
                <EmptyState isCompact title="Trash is empty" description="Notes you move to trash wait here, so you can bring them back." />
              ) : (
                <List aria-label="Trashed notes" density="compact" hasDividers>
                  {trashed.map((note) => (
                    <ListItem
                      key={note.id}
                      label={note.title}
                      description={
                        <>
                          {'Moved to trash '}
                          <Timestamp
                            value={note.trashed_at ?? note.updated_at}
                            format="date_time"
                            type="inherit"
                            color="inherit"
                          />
                        </>
                      }
                      endContent={
                        <RowMenu
                          label={`Actions for ${note.title}`}
                          items={() => [{ label: 'Restore', icon: RotateCcwIcon, onClick: () => void restore(note) }]}
                        />
                      }
                    />
                  ))}
                </List>
              )
            ) : (
              <>
                {results !== null ? (
                  <>
                    <Text type="supporting" role="status">
                      {results.length === 0
                        ? 'No notes match.'
                        : `${results.length} note${results.length === 1 ? '' : 's'} found`}
                    </Text>
                    {results.length > 0 && (
                      <List aria-label="Search results" density="compact" hasDividers>
                        {results.map(renderNoteItem)}
                      </List>
                    )}
                  </>
                ) : (
                  <>
                    {loading && (
                      <VStack gap={3} role="status" aria-label="Loading notes">
                        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                          <Skeleton key={index} height={40} index={index} />
                        ))}
                      </VStack>
                    )}

                    {listFailed && (
                      <Banner
                        status="error"
                        title={NOTES_LIST_ERROR}
                        container="card"
                        endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void reload()} />}
                      />
                    )}

                    {!loading && notes.length > 0 && (
                      <List aria-label="Note list" density="compact" hasDividers>
                        {notes.map(renderNoteItem)}
                      </List>
                    )}
                  </>
                )}

                {selected !== null && (
                  <NoteEditor
                    key={selected.id}
                    note={selected}
                    members={space.members}
                    onSave={saveNote}
                    onPin={() => void togglePin(selected)}
                    onTrash={() => void trash(selected)}
                    onCopy={canCopy ? () => setCopying(selected) : undefined}
                    onClose={() => setSelectedId(null)}
                    onListRevisions={listRevisions}
                  />
                )}
              </>
            )}
          </VStack>
        </StackItem>
      </VStack>
      {copying !== null && (
        <CopyNoteDialog
          note={copying}
          onClose={() => setCopying(null)}
          onCopied={(name) => {
            setCopying(null);
            toast({ body: `Copied to ${name}` });
          }}
        />
      )}
    </Section>
  );
}

const COPY_ERROR = 'The copy could not be made.';

// Issue #142: copying a private note is a deliberate copy, never a share.
// The person picks the space and the fields, sees exactly what will be copied
// (the saved version, no history), and only then confirms. The copy is a new,
// ordinary note: editing it later never touches this one.
function CopyNoteDialog({
  note,
  onClose,
  onCopied,
}: {
  note: NoteSummary;
  onClose: () => void;
  onCopied: (spaceName: string) => void;
}): ReactElement {
  const targets = (useOptionalSpaces()?.spaces ?? []).filter(
    (space) => space.kind !== 'private' && !space.archived_at,
  );
  const [spaceId, setSpaceId] = useState<string>(() => targets[0]?.id ?? '');
  const [withBody, setWithBody] = useState(note.body !== '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((space) => space.id === spaceId) ?? targets[0];

  const copy = async (): Promise<void> => {
    if (target === undefined || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth(`/api/notes/${note.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ space_id: target.id, fields: { title: true, body: withBody } }),
      });
      if (!response.ok) throw new Error('publish_failed');
      onCopied(target.name);
    } catch {
      setError(COPY_ERROR);
      setSaving(false);
    }
  };

  return (
    <Dialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title="Copy to another space" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {targets.length === 0 ? (
                <Text type="supporting">Join or create a shared space first.</Text>
              ) : (
                <>
                  <Text type="supporting">
                    Only what you see below is copied. This note, its history and any later edits stay private.
                  </Text>
                  <Selector
                    label="Space"
                    value={target?.id ?? ''}
                    options={targets.map((space) => ({ value: space.id, label: space.name }))}
                    isDisabled={saving}
                    onChange={(value) => setSpaceId(value)}
                  />
                  <Switch label="Include the body" value={withBody} isDisabled={saving} onChange={(checked) => setWithBody(checked)} />
                  <VStack gap={1} role="group" aria-label="Copy preview">
                    <Text type="label">{note.title}</Text>
                    {withBody && note.body !== '' && <Text type="supporting">{note.body}</Text>}
                  </VStack>
                  {error !== null && <Banner status="error" title={error} container="card" />}
                </>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" isDisabled={saving} onClick={onClose} />
              <Button
                label="Copy"
                variant="primary"
                isLoading={saving}
                isDisabled={saving || target === undefined}
                onClick={() => void copy()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

// Initialised once from `note` and keyed by its id from the parent, so a
// refetch on focus never overwrites text the user is mid-edit on.
function NoteEditor(props: {
  note: NoteSummary;
  members: SpaceMember[];
  onSave: UseNotesResult['saveNote'];
  onPin: () => void;
  onTrash: () => void;
  /** Present only for a private note, which may be copied to a shared space. */
  onCopy?: () => void;
  onClose: () => void;
  onListRevisions: UseNotesResult['listRevisions'];
}): ReactElement {
  const { note, members, onSave, onPin, onTrash, onCopy, onClose, onListRevisions } = props;
  // Read once on mount: a refetch on focus must never clobber text the user
  // typed since, and a stale draft's own revision drives the first save so a
  // conflict surfaces instead of silently overwriting someone else's edit.
  const [initialDraft] = useState(() => readNoteDraft(note.id));
  const [restored, setRestored] = useState(initialDraft !== null);
  const [title, setTitle] = useState(initialDraft?.title ?? note.title);
  const [body, setBody] = useState(initialDraft?.body ?? note.body);
  const [baseRevision, setBaseRevision] = useState(initialDraft?.revision ?? note.revision);
  const [saved, setSaved] = useState({ title: note.title, body: note.body });
  const [conflict, setConflict] = useState<NoteSummary | 'unknown' | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle');
  const [revisions, setRevisions] = useState<NoteRevision[]>([]);
  const [shownRevision, setShownRevision] = useState<number | null>(null);
  const inFlight = useRef(false);

  const dirty = title !== saved.title || body !== saved.body;
  const valid = title.trim().length > 0 && body.length <= NOTE_BODY_MAX;
  const shown = revisions.find((r) => r.revision === shownRevision);

  const loadHistory = async (): Promise<void> => {
    setHistoryState('loading');
    const found = await onListRevisions(note.id);
    if (found === null) {
      setHistoryState('failed');
    } else {
      setRevisions(found);
      setHistoryState('ready');
    }
  };

  const toggleHistory = (): void => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) void loadHistory();
  };

  useEffect(() => {
    const key = noteDraftKey(note.id);
    if (dirty) storeDraft(key, JSON.stringify({ revision: baseRevision, title, body }));
    else clearDraft(key);
  }, [note.id, dirty, baseRevision, title, body]);

  const save = async (): Promise<void> => {
    if (!dirty || !valid || inFlight.current) return;
    inFlight.current = true;
    setStatus('saving');
    try {
      const r = await onSave(note.id, baseRevision, { title: title.trim(), body });
      if (r.status === 'saved') {
        setBaseRevision(r.note.revision);
        setSaved({ title: r.note.title, body: r.note.body });
        setTitle(r.note.title);
        setConflict(null);
        setStatus('saved');
        clearDraft(noteDraftKey(note.id));
        if (historyOpen) void loadHistory();
      } else if (r.status === 'conflict') {
        setConflict(r.current ?? 'unknown');
        setBaseRevision(r.current?.revision ?? r.currentRevision ?? baseRevision);
        if (r.current) setSaved({ title: r.current.title, body: r.current.body });
        setStatus('idle');
        if (historyOpen) void loadHistory();
      } else {
        setStatus('failed');
      }
    } finally {
      inFlight.current = false;
    }
  };

  const discard = (): void => {
    setTitle(note.title);
    setBody(note.body);
    setBaseRevision(note.revision);
    setSaved({ title: note.title, body: note.body });
    setConflict(null);
    clearDraft(noteDraftKey(note.id));
    setRestored(false);
  };

  return (
    // Section, not a bare <section>: the landmark and the layout in one element.
    <Section variant="transparent" padding={SPACE_GUTTER} role="region" aria-label="Note editor">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill">
            <Text type="supporting" size="sm">
              {`Edited by ${memberDisplayName(members, note.updated_by)} · `}
              <Timestamp value={note.updated_at} format="date_time" type="inherit" color="inherit" />
            </Text>
          </StackItem>
          <RowMenu
            label="Note actions"
            items={() => [
              note.pinned
                ? { label: 'Unpin', icon: PinOffIcon, onClick: onPin }
                : { label: 'Pin', icon: PinIcon, onClick: onPin },
              { label: historyOpen ? 'Hide history' : 'Show history', icon: HistoryIcon, onClick: toggleHistory },
              ...(onCopy !== undefined ? [{ label: 'Copy to another space', icon: CopyIcon, onClick: onCopy }] : []),
              { type: 'divider' },
              { label: 'Move to trash', icon: Trash2Icon, variant: 'destructive', onClick: onTrash },
            ]}
          />
          <Button
            label="Close note"
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<Icon icon="close" size="sm" />}
            onClick={onClose}
          />
        </HStack>
        {conflict !== null && (
          <Banner
            status="warning"
            title={NOTE_CONFLICT_MESSAGE}
            container="card"
            description={
              conflict === 'unknown'
                ? undefined
                : `Latest saved: “${conflict.title}”`
            }
          >
            {conflict !== 'unknown' ? (
              <TextArea label="Latest saved text" value={conflict.body} isReadOnly rows={6} />
            ) : undefined}
          </Banner>
        )}
        {status === 'failed' && <Banner status="error" title={SAVE_ERROR} container="card" />}
        {restored && status !== 'saved' && (
          <Text type="supporting" role="status">
            Your unsaved changes were restored.
          </Text>
        )}
        <TextInput label="Note title" value={title} onChange={(value) => setTitle(value.slice(0, NOTE_TITLE_MAX))} />
        <TextArea label="Note body" value={body} onChange={(value) => setBody(value)} rows={8} maxLength={NOTE_BODY_MAX} />
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            label={status === 'saving' ? 'Saving…' : 'Save'}
            variant="primary"
            size="sm"
            icon={<Icon icon={SaveIcon} size="sm" />}
            isDisabled={status === 'saving' || !dirty || !valid}
            onClick={() => void save()}
          />
          {dirty && <Button label="Discard changes" variant="ghost" size="sm" onClick={discard} />}
          {status === 'saved' && !dirty && (
            <Text type="supporting" role="status">
              Saved.
            </Text>
          )}
        </HStack>
        {historyOpen && (
          <VStack gap={2}>
            {historyState === 'loading' && (
              <Text type="supporting" role="status">
                Loading history…
              </Text>
            )}
            {historyState === 'failed' && (
              <Banner status="error" title="History could not be loaded." container="card" />
            )}
            {historyState === 'ready' && (
              <List aria-label="Version history" hasDividers density="compact">
                {revisions.map((r) => (
                  <ListItem
                    key={r.id}
                    label={`Version ${r.revision}`}
                    description={
                      <>
                        {`${memberDisplayName(members, r.editor_user_id)} · `}
                        <Timestamp value={r.created_at} format="date_time" type="inherit" color="inherit" />
                      </>
                    }
                    endContent={r.ai_assisted ? <Token label="AI assisted" color="purple" /> : undefined}
                    isSelected={r.revision === shownRevision}
                    onClick={() => setShownRevision(r.revision)}
                  />
                ))}
              </List>
            )}
            {shown !== undefined && (
              <VStack gap={2}>
                <TextInput label={`Version ${shown.revision} title`} value={shown.title} isReadOnly />
                <TextArea label={`Version ${shown.revision} body`} value={shown.body} isReadOnly rows={6} />
              </VStack>
            )}
          </VStack>
        )}
      </VStack>
    </Section>
  );
}
