import { BRAND } from '@/lib/brand';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { CalendarDays, KeyRound, Pencil, Plus, Star, Trash2, Wrench } from 'lucide-react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { useRefreshOnFocus } from '@/lib/use-refresh-on-focus';
import {
  disconnectGoogleAccount, finishGoogleAuthorization, listGoogleAccounts, readGoogleCallback,
  selectGoogleAccount, withoutGoogleCallback, type GoogleAccount,
} from './google-accounts-api';
import { GoogleCalendarSelection } from './google-calendar-selection';
import { GoogleConsentDialog } from './google-consent-dialog';
import { ToolControlsDialog } from '@/features/tools/tool-controls';
import { GoogleAccountNameDialog } from './google-account-name-dialog';

/** The Integrations page's Google section: every connected account, one row each. Keyed by
 * the signed-in owner so nothing from a previous owner survives a switch. */
export function GoogleAccountsSection({ headingLevel = 3 }: {
  /** 2 directly under a page title, 3 when nested under another section. */
  headingLevel?: 2 | 3;
} = {}): ReactElement {
  const { session } = useSession();
  return <GoogleAccountsContent key={session?.user.id ?? 'signed-out'} headingLevel={headingLevel} />;
}

type ReturnProblem = 'failed' | 'invalid';
const RETURN_PROBLEM: Record<ReturnProblem, string> = {
  failed: "Couldn't finish connecting Google.",
  invalid: 'This Google link is out of date.',
};

/** What the account is used for, in plain words. */
function googleAccountUse(account: GoogleAccount): string {
  if (account.needsReconnect) return 'Needs reconnecting before Bob can use it';
  const calendar = account.access.includes('calendar.write') ? 'reads and edits your calendar'
    : account.access.includes('calendar.read') ? 'reads your calendar' : null;
  const mail = account.access.includes('gmail.draft') ? 'reads your mail, composes and updates drafts'
    : account.access.includes('gmail.read') ? 'reads your mail' : null;
  const send = account.access.includes('gmail.send') ? 'sends drafts when you ask' : null;
  const modify = account.access.includes('gmail.modify') ? 'moves mail to Trash and restores it' : null;
  const uses = [calendar, mail, send, modify].filter(Boolean).join(', ');
  const name = BRAND.assistantName;
  const used = uses ? `${name} ${uses}` : `${name} has no access yet`;
  return account.selected ? `${used} · Used for ${name}'s Google actions` : used;
}

function googleAccountLabel(account: GoogleAccount): string { return account.customName ?? account.email; }
function googleAccountDescription(account: GoogleAccount): string {
  return account.customName ? `${account.email} · ${googleAccountUse(account)}` : googleAccountUse(account);
}

function savedAccounts(current: GoogleAccount[] | null, updated: GoogleAccount): GoogleAccount[] | null {
  return current?.map((account) => account.id === updated.id ? updated : account) ?? null;
}
function hasAccounts(accounts: GoogleAccount[] | null): boolean { return accounts !== null && accounts.length > 0; }
function emptyHeadingLevel(level: 2 | 3): 3 | 4 { return level === 2 ? 3 : 4; }

function IntegrationToolsDialog({ account, onClose }: { account: GoogleAccount | null; onClose(): void }): ReactElement | null {
  if (!account) return null;
  return <ToolControlsDialog context={{ integrationId: account.id }} title={'Tools for ' + googleAccountLabel(account)} onClose={onClose} />;
}

function GoogleAccountsContent({ headingLevel }: { headingLevel: 2 | 3 }): ReactElement {
  const toast = useToast();
  // null = never loaded, so a failed first load shows the error alone.
  const [accounts, setAccounts] = useState<GoogleAccount[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [returnProblem, setReturnProblem] = useState<ReturnProblem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ account?: GoogleAccount } | null>(null);
  const [calendarAccount, setCalendarAccount] = useState<GoogleAccount | null>(null);
  const [removing, setRemoving] = useState<GoogleAccount | null>(null);
  const [toolAccount, setToolAccount] = useState<GoogleAccount | null>(null);
  const [renaming, setRenaming] = useState<GoogleAccount | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refreshKey = useRefreshOnFocus();

  const load = useCallback(async (): Promise<GoogleAccount[] | null> => {
    const version = ++loadVersion.current;
    try {
      const loaded = await listGoogleAccounts();
      if (!alive.current || version !== loadVersion.current) return null;
      setAccounts(loaded); setLoadFailed(false);
      return loaded;
    } catch {
      if (alive.current && version === loadVersion.current) setLoadFailed(true);
      return null;
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  // The OAuth return lands on /integrations?state=… (/settings and /gmail
  // forward it here keeping the query). Strip the keys before posting,
  // so a StrictMode replay or a reload never forwards the state twice.
  useEffect(() => {
    const callback = readGoogleCallback(window.location.search);
    if (!callback) return;
    window.history.replaceState(window.history.state, '', withoutGoogleCallback(window.location));
    if ('error' in callback) {
      if (callback.error === 'cancelled') toast({ body: 'Google connection cancelled', uniqueID: 'google-cancelled', isAutoHide: true });
      else setReturnProblem(callback.error);
      return;
    }
    setFinishing(true);
    void finishGoogleAuthorization(callback.state).then(async (account) => {
      if (!alive.current) return;
      await load();
      if (!alive.current || !account) return;
      toast({ body: `Connected ${account.email}`, uniqueID: `google-connected-${account.id}`, isAutoHide: true });
      // Choosing calendars is the obvious next step once calendar access exists.
      if (account.access.includes('calendar.read') || account.access.includes('calendar.write')) setCalendarAccount(account);
    }).catch(() => { if (alive.current) setReturnProblem('failed'); })
      .finally(() => { if (alive.current) setFinishing(false); });
  }, [load, toast]);

  const makeDefault = async (account: GoogleAccount): Promise<void> => {
    setPendingId(account.id); setActionError(null);
    try {
      await selectGoogleAccount(account.id);
      if (!alive.current) return;
      await load();
      toast({ body: `${account.email} is now the default`, uniqueID: `google-default-${account.id}`, isAutoHide: true });
    } catch { if (alive.current) setActionError(`Couldn't make ${account.email} the default. Try again.`); }
    finally { if (alive.current) setPendingId(null); }
  };

  const remove = async (account: GoogleAccount): Promise<void> => {
    setPendingId(account.id); setActionError(null);
    try {
      if (!await disconnectGoogleAccount(account.id)) throw new Error('disconnect_failed');
      if (!alive.current) return;
      setRemoving(null);
      await load();
      toast({ body: `Removed ${account.email}`, uniqueID: `google-removed-${account.id}`, isAutoHide: true });
    } catch {
      if (!alive.current) return;
      setRemoving(null);
      setActionError(`Couldn't remove ${account.email}. Try again.`);
    } finally { if (alive.current) setPendingId(null); }
  };

  const connect = (): void => { setReturnProblem(null); setConsent({}); };
  const ready = accounts !== null;

  return <VStack gap={4} paddingBlock={4}>
    <HStack gap={3} vAlign="center" wrap="wrap">
      <StackItem size="fill"><VStack gap={0.5}>
        <Heading level={headingLevel}>Google</Heading>
        <Text type="supporting">Gmail and Calendar</Text>
      </VStack></StackItem>
    </HStack>
    {returnProblem && <Banner status="error" title={RETURN_PROBLEM[returnProblem]} description="Nothing was changed. You can try again."
      isDismissable onDismiss={() => setReturnProblem(null)}
      endContent={<Button label="Connect again" size="sm" variant="secondary" onClick={connect} />} />}
    {loadFailed && <Banner status="error" title="Couldn't load your Google accounts."
      endContent={<Button label="Retry" size="sm" variant="secondary" onClick={() => void load()} />} />}
    {actionError && <Banner status="error" title={actionError} isDismissable onDismiss={() => setActionError(null)} />}
    {!ready && !loadFailed && <VStack gap={2} role="status" aria-label="Loading Google accounts">
      <Skeleton height={48} index={0} /><Skeleton height={48} index={1} />
    </VStack>}
    {ready && accounts.length === 0 && !finishing && <EmptyState title="No Google account" headingLevel={emptyHeadingLevel(headingLevel)}
      description={`Connect one so ${BRAND.assistantName} can read your calendar and mail.`}
      icon={<Icon icon={CalendarDays} size="lg" />}
      actions={<Button label="Connect Google" variant="primary" icon={<Icon icon={Plus} size="sm" />} onClick={connect} />} />}
    {ready && (accounts.length > 0 || finishing) && <List aria-label="Google accounts" hasDividers>
      {accounts.map((account) => <ListItem key={account.id} label={googleAccountLabel(account)}
        description={googleAccountDescription(account)}
        startContent={<StatusDot variant={account.needsReconnect ? 'warning' : 'success'} label={account.needsReconnect ? 'Needs reconnecting' : 'Connected'} />}
        endContent={<HStack gap={2} vAlign="center">
          {account.selected && <Token label="Default" size="sm" />}
          <MoreMenu label={`Actions for ${account.email}`} size="sm" alignment="end" presentation="adaptive"
            isDisabled={pendingId === account.id}
            onOpenChange={(open) => setOpenMenu(open ? account.id : null)}
            // Mounted on open: the row carries only its trigger until asked.
            items={openMenu !== account.id ? [] : [
              { type: 'section', id: 'use', items: [
                { label: 'Tools…', icon: Wrench, onClick: () => setToolAccount(account) },
                { label: 'Rename…', icon: Pencil, onClick: () => setRenaming(account) },
                { label: 'Calendars…', icon: CalendarDays, onClick: () => setCalendarAccount(account) },
                ...(account.selected ? [] : [{ label: 'Make default', icon: Star, onClick: () => void makeDefault(account) }]),
                { label: account.needsReconnect ? 'Reconnect…' : 'Change access…', icon: KeyRound, onClick: () => setConsent({ account }) },
              ] },
              { type: 'divider' },
              { label: 'Remove', icon: Trash2, variant: 'destructive', onClick: () => setRemoving(account) },
            ]} />
        </HStack>} />)}
      {finishing && <ListItem label="Connecting…" description={<Skeleton height={12} width={160} />} />}
    </List>}
    {hasAccounts(accounts) && <HStack>
      <Button label="Connect another Google account" variant="secondary" icon={<Icon icon={Plus} size="sm" />} isDisabled={finishing} onClick={connect} />
    </HStack>}
    <IntegrationToolsDialog account={toolAccount} onClose={() => setToolAccount(null)} />
    {consent && <GoogleConsentDialog key={consent.account?.id ?? 'new'} account={consent.account} onClose={() => setConsent(null)} />}
    {renaming && <GoogleAccountNameDialog key={renaming.id} account={renaming} onClose={() => setRenaming(null)}
      onSaved={(updated) => {
        ++loadVersion.current;
        setAccounts((current) => savedAccounts(current, updated));
        setRenaming(null);
        toast({ body: 'Integration name saved', uniqueID: `google-renamed-${updated.id}`, isAutoHide: true });
      }} />}
    {calendarAccount && <GoogleCalendarSelection key={calendarAccount.id} account={calendarAccount} onClose={() => setCalendarAccount(null)}
      onReconnect={() => { const account = calendarAccount; setCalendarAccount(null); setConsent({ account }); }} />}
    <AlertDialog isOpen={removing !== null} onOpenChange={(open) => { if (!open && pendingId === null) setRemoving(null); }}
      title={`Remove ${removing?.email ?? 'this account'}?`}
      description={`${BRAND.assistantName} will stop reading its mail and calendars. You can connect it again later.`}
      actionLabel="Remove" isActionLoading={removing !== null && pendingId === removing.id}
      onAction={() => { if (removing) void remove(removing); }} />
  </VStack>;
}
