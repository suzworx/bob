import { AccountManagement } from './account-management';
import { WaitlistManagement } from './waitlist-management';
import { useRef, useState, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter, LayoutHeader } from '@astryxdesign/core/Layout';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { BRAND } from '@/lib/brand';
import { PAGE_WIDTH, PageTitle, usePagePadding } from '@/app/page-width';
import { navigateTo, useLocationHash } from '@/app/routes';
import { MetricsPage } from '@/features/metrics/metrics-page';
import { useOperatorAccess } from '@/features/metrics/use-operator-access';
import { addPerson, AdminRequestError, inviteOutcome } from './admin-api';
import { invalidateAdminAccess, useAdminAccessState } from './use-admin-access';

type AdminTab = 'users' | 'waitlist' | 'monitoring';
const TABS: ReadonlyArray<{ value: AdminTab; label: string }> = [
  { value: 'users', label: 'Users' },
  { value: 'waitlist', label: 'Waitlist' },
  { value: 'monitoring', label: 'Monitoring' },
];

/** The tab named by the hash (#users #waitlist #monitoring); Users otherwise. */
export function adminTab(hash: string, canMonitor: boolean): AdminTab {
  const id = hash.replace(/^#/, '');
  if (id === 'monitoring') return canMonitor ? 'monitoring' : 'users';
  return id === 'waitlist' ? 'waitlist' : 'users';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The inline message for a failed add; null when access was revoked (the page hides itself). */
function addFailure(failure: unknown): string | null {
  if (failure instanceof AdminRequestError && (failure.status === 401 || failure.status === 404)) {
    invalidateAdminAccess();
    return null;
  }
  return failure instanceof AdminRequestError && failure.status === 429
    ? 'Please wait a moment before adding another person.'
    : 'Access could not be added.';
}

/** "Add person": an email field in a Dialog; the result is a toast, a failure stays inline with Retry. */
function AddPersonDialog({
  isOpen,
  onClose,
  onAccountAdded,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAccountAdded: () => void;
}): ReactElement {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [retryInvitation, setRetryInvitation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const inFlight = useRef(false);
  const trimmed = email.trim();
  const valid = trimmed.length <= 254 && EMAIL.test(trimmed);

  const close = (): void => {
    setEmail('');
    setError(null);
    setTouched(false);
    setRetryInvitation(false);
    onClose();
  };

  async function submit(): Promise<void> {
    setTouched(true);
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await addPerson(trimmed, retryInvitation);
      onAccountAdded();
      const message = inviteOutcome(result, trimmed);
      if (message === null) {
        setRetryInvitation(true);
        setError('The account is ready, but the invite didn’t send.');
        return;
      }
      toast({ body: message, isAutoHide: true });
      close();
    } catch (failure) {
      const message = addFailure(failure);
      if (message !== null) setError(message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && !pending && close()} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Add person"
            subtitle={`They can sign in to ${BRAND.name} with this email. It doesn't add them to a space.`}
            onOpenChange={() => !pending && close()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Email address"
                type="email"
                value={email}
                onChange={(value) => {
                  setEmail(value);
                  setError(null);
                  setRetryInvitation(false);
                }}
                onEnter={() => void submit()}
                isDisabled={pending}
                autoComplete="off"
                status={touched && !valid ? { type: 'error', message: 'Enter an email address, like you@example.com.' } : undefined}
              />
              {error && (
                <Banner
                  status="error"
                  title={error}
                  endContent={<Button label={retryInvitation ? 'Retry invite' : 'Try again'} size="sm" onClick={() => void submit()} />}
                />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" isDisabled={pending} onClick={close} />
              <Button label="Send invite" variant="primary" isLoading={pending} onClick={() => void submit()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/**
 * Admin: one access check, then tabs Users · Waitlist · Monitoring (the
 * Monitoring tab only for operators). The tab lives in the #hash so reload and
 * Back keep it.
 */
export function AdminPage(): ReactElement {
  const { access, retry } = useAdminAccessState();
  const padding = usePagePadding();
  const operator = useOperatorAccess();
  const tab = adminTab(useLocationHash(), operator === 'yes');
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const tabs = TABS.filter((item) => item.value !== 'monitoring' || operator === 'yes');

  return (
    <Layout
      height="fill"
      padding={padding}
      contentWidth={PAGE_WIDTH}
      header={
        <LayoutHeader>
          <VStack gap={4}>
            <HStack gap={2} vAlign="start">
              <StackItem size="fill">
                <PageTitle>Admin</PageTitle>
              </StackItem>
              {access === 'yes' && tab === 'users' && (
                <Button label="Add person" variant="primary" size="sm" onClick={() => setAdding(true)} />
              )}
            </HStack>
            {access === 'yes' && (
              <TabList
                role="tablist"
                value={tab}
                hasDivider
                onChange={(value) => navigateTo(`/admin#${value}`)}
              >
                {tabs.map((item) => (
                  <Tab key={item.value} value={item.value} label={item.label} panelId={`admin-${item.value}`} />
                ))}
              </TabList>
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {access === 'checking' && (
            <VStack gap={2} role="status" aria-label="Checking access">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} index={index} height={48} />
              ))}
            </VStack>
          )}
          {access === 'no' && (
            <EmptyState title="Not available" description="Admin is for site admins." headingLevel={2} />
          )}
          {access === 'failed' && (
            <Banner
              status="error"
              title="Access couldn't be checked."
              endContent={<Button label="Try again" size="sm" onClick={retry} />}
            />
          )}
          {access === 'yes' && (
            <VStack gap={4} id={`admin-${tab}`} role="tabpanel">
              {tab === 'users' && <AccountManagement revision={revision} />}
              {tab === 'waitlist' && (
                <WaitlistManagement revision={revision} onInvited={() => setRevision((value) => value + 1)} />
              )}
              {tab === 'monitoring' && <MetricsPage embedded />}
            </VStack>
          )}
          <AddPersonDialog
            isOpen={adding}
            onClose={() => setAdding(false)}
            onAccountAdded={() => setRevision((value) => value + 1)}
          />
        </LayoutContent>
      }
    />
  );
}
