import { useEffect, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import { listRoutineRuns, type RoutineRun } from './routines-api';
import { SavedSummary } from './saved-summary';

const STATUS = { pending: 'Waiting', running: 'Preparing your summary', completed: 'Ready', failed: "Couldn’t finish", skipped: 'Skipped' };
export function RoutineRunDetails({ run }: { run: RoutineRun }): ReactElement {
  return <VStack gap={4}>
    <Text>{`${STATUS[run.status]} · Scheduled ${new Date(run.scheduledAt).toLocaleString()}`}</Text>
    {run.startedAt !== null && <Text type="supporting">{`Started ${new Date(run.startedAt).toLocaleTimeString()}`}</Text>}
    {run.completedAt !== null && <Text type="supporting">{`Finished ${new Date(run.completedAt).toLocaleTimeString()}`}</Text>}
    {run.status === 'failed' && <Banner status="warning" title="Bob couldn’t prepare this recap" description="Check your integration and tool settings before the next scheduled run." />}
    {run.status === 'skipped' && <Text>No summary was prepared for this scheduled time.</Text>}
    {run.emailOutcome === 'queued' && <Text type="supporting">Email notification queued</Text>}
    {run.emailOutcome === 'muted' && <Text type="supporting">Your notification preferences muted this email</Text>}
    {run.result ? <SavedSummary result={run.result} /> : run.status === 'completed' && <Text>This run finished, but its saved recap is no longer available.</Text>}
  </VStack>;
}
export function RoutineRuns({ routineId, refreshRevision = 0 }: { routineId: string; refreshRevision?: number }): ReactElement {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const focus = useRefreshOnFocus();
  useEffect(() => {
    let current = true;
    setRuns(null); setFailed(false);
    void listRoutineRuns(routineId).then((items) => { if (current) setRuns(items); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [routineId, retry, focus, refreshRevision]);
  const days = new Map<string, RoutineRun[]>();
  for (const run of runs ?? []) {
    const day = new Date(run.scheduledAt).toLocaleDateString();
    days.set(day, [...(days.get(day) ?? []), run]);
  }
  return <VStack gap={6}>
    <VStack gap={2}><Heading level={2}>Run history</Heading><Text type="supporting">Each run keeps its own recap. Up to 100 recent runs from the last 90 days.</Text>
      <Button label="Refresh runs" size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)} /></VStack>
    {failed && <Banner status="error" title="Couldn’t load recent runs" endContent={<Button label="Retry runs" onClick={() => setRetry((value) => value + 1)} />} />}
    {!failed && runs === null && <Text role="status">Checking recent runs…</Text>}
    {runs?.length === 0 && <Text>No runs yet. Bob will start at the next scheduled time.</Text>}
    {Array.from(days, ([day, items]) => <VStack key={day} gap={3}><Heading level={3}>{day}</Heading>
      {items.map((run) => <Collapsible key={run.id} value={run.id} defaultIsOpen={false} trigger={`${new Date(run.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${STATUS[run.status]}`}><RoutineRunDetails run={run} /></Collapsible>)}
    </VStack>)}
  </VStack>;
}
