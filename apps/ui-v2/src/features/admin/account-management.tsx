import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { useToast } from '@astryxdesign/core/Toast';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import {
  AdminRequestError,
  searchAccounts,
  manageAccount,
  type AccountSearchResult,
  type ManagedAccount,
  type AccountAction,
} from './admin-api';
import { invalidateAdminAccess } from './use-admin-access';

const ACTION_LABELS: Record<AccountAction, string> = {
  enable: 'Enable sign-in',
  disable: 'Disable sign-in',
  grant_admin: 'Make admin',
  revoke_admin: 'Remove admin',
};
// Taking access away is confirmed and names the person; giving it back runs at once with a toast.
const CONFIRMED: ReadonlySet<AccountAction> = new Set(['disable', 'revoke_admin']);
const DONE: Record<AccountAction, string> = {
  enable: 'Sign-in enabled',
  disable: 'Sign-in disabled',
  grant_admin: 'Now an admin',
  revoke_admin: 'Admin removed',
};
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
function displayDate(value: string | null): string {
  if (!value) return 'Never';
  return DATE.format(new Date(value));
}
/** A row's menu: admin first, then a divider and the destructive Disable sign-in last.
 *  Your own account can't lose sign-in or admin: those items are left out, not greyed. */
function menuItems(
  account: ManagedAccount,
  self: boolean,
  choose: (account: ManagedAccount, action: AccountAction) => void,
): DropdownMenuOption[] {
  const admin: AccountAction = account.isAdmin ? 'revoke_admin' : 'grant_admin';
  const items: DropdownMenuOption[] = [];
  if (!(self && admin === 'revoke_admin')) items.push({ label: ACTION_LABELS[admin], onClick: () => choose(account, admin) });
  if (account.status === 'disabled') {
    items.push({ label: ACTION_LABELS.enable, onClick: () => choose(account, 'enable') });
    return items;
  }
  if (self) return items;
  if (items.length > 0) items.push({ type: 'divider' });
  items.push({ label: ACTION_LABELS.disable, variant: 'destructive', onClick: () => choose(account, 'disable') });
  return items;
}

/** Simple Table inside the existing Settings Form; one row menu and one confirmation flow. */
export function AccountManagement({ revision = 0 }: { revision?: number }): ReactElement {
  const { session } = useSession();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<AccountSearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    account: ManagedAccount;
    action: AccountAction;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const generation = useRef(0);
  const mutationPending = useRef(false);
  const lastQuery = useRef('');
  const denyOrError = useCallback((failure: unknown, fallback: string): void => {
    if (
      failure instanceof AdminRequestError &&
      (failure.status === 401 || failure.status === 403 || failure.status === 404)
    ) {
      generation.current += 1;
      setResult(null);
      invalidateAdminAccess();
    } else {
      setError(
        failure instanceof AdminRequestError && failure.status === 409
          ? 'This change is protected. You cannot disable yourself, remove your own admin access, or remove the last site admin.'
          : fallback,
      );
    }
  }, []);
  const load = useCallback(
    async (value: string, cursor?: string): Promise<void> => {
      const current = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const next = await searchAccounts(value, cursor);
        if (current !== generation.current) return;
        lastQuery.current = value;
        setResult(next);
      } catch (failure) {
        if (current === generation.current)
          denyOrError(failure, 'Accounts could not be loaded. Try again.');
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [denyOrError],
  );
  useEffect(() => {
    setCursors([undefined]);
    void load(lastQuery.current);
    return () => {
      generation.current += 1;
    };
  }, [load, revision]);
  async function run(target: { account: ManagedAccount; action: AccountAction } | null): Promise<void> {
    if (!target || mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    setError(null);
    try {
      await manageAccount(target.account.id, target.action);
      setSelection(null);
      toast({ body: `${DONE[target.action]}: ${target.account.email ?? 'account'}`, isAutoHide: true });
      setCursors([undefined]);
      await load(lastQuery.current);
    } catch (failure) {
      denyOrError(failure, 'The account could not be updated. Refresh and try again.');
      setSelection(null);
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  }
  function choose(account: ManagedAccount, action: AccountAction): void {
    if (CONFIRMED.has(action)) setSelection({ account, action });
    else void run({ account, action });
  }
  function menu(account: ManagedAccount): ReactElement {
    const items = menuItems(account, account.id === session?.user.id, choose);
    if (items.length === 0) return <Text type="supporting">You</Text>;
    return <MoreMenu label="Manage account" presentation="adaptive" isDisabled={saving} items={items} />;
  }
  function search(): void {
    setCursors([undefined]);
    void load(query.trim());
  }
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={2}>People</Heading>
        <Text type="supporting">
          Manage sign-in and site administration. Space memberships are unchanged.
        </Text>
      </VStack>
      {result && (
        <MetadataList orientation="horizontal">
          <MetadataListItem label="Accounts">{String(result.counts.total)}</MetadataListItem>
          <MetadataListItem label="Sign-in enabled">{String(result.counts.enabled)}</MetadataListItem>
          <MetadataListItem label="Disabled">{String(result.counts.disabled)}</MetadataListItem>
          <MetadataListItem label="Email not confirmed">{String(result.counts.awaitingConfirmation)}</MetadataListItem>
        </MetadataList>
      )}
      <TextInput
        label="Search by email prefix"
        value={query}
        onChange={(value) => setQuery(value.slice(0, 254))}
        onEnter={search}
      />
      <HStack gap={2} wrap="wrap">
        <Button onClick={search} isDisabled={loading || saving} label="Search accounts" />
        <Button
          variant="ghost"
          onClick={() => {
            setCursors([undefined]);
            void load(lastQuery.current);
          }}
          isDisabled={loading || saving}
          label="Refresh accounts"
        />
      </HStack>
      {error && (
        <Banner
          status="error"
          title={error}
          endContent={<Button label="Try again" size="sm" onClick={() => void load(lastQuery.current, cursors.at(-1))} />}
        />
      )}
      {loading && !result && (
        <VStack gap={2} role="status" aria-label="Loading accounts">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} index={index} height={48} />
          ))}
        </VStack>
      )}
      {result && <AccountTable accounts={result.accounts} menu={menu} />}
      {result?.accounts.length === 0 && !loading && <Text>No matching accounts.</Text>}
      {cursors.length > 1 && (
        <Button
          label="Previous page"
          isDisabled={loading || saving}
          onClick={() => {
            const previous = cursors.slice(0, -1);
            setCursors(previous);
            void load(lastQuery.current, previous.at(-1));
          }}
        />
      )}
      {result?.nextCursor && (
        <Button
          onClick={() => {
            setCursors([...cursors, result.nextCursor ?? undefined]);
            void load(lastQuery.current, result.nextCursor ?? undefined);
          }}
          isDisabled={loading || saving}
          label="Next page"
        />
      )}
      <AccountConfirmation
        selection={selection}
        saving={saving}
        onClose={() => setSelection(null)}
        onConfirm={() => run(selection)}
      />
    </VStack>
  );
}

function AccountTable({
  accounts,
  menu,
}: {
  accounts: ManagedAccount[];
  menu: (account: ManagedAccount) => ReactElement;
}): ReactElement {
  return (
    <Table
      aria-label="Accounts"
      data={accounts}
      columns={[
        {
          key: 'email',
          header: 'Account',
          width: proportional(1),
          renderCell: (account: ManagedAccount) => (
            <VStack gap={1}>
              <Text weight="semibold">{account.email}</Text>
              <Text type="supporting">
                {account.status === 'enabled' ? 'Enabled' : 'Disabled'} ·{' '}
                {account.isAdmin ? 'Site admin' : 'Member'}
              </Text>
              <Text type="supporting">
                {account.emailConfirmed ? 'Email confirmed' : 'Awaiting email confirmation'}
              </Text>
              <Text type="supporting">
                Created {displayDate(account.createdAt)} · Last sign-in{' '}
                {displayDate(account.lastSignInAt)}
              </Text>
            </VStack>
          ),
        },
        {
          key: 'actions',
          header: 'Actions',
          width: pixel(80),
          renderCell: menu,
        },
      ]}
    />
  );
}

function AccountConfirmation({
  selection,
  saving,
  onClose,
  onConfirm,
}: {
  selection: { account: ManagedAccount; action: AccountAction } | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}): ReactElement {
  const email = selection?.account.email ?? 'this account';
  const disabling = selection?.action === 'disable';
  return (
    <AlertDialog
      isOpen={selection !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      title={disabling ? `Disable sign-in for ${email}?` : `Remove admin from ${email}?`}
      description={
        disabling
          ? "They'll be signed out everywhere and can't sign in until you enable it again. Their spaces are unchanged."
          : "They'll lose access to Admin. Their account and spaces are unchanged."
      }
      actionLabel={disabling ? 'Disable sign-in' : 'Remove admin'}
      isActionLoading={saving}
      onAction={() => void onConfirm()}
    />
  );
}
