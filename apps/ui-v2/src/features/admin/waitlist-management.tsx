import { useEffect, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Selector } from '@astryxdesign/core/Selector';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { useToast } from '@astryxdesign/core/Toast';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { AdminRequestError, addPerson, inviteOutcome, searchWaitlist, type WaitlistEntry, type WaitlistResult, type WaitlistStatus } from './admin-api';
import { invalidateAdminAccess } from './use-admin-access';

const FILTERS: Array<{ value: WaitlistStatus; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'waiting', label: 'Verified, waiting for an account' },
  { value: 'pending', label: 'Awaiting verification' },
  { value: 'verified', label: 'Email verified' },
  { value: 'with_account', label: 'Has an account' },
];
const ACCOUNT_LABELS = { none: 'No account', enabled: 'Sign-in enabled', disabled: 'Sign-in disabled' };
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const date = (value: string): string => DATE.format(new Date(value));

function WaitlistTable({
  entries,
  inviting,
  onInvite,
}: {
  entries: WaitlistEntry[];
  inviting: string | null;
  onInvite: (entry: WaitlistEntry) => void;
}): ReactElement {
  return (
    <Table
      aria-label="Waitlist people"
      data={entries}
      idKey="id"
      columns={[
        {
          key: 'email', header: 'Person', width: proportional(2),
          renderCell: (entry: WaitlistEntry) => (
            <VStack gap={1}>
              <Text weight="semibold">{entry.email}</Text>
              <Text type="supporting">Source: {entry.source}</Text>
              <Text type="supporting">Joined {date(entry.createdAt)}</Text>
            </VStack>
          ),
        },
        {
          key: 'status', header: 'Status', width: proportional(1),
          renderCell: (entry: WaitlistEntry) => (
            <VStack gap={1}>
              <Text>{entry.verifiedAt ? 'Email verified' : 'Awaiting verification'}</Text>
              {entry.verifiedAt && <Text type="supporting">Verified {date(entry.verifiedAt)}</Text>}
              <Text type="supporting">{ACCOUNT_LABELS[entry.accountStatus]}</Text>
            </VStack>
          ),
        },
        {
          key: 'actions', header: 'Actions', width: pixel(110),
          // Invite is offered to a verified person who has no account yet.
          renderCell: (entry: WaitlistEntry) =>
            entry.verifiedAt && entry.accountStatus === 'none' ? (
              <Button
                label="Invite"
                size="sm"
                isLoading={inviting === entry.id}
                isDisabled={inviting !== null}
                onClick={() => onInvite(entry)}
              />
            ) : null,
        },
      ]}
    />
  );
}

export function WaitlistManagement({ revision = 0, onInvited }: { revision?: number; onInvited?: () => void }): ReactElement {
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState<{ query: string; status: WaitlistStatus; cursors: Array<string | undefined> }>({ query: '', status: 'all', cursors: [undefined] });
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<WaitlistResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<WaitlistEntry | null>(null);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailed(false);
    setResult(null);
    searchWaitlist(request.query, request.status, request.cursors.at(-1)).then(
      (next) => { if (live) { setResult(next); setLoading(false); } },
      (error: unknown) => {
        if (!live) return;
        setLoading(false);
        if (error instanceof AdminRequestError && [401, 403, 404].includes(error.status)) invalidateAdminAccess();
        else setFailed(true);
      },
    );
    return () => { live = false; };
  }, [request, refresh, revision]);

  function search(): void {
    setRequest({ query: query.trim(), status: request.status, cursors: [undefined] });
  }
  async function invite(entry: WaitlistEntry, retryInvitation = false): Promise<void> {
    setInviting(entry.id);
    setInviteError(null);
    try {
      const message = inviteOutcome(await addPerson(entry.email, retryInvitation), entry.email);
      if (message === null) setInviteError(entry);
      else {
        toast({ body: message, isAutoHide: true });
        onInvited?.();
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      if (error instanceof AdminRequestError && [401, 404].includes(error.status)) invalidateAdminAccess();
      else setInviteError(entry);
    } finally {
      setInviting(null);
    }
  }
  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={2}>Waitlist</Heading>
        <Text type="supporting">Review interest and email verification before adding a person. Verification alone does not grant sign-in access.</Text>
      </VStack>
      {result && (
        <MetadataList orientation="horizontal">
          <MetadataListItem label="Verified, waiting for an account">{String(result.counts.waitingVerified)}</MetadataListItem>
          <MetadataListItem label="On the waitlist">{String(result.counts.total)}</MetadataListItem>
          <MetadataListItem label="Verified">{String(result.counts.verified)}</MetadataListItem>
          <MetadataListItem label="Awaiting verification">{String(result.counts.pending)}</MetadataListItem>
          <MetadataListItem label="Has an account">{String(result.counts.withAccount)}</MetadataListItem>
        </MetadataList>
      )}
      <TextInput label="Search waitlist by email prefix" value={query} onChange={(value) => setQuery(value.slice(0, 254))} onEnter={search} />
      <Selector
        label="Waitlist status"
        value={request.status}
        options={FILTERS}
        onChange={(value) => setRequest({ query: query.trim(), status: FILTERS.find((filter) => filter.value === value)?.value ?? 'all', cursors: [undefined] })}
      />
      <HStack gap={2} wrap="wrap">
        <Button label="Search waitlist" onClick={search} isDisabled={loading} />
        <Button label="Refresh waitlist" variant="ghost" onClick={() => setRefresh((value) => value + 1)} isDisabled={loading} />
      </HStack>
      {loading && (
        <VStack gap={2} role="status" aria-label="Loading waitlist">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} index={index} height={48} />
          ))}
        </VStack>
      )}
      {failed && (
        <Banner
          status="error"
          title="The waitlist couldn't be loaded."
          endContent={<Button label="Try again" size="sm" onClick={() => setRefresh((value) => value + 1)} />}
        />
      )}
      {inviteError && (
        <Banner
          status="error"
          title={`The invite to ${inviteError.email} didn't send.`}
          endContent={<Button label="Retry invite" size="sm" onClick={() => void invite(inviteError, true)} />}
        />
      )}
      {result && result.entries.length > 0 && (
        <WaitlistTable entries={result.entries} inviting={inviting} onInvite={(entry) => void invite(entry)} />
      )}
      {result?.entries.length === 0 && <Text>{request.query || request.status !== 'all' ? 'No matching waitlist entries.' : 'No one has joined the waitlist yet.'}</Text>}
      <HStack gap={2} wrap="wrap">
        {request.cursors.length > 1 && <Button label="Previous waitlist page" isDisabled={loading} onClick={() => setRequest({ ...request, cursors: request.cursors.slice(0, -1) })} />}
        {result?.nextCursor && <Button label="Next waitlist page" isDisabled={loading} onClick={() => setRequest({ ...request, cursors: [...request.cursors, result.nextCursor ?? undefined] })} />}
      </HStack>
    </VStack>
  );
}
