import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { startGoogleAuthorization, type GoogleAccount, type GoogleCapability } from './google-accounts-api';

type CalendarLevel = 'none' | 'calendar.read' | 'calendar.write';
type MailLevel = 'none' | 'gmail.read' | 'gmail.draft';

/** One level per service, since write includes read. A new connection starts
 * at read for both; an existing one starts from what it has, so reconnecting
 * never quietly drops access. */
function initialGoogleAccess(access: readonly GoogleCapability[] | undefined): { calendar: CalendarLevel; mail: MailLevel } {
  if (!access) return { calendar: 'calendar.read', mail: 'gmail.read' };
  return {
    calendar: access.includes('calendar.write') ? 'calendar.write' : access.includes('calendar.read') ? 'calendar.read' : 'none',
    mail: access.includes('gmail.draft') ? 'gmail.draft' : access.some((value) => value === 'gmail.read' || value === 'gmail.send' || value === 'gmail.modify') ? 'gmail.read' : 'none',
  };
}

/** The capabilities a pair of levels requests (write and drafts include read). */
function googleCapabilities(calendar: CalendarLevel, mail: MailLevel, actions: string[]): GoogleCapability[] {
  const capabilities: GoogleCapability[] = [];
  if (calendar !== 'none') capabilities.push('calendar.read');
  if (calendar === 'calendar.write') capabilities.push('calendar.write');
  if (mail !== 'none' || actions.length > 0) capabilities.push('gmail.read');
  if (mail === 'gmail.draft') capabilities.push('gmail.draft');
  if (actions.includes('gmail.send')) capabilities.push('gmail.send');
  if (actions.includes('gmail.modify')) capabilities.push('gmail.modify');
  return capabilities;
}

/** Connect a new account, or Change access for an existing one. */
export function GoogleConsentDialog({ account, onClose }: { account?: GoogleAccount; onClose: () => void }): ReactElement {
  const initial = initialGoogleAccess(account && account.access.length > 0 ? account.access : undefined);
  const [calendar, setCalendar] = useState<CalendarLevel>(initial.calendar);
  const [mail, setMail] = useState<MailLevel>(initial.mail);
  const [actions, setActions] = useState<string[]>(account?.access.filter((value) => value === 'gmail.send' || value === 'gmail.modify') ?? []);
  const changeMail = (value: string): void => {
    setMail(value as MailLevel);
    if (value === 'none') setActions([]);
  };
  const changeActions = (values: string[]): void => {
    setActions(values);
    if (values.length > 0 && mail === 'none') setMail('gmail.read');
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const capabilities = googleCapabilities(calendar, mail, actions);
  const connect = async (): Promise<void> => {
    const controller = lifetime.current;
    if (!controller || busy || capabilities.length === 0) return;
    setBusy(true); setError(false);
    try {
      const url = await startGoogleAuthorization({ capabilities, ...(account ? { reconnectAccountId: account.id } : {}) }, controller.signal);
      if (!controller.signal.aborted) window.location.assign(url);
    } catch { if (!controller.signal.aborted) { setError(true); setBusy(false); } }
  };
  const close = (open: boolean): void => { if (!open && !busy) onClose(); };
  return <Dialog isOpen purpose={busy ? 'required' : 'form'} onOpenChange={close}>
    <Layout header={<DialogHeader title={account ? 'Change access' : 'Connect Google'} subtitle={account?.email} onOpenChange={close} />}
      content={<LayoutContent><VStack gap={4}>
        <Text type="supporting">You'll confirm this with Google.</Text>
        {error && <Banner status="error" title="Couldn't reach Google. Try again." />}
        <RadioList label="Calendar" value={calendar} onChange={(value) => setCalendar(value as CalendarLevel)} isDisabled={busy}>
          <RadioListItem value="none" label="No access" />
          <RadioListItem value="calendar.read" label="See events" />
          <RadioListItem value="calendar.write" label="See and edit events" />
        </RadioList>
        <RadioList label="Gmail" value={mail} onChange={changeMail} isDisabled={busy}>
          <RadioListItem value="none" label="No access" />
          <RadioListItem value="gmail.read" label="Read mail" />
          <RadioListItem value="gmail.draft" label="Read mail and manage drafts" description="Compose and update drafts. Sending is a separate choice below." />
        </RadioList>
        <CheckboxList label="Additional Gmail actions" description="Each includes reading mail. Sending and Trash access are separate permissions." value={actions} onChange={changeActions} hasDividers isDisabled={busy}>
          <CheckboxListItem value="gmail.send" label="Send reviewed drafts" description="Send a draft only when you explicitly ask." />
          <CheckboxListItem value="gmail.modify" label="Move mail to Trash and restore" description="Manage recoverable Trash. Never permanently delete mail." />
        </CheckboxList>
        {capabilities.length === 0 && <Text type="supporting" role="status">Choose access for Calendar or Gmail.</Text>}
      </VStack></LayoutContent>}
      footer={<LayoutFooter>
        <Button label="Cancel" variant="ghost" isDisabled={busy} onClick={onClose} />
        <Button label="Continue with Google" variant="primary" isDisabled={busy || capabilities.length === 0} isLoading={busy} onClick={() => void connect()} />
      </LayoutFooter>} />
  </Dialog>;
}
