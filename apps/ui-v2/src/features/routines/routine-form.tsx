import { useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TimeInput, type ISOTimeString } from '@astryxdesign/core/TimeInput';
import { VStack } from '@astryxdesign/core/VStack';
import type { GoogleAccount } from '@/features/integrations/google-accounts-api';
import { createRoutine, RoutineRequestError, updateRoutine, type Routine } from './routines-api';

function validSchedule(localTime: string, timeZone: string): boolean {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime) || !timeZone || /^[+-]/.test(timeZone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true; } catch { return false; }
}
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Props = { accounts: GoogleAccount[]; routine?: Routine; onClose: () => void; onSaved: (routine: Routine) => void };
function useRoutineForm({ accounts, routine, onClose, onSaved }: Props) {
  const eligible = accounts.filter((account) => account.access.includes('gmail.read') && !account.needsReconnect);
  const [accountId, setAccountId] = useState(routine?.googleAccountId ?? '');
  const [config, setConfig] = useState({ name: routine?.name ?? 'Email recap', instructions: routine?.instructions ?? '', gmailQuery: routine?.gmailQuery ?? '', summaryStyle: routine?.summaryStyle ?? 'concise', emailResult: routine?.emailResult ?? false, weekdays: routine?.weekdays ?? [1,2,3,4,5,6,7], localTime: routine?.localTime ?? '08:00', timeZone: routine?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsConsent = !routine || accountId !== routine.googleAccountId;
  const accountAllowed = !needsConsent || (consent && eligible.some((account) => account.id === accountId));
  const valid = validSchedule(config.localTime, config.timeZone) && config.name.trim().length > 0 && config.name.length <= 100 && config.instructions.length <= 2000 && config.gmailQuery.length <= 500 && config.weekdays.length > 0 && accountAllowed;
  const save = async (): Promise<void> => {
    if (busy || !valid) return;
    setBusy(true); setError(null);
    try {
      const saved = routine ? await updateRoutine(routine.id, { ...config, expectedRevision: routine.revision, ...(needsConsent ? { googleAccountId: accountId, scheduledReadConsent: true as const } : {}) })
        : await createRoutine({ ...config, kind: 'daily_gmail_digest', googleAccountId: accountId, scheduledReadConsent: true });
      onSaved(saved);
    } catch (problem) {
      setError(problem instanceof RoutineRequestError && problem.status === 409 ? 'This routine changed elsewhere. Close this form and refresh before trying again.' : 'Couldn’t save this routine. Check your Google connection and try again.');
      setBusy(false);
    }
  };
  const close = (open: boolean): void => { if (!open && !busy) onClose(); };
  const chooseAccount = (value: string): void => { setAccountId(value); setConsent(false); };
  return { eligible, accountId, chooseAccount, config, setConfig, consent, setConsent, needsConsent, busy, error, valid, save, close };
}
export function RoutineForm(props: Props): ReactElement {
  const { routine, onClose } = props;
  const state = useRoutineForm(props);
  const { config, setConfig, busy } = state;
  return <Dialog isOpen purpose={busy ? 'required' : 'form'} onOpenChange={state.close}>
    <Layout header={<DialogHeader title={routine ? 'Configure routine' : 'Create routine'} onOpenChange={state.close} />}
      content={<LayoutContent><VStack gap={6}>
        <Text>Choose what Bob prepares and when. Each run saves a recap in this routine’s timeline.</Text>
        {state.error && <Banner status="error" title={state.error} />}
        <VStack gap={4}>
          <TextInput label="Routine name" value={config.name} onChange={(name) => setConfig({ ...config, name })} isDisabled={busy} />
          <Selector label="Google account" placeholder="Choose an account" value={state.accountId} onChange={state.chooseAccount} isDisabled={busy} options={state.eligible.map((account) => ({ value: account.id, label: account.customName ? `${account.customName} · ${account.email}` : account.email }))} />
          {!routine && state.eligible.length === 0 && <Banner status="warning" title="Connect an account with Gmail access first" endContent={<Button label="Manage integrations" href="/integrations" />} />}
          <TextInput label="Email filter" value={config.gmailQuery} onChange={(gmailQuery) => setConfig({ ...config, gmailQuery })} isDisabled={busy} description="Optional Gmail search, such as label:work or from:example.com. Bob reads matching recent emails." />
          <TextArea label="What should Bob focus on?" value={config.instructions} maxLength={2000} onChange={(instructions) => setConfig({ ...config, instructions })} isDisabled={busy} placeholder="For example, highlight interviews, deadlines and anything needing a reply." />
          <Selector label="Summary detail" value={config.summaryStyle} onChange={(summaryStyle) => { if (summaryStyle === 'concise' || summaryStyle === 'detailed') setConfig({ ...config, summaryStyle }); }} isDisabled={busy} options={[{value:'concise',label:'Concise highlights'}, {value:'detailed',label:'Detailed recap'}]} />
          <CheckboxInput label="Email me when a recap is ready" value={config.emailResult} onChange={(emailResult) => setConfig({ ...config, emailResult })} isDisabled={busy} description="This is optional. Your notification preferences can mute the email." />
        </VStack>
        <VStack gap={4}><Heading level={2}>Schedule</Heading>
          <HStack gap={3} wrap="wrap">{DAYS.map((day, index) => <CheckboxInput key={day} label={day} value={config.weekdays.includes(index + 1)} isDisabled={busy} onChange={(checked) => setConfig({ ...config, weekdays: checked ? [...config.weekdays, index + 1].sort() : config.weekdays.filter((value) => value !== index + 1) })} />)}</HStack>
          {config.weekdays.length === 0 && <Text role="status">Choose at least one day.</Text>}
          <TimeInput label="Run at" hourFormat="24h" value={config.localTime as ISOTimeString} onChange={(value) => setConfig({ ...config, localTime: value ?? '' })} isDisabled={busy} />
          <TextInput label="Time zone" value={config.timeZone} onChange={(timeZone) => setConfig({ ...config, timeZone })} isDisabled={busy} description="For example, America/Los_Angeles. This stays the same when you travel." />
          {!validSchedule(config.localTime, config.timeZone) && <Text role="status">Choose a valid time and time zone.</Text>}
        </VStack>
        {state.needsConsent && <CheckboxInput label="Let Bob read this account's emails on this schedule" value={state.consent} onChange={state.setConsent} isDisabled={busy} description="Bob reads matching recent messages while you’re away. Pause or archive the routine whenever you like." />}
      </VStack></LayoutContent>}
      footer={<LayoutFooter><HStack gap={2} hAlign="end"><Button label="Cancel" variant="ghost" onClick={onClose} isDisabled={busy} />
        <Button label={routine ? 'Save changes' : 'Create routine'} variant="primary" isLoading={busy} isDisabled={!state.valid || busy} onClick={() => void state.save()} />
      </HStack></LayoutFooter>} />
  </Dialog>;
}
