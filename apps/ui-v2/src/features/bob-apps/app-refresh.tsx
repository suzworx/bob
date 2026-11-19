import { useEffect, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput, type ISOTimeString } from '@astryxdesign/core/TimeInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { VStack } from '@astryxdesign/core/VStack';
import { useSpaces } from '@/features/spaces/use-spaces';
import { AppRequestError, type BobApp } from './bob-apps-api';
import { getRefresh, getRuns, saveRefresh, type RefreshState, type RefreshConfig, type AppRun } from './app-refresh-api';
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function refreshTables(app: BobApp): BobApp['definition']['tables'] {
  return app.definition.tables.filter((table) => table.fields.length === 2 && table.fields.some((field) => field.id === 'title' && field.type === 'text') && table.fields.some((field) => field.id === 'completed' && field.type === 'boolean'));
}
function scheduleIsValid(config: RefreshConfig): boolean {
  if (!config.spaceId || !config.targetTable || !config.schedule.weekdays.length || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.schedule.localTime)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: config.schedule.timeZone }).format(0); return true; } catch { return false; }
}
function RefreshForm({ app, initial, busy, onSave, onClose }: { app: BobApp; initial: RefreshState; busy: boolean; onSave: (config: RefreshConfig) => void; onClose: () => void }): ReactElement {
  const { spaces } = useSpaces();
  const tables = refreshTables(app);
  const [config, setConfig] = useState<RefreshConfig>(initial.config ?? { source: 'tasks', spaceId: '', targetTable: tables[0]?.id ?? '', schedule: { weekdays: [1,2,3,4,5], localTime: '08:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  const [consent, setConsent] = useState(false);
  const schedule = config.schedule;
  return <VStack gap={4}>
    <Text>Bob can copy tasks from one of your spaces into this app. Each refresh replaces the selected table, including local edits. The first run starts now; later runs follow your schedule.</Text>
    <Selector label="Tasks from space" value={config.spaceId} options={spaces.map((space) => ({ value: space.id, label: space.name }))} onChange={(spaceId) => { setConfig({ ...config, spaceId }); setConsent(false); }} isDisabled={busy} />
    <Selector label="Replace table" value={config.targetTable} options={tables.map((table) => ({ value: table.id, label: table.id }))} onChange={(targetTable) => { setConfig({ ...config, targetTable }); setConsent(false); }} isDisabled={busy} />
    {!tables.length && <Text>Ask Bob to add a tasks table with a title and completed field first.</Text>}
    <HStack gap={3} wrap="wrap">{DAYS.map((day, index) => <CheckboxInput key={day} label={day} value={schedule.weekdays.includes(index + 1)} isDisabled={busy} onChange={(checked) => setConfig({ ...config, schedule: { ...schedule, weekdays: checked ? [...schedule.weekdays, index + 1].sort() : schedule.weekdays.filter((value) => value !== index + 1) } })} />)}</HStack>
    <TimeInput label="Refresh at" hourFormat="24h" value={schedule.localTime as ISOTimeString} onChange={(value) => setConfig({ ...config, schedule: { ...schedule, localTime: value ?? '' } })} isDisabled={busy} />
    <TextInput label="Refresh time zone" value={schedule.timeZone} onChange={(timeZone) => setConfig({ ...config, schedule: { ...schedule, timeZone } })} isDisabled={busy} description="For example, America/Los_Angeles. This stays the same when you travel." />
    <CheckboxInput label="Let Bob read these tasks and replace this table on this schedule" value={consent} onChange={setConsent} isDisabled={busy} description="Runs continue while you’re away. Pause automatic updates whenever you like." />
    <HStack gap={2} wrap="wrap"><Button label="Enable automatic updates" variant="primary" isDisabled={busy || !consent || !scheduleIsValid(config)} onClick={() => onSave(config)} /><Button label="Cancel schedule" variant="ghost" isDisabled={busy} onClick={onClose} /></HStack>
  </VStack>;
}
export function AppRefresh({ app, onChanged, onState }: { app: BobApp; onChanged: () => void; onState: (state: RefreshState) => void }): ReactElement {
  const [refresh, setRefresh] = useState<RefreshState | null>(null);
  const [runs, setRuns] = useState<AppRun[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') setVersion((value) => value + 1); }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all([getRefresh(app.id), getRuns(app.id)]).then(([state, history]) => { if (alive) { setRefresh(state); onState(state); setRuns(history); setError(null); } })
      .catch(() => { if (alive) setError('Couldn’t load update history. Reload to try again.'); });
    return () => { alive = false; };
  }, [app.id, app.revision, version, onState]);
  const save = async (enabled: boolean, config: RefreshConfig | null): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await saveRefresh(app, enabled, config); setEditing(false); setVersion((value) => value + 1); onChanged(); }
    catch (problem) { setError(problem instanceof AppRequestError && problem.status === 409 ? 'This app changed elsewhere. Reload the latest data, then review and save your schedule again.' : 'Couldn’t save this schedule. Your choices are still here. Please try again.'); }
    finally { setBusy(false); }
  };
  // Settings still load for every personal app: a hidden panel must not turn record editing off or bypass a saved lock.
  const retry = <Button label="Retry update settings" onClick={() => { setVersion((value) => value + 1); onChanged(); }} />;
  const notice = error && <Banner status="error" title={error} endContent={retry} />;
  if (!refresh || refreshTables(app).length === 0) return <>{notice}</>;
  const hasConfiguredUpdates = refresh.config !== null || refresh.lastRefreshAt !== null || runs.length > 0;
  return <VStack gap={4}><Heading level={2}>Automatic updates</Heading>
    {notice}
    <><Text>{refresh.enabled ? 'Automatic updates are on.' : hasConfiguredUpdates ? 'Automatic updates are paused.' : 'Copy tasks here on a schedule, if you like.'}</Text>
      {refresh.lastRefreshAt && <Text type="supporting">Last updated <Timestamp value={new Date(refresh.lastRefreshAt).toISOString()} format="relative" /></Text>}
      {refresh.nextRunAt && <Text>Next update <Timestamp value={new Date(refresh.nextRunAt).toISOString()} format="relative" /></Text>}
      {refresh.lastError && <Banner status="warning" title="The last refresh didn’t finish" description="Your last saved data is still here. Check the source and schedule, then try again." />}
      {app.lifecycle === 'active' && <HStack gap={2} wrap="wrap"><Button label="Configure automatic updates" isDisabled={busy} onClick={() => setEditing(true)} />
        {refresh.enabled && <Button label="Pause automatic updates" isDisabled={busy} onClick={() => void save(false, null)} />}</HStack>}
      {editing && <RefreshForm app={app} initial={refresh} busy={busy} onSave={(config) => void save(true, config)} onClose={() => setEditing(false)} />}
    </>
    {runs.length > 0 && <List hasDividers header={<Heading level={3}>Refresh history</Heading>}>{runs.map((run) => <ListItem key={run.id} label={`${new Date(run.scheduledAt).toLocaleString()} · ${run.status}`} description={run.failureCode ? 'No new data was saved. Check the source and try again.' : undefined} />)}</List>}
  </VStack>;
}
