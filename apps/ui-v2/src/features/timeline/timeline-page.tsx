import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { DateInput } from '@astryxdesign/core/DateInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { PAGE_WIDTH, PageTitle, usePagePadding, PageSubtitle } from '@/app/page-width';
import { conversationPath, spacePath } from '@/app/routes';
import { useSession } from '@/lib/auth/use-session';
import { RoutineConversation } from '@/features/routines/routine-conversation';
import { getRoutineRun, type RoutineRun } from '@/features/routines/routines-api';
import { RoutineRunDetails } from '@/features/routines/routine-runs';
import { listTimeline, type TimelineFilter, type TimelineResponse, type TimelineEntry } from './timeline-api';

function today(): string { return new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
function shiftDay(day: string, offset: number): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0,10); }
const FILTERS: { value: TimelineFilter; label: string }[] = [{value:'all',label:'Everything'},{value:'routine',label:'Routine runs'},{value:'conversation',label:'Conversations'},{value:'task',label:'Tasks'},{value:'note',label:'Notes'},{value:'event',label:'Events'}];
const EXPLAINER = 'This is a view of your activity, not a complete change log. Notes show their latest update; conversations are grouped by day.';
function useTimeline(day: string, timeZone: string, kind: TimelineFilter, revision: number) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setData(null); setError(false); setMoreBusy(false);
    void listTimeline(day,timeZone,kind).then((result) => { if (generation.current === current) setData(result); }).catch(() => { if (generation.current === current) setError(true); });
    return () => { generation.current++; };
  },[day,timeZone,kind,revision]);
  const more = async (): Promise<void> => {
    if (!data?.nextCursor || moreBusy) return;
    const current = generation.current; setMoreBusy(true); setError(false);
    try { const result = await listTimeline(day,timeZone,kind,data.nextCursor); if (current === generation.current) setData({...result,entries:[...data.entries,...result.entries]}); }
    catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setMoreBusy(false); }
  };
  return {data,error,moreBusy,more};
}
function entryHref(entry: TimelineEntry): string {
  if (entry.kind === 'conversation') return entry.spaceId ? spacePath(entry.spaceId,'threads',entry.recordId) : conversationPath(entry.recordId);
  const path = entry.kind === 'task' ? 'tasks' : entry.kind === 'event' ? 'agenda' : 'notes';
  return entry.spaceId ? `${spacePath(entry.spaceId, path)}#${encodeURIComponent(entry.recordId)}` : `/${path}#${encodeURIComponent(entry.recordId)}`;
}
function TimelineRow({ entry, onRun }: { entry: TimelineEntry; onRun: (entry: TimelineEntry) => void }): ReactElement {
  const time = new Date(entry.at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  const description = `${time} · ${entry.kind} · ${entry.status ?? entry.action}${entry.count > 1 ? ` · ${entry.count} items` : ''}`;
  return <ListItem label={entry.title} description={description} {...(entry.kind === 'routine' ? {onClick: () => onRun(entry)} : {href:entryHref(entry)})} />;
}
export function TimelinePage(): ReactElement {
  const { session } = useSession();
  return session ? <TimelineContent key={session.user.id} userId={session.user.id} /> : <Text>Sign in to see your timeline.</Text>;
}
/** Renders its children on desktop only; the phone moves them into the options menu. */
function WideOnly({ isMobile, children }: { isMobile: boolean; children: ReactNode }): ReactNode {
  return isMobile ? null : children;
}
function TimelineContent({ userId }: { userId: string }): ReactElement {
  const [day,setDay] = useState(today);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [kind,setKind] = useState<TimelineFilter>('all');
  const [revision,setRevision] = useState(0);
  const [chatDay,setChatDay] = useState<string | null>(null);
  const state = useTimeline(day,timeZone,kind,revision);
  const [run,setRun] = useState<RoutineRun | null>(null);
  const [runLoading,setRunLoading] = useState(false);
  const [runError,setRunError] = useState(false);
  const request = useRef(0);
  useEffect(() => { request.current++; setRun(null); setRunError(false); setRunLoading(false); return () => { request.current++; }; },[day,kind]);
  const openRun = async (entry: TimelineEntry): Promise<void> => {
    if (!entry.routineId) return;
    const current = ++request.current; setRun(null); setRunError(false); setRunLoading(true);
    try { const item = await getRoutineRun(entry.routineId,entry.recordId); if (current === request.current) setRun(item); }
    catch { if (current === request.current) setRunError(true); }
    finally { if (current === request.current) setRunLoading(false); }
  };
  const { isMobile } = useAppShellMobile();
  const padding = usePagePadding();
  // On a phone the picker fills the row and folds the time zone into its helper text.
  const phoneOnly = isMobile ? { isLabelHidden: true, description: timeZone } : {};
  const dayInput = <DateInput label="Day" {...phoneOnly} value={day as ISODateString} onChange={(value) => { if (value) setDay(value); }} />;
  const dayPicker = isMobile ? <StackItem size="fill">{dayInput}</StackItem> : dayInput;
  return <Layout height="fill" padding={padding} contentWidth={PAGE_WIDTH}
    header={<LayoutHeader><VStack gap={isMobile ? 2 : 3}><PageTitle>Timeline</PageTitle><PageSubtitle>A day at a time: your recaps, conversations and things you worked on.</PageSubtitle>
      {isMobile
        ? <HStack gap={2} vAlign="center"><IconButton label="Previous day" icon={<Icon icon="chevronLeft" size="sm" />} variant="ghost" onClick={() => setDay(shiftDay(day,-1))} />
          {dayPicker}
          <IconButton label="Next day" icon={<Icon icon="chevronRight" size="sm" />} variant="ghost" onClick={() => setDay(shiftDay(day,1))} />
          <MoreMenu label="Timeline options" items={[{ label: 'Today', onClick: () => setDay(today()) }, { type: 'divider' },
            { type: 'section', title: 'Show', items: FILTERS.map((filter) => ({ label: filter.label, endContent: kind === filter.value ? <Icon icon="check" size="sm" /> : undefined, onClick: () => setKind(filter.value) })) },
            { type: 'divider' }, { label: 'About this view', description: EXPLAINER, hasCloseOnSelect: false }]} /></HStack>
        : <HStack gap={2} wrap="wrap"><Button label="Previous day" variant="ghost" onClick={() => setDay(shiftDay(day,-1))} />{dayPicker}
          <Button label="Next day" variant="ghost" onClick={() => setDay(shiftDay(day,1))} /><Button label="Today" variant="ghost" onClick={() => setDay(today())} /></HStack>}
      <WideOnly isMobile={isMobile}><Selector label="Show" value={kind} options={FILTERS} onChange={(value) => { const item = FILTERS.find((filter) => filter.value === value); if (item) setKind(item.value); }} /></WideOnly>
      <WideOnly isMobile={isMobile}><Text type="supporting">{timeZone}</Text></WideOnly></VStack></LayoutHeader>}
    content={<LayoutContent><VStack gap={6}>
      <WideOnly isMobile={isMobile}><PageSubtitle>{EXPLAINER}</PageSubtitle></WideOnly>
      {state.error && <Banner status="error" title="Couldn’t load this day" endContent={<Button label="Retry timeline" onClick={() => setRevision((value) => value+1)} />} />}
      {!state.error && !state.data && <Text role="status">Opening your day…</Text>}
      {state.data?.entries.length === 0 && <EmptyState title="A quiet day here" description="Activity will appear as you chat, finish tasks and run routines." />}
      {state.data && state.data.entries.length > 0 && <Section variant="transparent" padding={isMobile ? 2 : 6} paddingInline={4}><List hasDividers header={<HStack paddingInline={2}><Heading level={2}>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{dateStyle:'full'})}</Heading></HStack>}>{state.data.entries.map((entry) => <TimelineRow key={entry.id} entry={entry} onRun={(item) => void openRun(item)} />)}</List></Section>}
      {state.data?.nextCursor && <Button label="Show earlier activity" isLoading={state.moreBusy} onClick={() => void state.more()} />}
      {runLoading && <Text role="status">Opening this recap…</Text>}
      {runError && <Banner status="warning" title="Couldn’t open this run" description="Choose the run again to retry." />}
      {run && <VStack gap={4}><Button label="Close recap" variant="ghost" onClick={() => setRun(null)} /><RoutineRunDetails run={run} /><Button label="Open routine" href={`/routines#${encodeURIComponent(run.routineId)}`} /></VStack>}
      <Collapsible key={day} value={`conversation-${day}`} defaultIsOpen={false} trigger="Talk about this day" onOpenChange={(open) => { if (open) setChatDay(day); }}>{chatDay === day && <RoutineConversation key={`${userId}:${day}`} userId={userId} scope={`timeline:${day}`} title="Your day, with Bob" description="Ask what happened, or reflect on what mattered. Edit the suggestion before sending." placeholder="Ask Bob about this day"
        suggestedPrompt={`Help me look back on ${day} in ${timeZone}. What happened in my timeline, and what needs my attention?`} onTurnFinished={() => setRevision((value) => value+1)} />}</Collapsible>
    </VStack></LayoutContent>} />;
}
