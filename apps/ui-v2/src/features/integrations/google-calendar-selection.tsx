import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { CALENDAR_RECONNECT_MESSAGE, listGoogleCalendars, saveGoogleCalendars, type GoogleCalendarPage } from './google-calendar-api';

/** saveGoogleCalendars throws the sentence to show (limit vs. anything else). */
function saveMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Couldn't save your calendars. Try again.";
}

type SelectionProps = { account: { id: string; email: string }; onClose: () => void; onReconnect?: () => void };

export function GoogleCalendarSelection(props: SelectionProps): ReactElement {
  return <CalendarSelectionForm key={props.account.id} {...props} />;
}

function CalendarSelectionForm({ account, onClose, onReconnect }: SelectionProps): ReactElement {
  const [calendars, setCalendars] = useState<GoogleCalendarPage['calendars']>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [next, setNext] = useState<string>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void listGoogleCalendars(account.id, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setCalendars(page.calendars); setSelected(page.selected_calendar_ids); setNext(page.next_page_token); setReady(true);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Google calendars are unavailable.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [account.id]);
  const loadMore = async (): Promise<void> => {
    const controller = lifetime.current;
    if (!controller || !next) return;
    setBusy(true); setError(null);
    try {
      const page = await listGoogleCalendars(account.id, controller.signal, next);
      if (controller.signal.aborted) return;
      setCalendars((previous) => [...new Map([...previous, ...page.calendars].map((item) => [item.id, item])).values()]);
      setNext(page.next_page_token);
    } catch { if (!controller.signal.aborted) setError('More calendars could not be loaded. Your choices are unchanged.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const save = async (): Promise<void> => {
    const controller = lifetime.current;
    if (!controller || !ready) return;
    setBusy(true); setError(null);
    try { await saveGoogleCalendars(account.id, selected, controller.signal); if (!controller.signal.aborted) onClose(); }
    catch (cause: unknown) { if (!controller.signal.aborted) setError(saveMessage(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  // Keep saved selections visible even when they fall outside this provider page.
  const options = [...calendars.map((item) => ({ value: item.id, label: item.title || item.id, disabled: !item.selectable })),
    ...selected.filter((id) => !calendars.some((item) => item.id === id)).map((id) => ({ value: id, label: id, disabled: false }))];
  return <Dialog isOpen purpose="form" onOpenChange={(open) => { if (!open) onClose(); }}>
    <Layout header={<DialogHeader title="Google calendars" subtitle={account.email} onOpenChange={(open) => { if (!open) onClose(); }} />}
      content={<LayoutContent><VStack gap={4}>
        <Text type="supporting">Choose up to five calendars across your Google accounts. Events appear read-only in your agenda.</Text>
        {error && <Banner status="error" title={error}
          endContent={error === CALENDAR_RECONNECT_MESSAGE && onReconnect ? <Button label="Reconnect" size="sm" variant="secondary" onClick={onReconnect} /> : undefined} />}
        <MultiSelector label="Calendars in your agenda" options={options} value={selected} onChange={setSelected} hasSearch isDisabled={!ready || busy} isLoading={busy} />
        <Text type="supporting">{selected.length} {selected.length === 1 ? 'calendar selected' : 'calendars selected'}</Text>
        {next && <Button label="Load more calendars" variant="secondary" isDisabled={busy} onClick={() => void loadMore()} />}
        <Button label="Save calendars" variant="primary" isDisabled={!ready || busy || selected.length > 5} onClick={() => void save()} />
      </VStack></LayoutContent>} />
  </Dialog>;
}
