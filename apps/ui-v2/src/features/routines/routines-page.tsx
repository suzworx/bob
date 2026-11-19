import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { navigateTo, useLocationHash } from '@/app/routes';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { GroupedList } from '@/app/grouped-list';
import { PAGE_WIDTH, PageAction, PageTitle, usePagePadding, PageSubtitle } from '@/app/page-width';
import { Icon } from '@astryxdesign/core/Icon';
import { PlusIcon } from 'lucide-react';
import { listGoogleAccounts, type GoogleAccount } from '@/features/integrations/google-accounts-api';
import { useSession } from '@/lib/auth/use-session';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { RoutineForm } from './routine-form';
import { RoutineRuns } from './routine-runs';
import { RoutineConversation } from './routine-conversation';
import { deleteRoutine, listRoutines, RoutineRequestError, updateRoutine, type Routine } from './routines-api';

export function RoutinesPage(): ReactElement {
  const { session } = useSession();
  return session ? <RoutinesContent key={session.user.id} userId={session.user.id} /> : <Text>Sign in to see your routines.</Text>;
}

function useRoutines(): {
  routines: Routine[] | null; accounts: GoogleAccount[]; error: string | null; busy: boolean;
  load: () => Promise<void>; perform: (action: () => Promise<unknown>) => Promise<boolean>;
} {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (): Promise<void> => {
    const version = ++generation.current;
    try {
      const [items, connected] = await Promise.all([listRoutines(), listGoogleAccounts()]);
      if (alive.current && version === generation.current) { setRoutines(items); setAccounts(connected); setError(null); }
    } catch { if (alive.current && version === generation.current) setError("Couldn't load your routines. Try again in a moment."); }
  }, []);
  const focus = useRefreshOnFocus();
  useEffect(() => { void load(); }, [load, focus]);
  const perform = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setError(null);
    try { await action(); await load(); return true; }
    catch (problem) {
      if (alive.current) setError(problem instanceof RoutineRequestError && problem.status === 409
        ? 'This routine changed elsewhere. Refresh to see the latest version.'
        : "Couldn't change this routine. Check your Google connection and try again.");
      return false;
    } finally { if (alive.current) setBusy(false); }
  };
  return { routines, accounts, error, busy, load, perform };
}


function RoutineHeader({ selected, tab, setTab, onNew, onRefresh, busy, loading }: { selected: Routine | undefined; tab: string; setTab: (value: string) => void; onNew: () => void; onRefresh: () => void; busy: boolean; loading: boolean }): ReactElement {
  const { isMobile } = useAppShellMobile();
  return <LayoutHeader><VStack gap={3}>
        {selected && <HStack><Button label="All routines" variant="ghost" onClick={() => navigateTo('/routines')} /></HStack>}
        <PageTitle>{selected?.name ?? 'Routines'}</PageTitle>
        <PageSubtitle>{selected ? 'One routine, a timeline of recaps. Only you can see these.' : 'Set a rhythm. Bob prepares the recap; every run gets its own place in time.'}</PageSubtitle>
        {!selected && (isMobile
          ? <HStack gap={2} vAlign="center"><PageAction label="New routine" icon={<Icon icon={PlusIcon} size="sm" />} isDisabled={loading || busy} onClick={onNew} />
            <MoreMenu items={[{ label: 'Daily timeline', onClick: () => navigateTo('/timeline') }, { label: 'Refresh', isDisabled: busy, onClick: onRefresh }]} /></HStack>
          : <HStack gap={2} wrap="wrap"><Button label="New routine" variant="primary" isDisabled={loading || busy} onClick={onNew} />
            <Button label="Daily timeline" href="/timeline" variant="ghost" /><Button label="Refresh" variant="ghost" isDisabled={busy} onClick={onRefresh} /></HStack>)}
        {selected && <TabList value={tab} onChange={setTab} hasDivider isFullBleed={!isMobile}>
          <Tab value="overview" label="Overview" /><Tab value="timeline" label="Timeline" /><Tab value="configuration" label="Configuration" />
        </TabList>}
      </VStack></LayoutHeader>;
}

function RoutinesContent({ userId }: { userId: string }): ReactElement {
  const state = useRoutines();
  const padding = usePagePadding();
  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const [removing, setRemoving] = useState<Routine | null>(null);
  const hash = useLocationHash();
  const selected = state.routines?.find((routine) => `#${encodeURIComponent(routine.id)}` === hash);
  const [tab, setTab] = useState('overview');
  const [historyRevision, setHistoryRevision] = useState(0);
  const { isMobile } = useAppShellMobile();
  const [chatOpened, setChatOpened] = useState(false);
  const turnFinished = (): void => { void state.load(); setHistoryRevision((value) => value + 1); };
  const remove = async (): Promise<void> => {
    if (!removing) return;
    const removed = await state.perform(() => deleteRoutine(removing));
    if (removed) { setRemoving(null); navigateTo('/routines'); }
  };
  return <>
    <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
      header={<RoutineHeader selected={selected} tab={tab} setTab={setTab} onNew={() => setEditing('new')} onRefresh={() => void state.load()} busy={state.busy} loading={state.routines === null} />}
      content={<LayoutContent label="Routines"><VStack gap={6}>
        {state.error && <Banner status="error" title={state.error} endContent={<Button label="Retry" onClick={() => void state.load()} />} />}
        {!state.error && state.routines === null && <Text role="status">Opening your routines…</Text>}
        {state.routines?.length === 0 && <EmptyState isCompact={isMobile} title="Give your mornings a little head start" description="Create a recap for the emails that matter to you, on the days you choose." />}
        {!selected && state.routines && <RoutineIndex routines={state.routines} onSelect={(routine) => { setTab('overview'); navigateTo(`/routines#${encodeURIComponent(routine.id)}`); }} />}
        {selected && tab === 'timeline' && <RoutineRuns key={selected.id} routineId={selected.id} refreshRevision={historyRevision} />}
        {selected && tab !== 'timeline' && <RoutineDetails routine={selected} accounts={state.accounts} busy={state.busy} configuration={tab === 'configuration'}
          onEdit={() => setEditing(selected)} onRemove={() => setRemoving(selected)} onRuns={() => setTab('timeline')}
          onToggle={() => void state.perform(() => updateRoutine(selected.id, { expectedRevision: selected.revision, status: selected.status === 'active' ? 'paused' : 'active' }))} />}
        <Collapsible trigger="Ask Bob" defaultIsOpen={false} onOpenChange={() => setChatOpened(true)}>{chatOpened && <RoutineConversation userId={userId} onTurnFinished={turnFinished} />}</Collapsible>
      </VStack></LayoutContent>} />
    {editing !== null && <RoutineForm routine={editing === 'new' ? undefined : editing} accounts={state.accounts}
      onClose={() => { setEditing(null); }} onSaved={() => { setEditing(null); void state.load(); }} />}
    {removing && <AlertDialog isOpen title="Archive this routine?" description="Bob will stop scheduled runs. Your past recaps and run history stay available."
      actionLabel="Archive routine" isActionLoading={state.busy} onOpenChange={(open) => { if (!open && !state.busy) setRemoving(null); }} onAction={() => void remove()} />}
  </>;
}
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function RoutineIndex({ routines, onSelect }: { routines: Routine[]; onSelect: (routine: Routine) => void }): ReactElement | null {
  const [view, setView] = useState('current');
  const { isMobile } = useAppShellMobile();
  if (routines.length === 0) return null;
  const visible = routines.filter((routine) => (routine.status === 'archived') === (view === 'archived'));
  return <VStack gap={4}>
    <TabList value={view} onChange={setView} hasDivider isFullBleed={!isMobile}><Tab value="current" label="Current" /><Tab value="archived" label="Archived" /></TabList>
    {visible.length === 0 ? <Text>{view === 'archived' ? 'No archived routines yet.' : 'No current routines. Your past recaps are in Archived.'}</Text>
      : <GroupedList label={view === 'archived' ? 'Archived routines' : 'Your routines'} count={visible.length}>
        {visible.map((routine) => <ListItem key={routine.id} label={routine.name} description={`${routine.status} · ${scheduleLabel(routine)}`} onClick={() => onSelect(routine)} />)}
      </GroupedList>}
  </VStack>;
}
function scheduleLabel(routine: Routine): string {
  const days = routine.weekdays.length === 7 ? 'Every day' : routine.weekdays.map((day) => SHORT_DAYS[day - 1]).join(', ');
  return `${days} at ${routine.localTime} (${routine.timeZone})`;
}
function accountLabel(account: GoogleAccount | undefined): string {
  if (!account) return 'Disconnected Google account';
  return account.customName ? `${account.customName} · ${account.email}` : account.email;
}
function RoutineDetails({ routine, accounts, busy, configuration, onEdit, onRemove, onToggle, onRuns }: {
  routine: Routine; accounts: GoogleAccount[]; busy: boolean; configuration: boolean;
  onEdit: () => void; onRemove: () => void; onToggle: () => void; onRuns: () => void;
}): ReactElement {
  const account = accounts.find((item) => item.id === routine.googleAccountId);
  const unavailable = !account || account.needsReconnect || !account.access.includes('gmail.read');
  const next = routine.nextRunAt === null ? 'No run scheduled' : `Next: ${new Date(routine.nextRunAt).toLocaleString(undefined, { timeZone: routine.timeZone })} (${routine.timeZone})`;
  return <VStack gap={5}>
    <VStack gap={2}><Heading level={2}>{configuration ? 'Configuration' : 'At a glance'}</Heading>
      <Text>{accountLabel(account)}</Text>
      <Text>{`${routine.status.charAt(0).toUpperCase()}${routine.status.slice(1)} · ${scheduleLabel(routine)}`}</Text><Text type="supporting">{next}</Text></VStack>
    {configuration && <VStack gap={3}><Text>{`Email filter: ${routine.gmailQuery || 'All recent emails'}`}</Text><Text>{`Focus: ${routine.instructions || 'Important updates and next steps'}`}</Text><Text>{`Summary: ${routine.summaryStyle}`}</Text>
      <Button label="Manage integration tools" href={`/tools?integrationId=${encodeURIComponent(routine.googleAccountId)}`} variant="ghost" /></VStack>}
    {unavailable && <Banner status="warning" title="Your Google connection needs attention" description="Reconnect this account with Gmail access so Bob can prepare your summaries." endContent={<Button label="Manage integrations" href="/integrations" />} />}
    <HStack gap={2} wrap="wrap">
      {routine.status !== 'archived' && <Button label={routine.status === 'active' ? 'Pause' : 'Resume'} size="sm" isDisabled={busy || (unavailable && routine.status === 'paused')} onClick={onToggle} />}
      {routine.status !== 'archived' && <Button label="Configure routine" size="sm" variant="ghost" isDisabled={busy} onClick={onEdit} />}
      {!configuration && <Button label="Run history" size="sm" variant="ghost" onClick={onRuns} />}
      {routine.status !== 'archived' && <Button label="Archive" size="sm" variant="ghost" isDisabled={busy} onClick={onRemove} />}
    </HStack>
  </VStack>;
}
