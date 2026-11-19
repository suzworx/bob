import { useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { navigateTo } from '@/app/routes';
import { googleInclusiveEnd, type GoogleAgendaItem, type GoogleAgendaState } from './google-agenda';

function EventTime({ item }: { item: GoogleAgendaItem }): ReactElement {
  if ('date' in item.start && 'date' in item.end) return <Text type="supporting">All day · {item.start.date} – {googleInclusiveEnd(item.end.date)}</Text>;
  if ('dateTime' in item.start && 'dateTime' in item.end) return <Text type="supporting"><Timestamp value={item.start.dateTime} format="date_time" isTimezoneShown /> – <Timestamp value={item.end.dateTime} format="date_time" isTimezoneShown />{item.start.timeZone ? ` · Event time zone: ${item.start.timeZone}` : ''}</Text>;
  return <Text type="supporting">Time unavailable</Text>;
}

export function GoogleAgendaRow({ item }: { item: GoogleAgendaItem }): ReactElement {
  const [open, setOpen] = useState(false);
  return <><ListItem label={item.title} description={<Text type="supporting">{'date' in item.start ? 'All day' : <Timestamp value={item.start.dateTime} format="time" />} · Google · Read-only</Text>}
    endContent={<Button label={`Details ${item.title}`} variant="ghost" size="sm" onClick={() => setOpen(true)} />} />
    {open && <Dialog isOpen purpose="info" onOpenChange={setOpen}><Layout header={<DialogHeader title={item.title} subtitle="Google Calendar · Read-only" onOpenChange={setOpen} />}
      content={<LayoutContent><VStack gap={4}><EventTime item={item} />{item.location && <Text>{item.location}</Text>}<Text type="supporting">Last checked: <Timestamp value={item.fetched_at} format="date_time" /></Text><Text type="supporting">Make changes in Google Calendar.</Text></VStack></LayoutContent>} /></Dialog>}
  </>;
}

/** The Integrations page, where a Google account is reconnected. */
export const GOOGLE_ACCOUNTS_PATH = '/integrations';

export function GoogleAgendaStatus({ state }: { state: GoogleAgendaState }): ReactElement | null {
  const incomplete = state.remote_unavailable || state.sources.some((item) => item.state !== 'fresh');
  if (!incomplete) return null;
  const latest = Math.max(0, ...state.sources.map((item) => item.last_success_at ?? 0));
  const permission = state.sources.some((item) => item.state === 'reconnect_required' || item.state === 'permission_required');
  return <Banner status="warning" title="Some Google events could not be shown."
    endContent={permission ? <Button label="Fix in Integrations" size="sm" variant="secondary" onClick={() => navigateTo(GOOGLE_ACCOUNTS_PATH)} /> : undefined}
    description={<VStack gap={1}><Text type="supporting">{permission ? 'Reconnect your Google account and allow calendar access.' : 'Google results may be incomplete. Try refreshing later.'} Your other events are still shown.</Text>{latest > 0 && <Text type="supporting">Most recent successful Google check: <Timestamp value={latest} format="date_time" /></Text>}</VStack>} />;
}
