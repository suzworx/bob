import { BRAND } from '@/lib/brand';
import { useEffect, type ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Heading } from '@astryxdesign/core/Heading';
import { Link } from '@astryxdesign/core/Link';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { useInvitation, type InvitationPreviewDto } from '@/features/spaces/use-invitation';
import { spaceKindLabel } from '@/features/spaces/use-spaces';
import { navigateTo } from '../../app/routes';
import { SignIn } from '../account/sign-in';
import { WAITLIST_URL } from '../account/waitlist';

// UTC so the shown date is the same in every timezone.
const EXPIRY_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

// A finite number can still be outside the JS Date range, which Intl rejects.
function isValidExpiry(expiresAt: number | undefined): expiresAt is number {
  return typeof expiresAt === 'number' && !Number.isNaN(new Date(expiresAt).getTime());
}

function HistoryNotice({ exposesHistory }: { exposesHistory: boolean }): ReactElement {
  const text = exposesHistory
    ? "Joining lets every member see this space's full conversation history."
    : "Joining does not expose this space's earlier conversation history.";
  return (
    <Banner status="info" title={text} container="card" />
  );
}

function PreviewCard({ preview }: { preview: InvitationPreviewDto }): ReactElement {
  return (
    <VStack gap={1}>
      <Heading level={1}>{preview.space_name}</Heading>
      <Text type="supporting">
        You're invited to a {spaceKindLabel({ kind: preview.space_kind }).toLowerCase()} space by{' '}
        {preview.inviter_display_name}.
      </Text>
      {preview.role && (
        <Text type="supporting">
          You'll join as {preview.role === 'admin' ? 'an admin' : 'a member'}.
        </Text>
      )}
      {isValidExpiry(preview.expires_at) && (
        <Text type="supporting">
          This invitation expires on {EXPIRY_FORMAT.format(preview.expires_at)} (UTC).
        </Text>
      )}
    </VStack>
  );
}

function outcomeMessage(spaceName: string | null): string {
  const name = spaceName ?? 'this space';
  return `You're in! Welcome to ${name}.`;
}

function AlreadyMemberMessage({ spaceName }: { spaceName: string | null }): ReactElement {
  const name = spaceName ?? 'this space';
  return <Text type="supporting">You're already a member of {name}.</Text>;
}

function ShellCard({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <Center axis="both" padding={6} minHeight="100dvh">
      <VStack gap={4} hAlign="center" width="100%" maxWidth={400}>
        <Card padding={8} width="100%">
          <VStack gap={4} hAlign="stretch">
            {children}
          </VStack>
        </Card>
      </VStack>
    </Center>
  );
}

export function InvitePage({ token }: { token: string }): ReactElement {
  const { status } = useSession();
  const { preview, loading, error, accepting, accept, outcome, retry } = useInvitation(token);
  const signInPending = error?.kind === 'sign_in_required';

  // Signing in with the emailed code happens right here on /invite/<token>, so
  // once the session arrives, reload the invitation instead of staying on SignIn.
  useEffect(() => {
    if (status === 'signed-in' && signInPending) retry();
  }, [status, signInPending, retry]);

  if (loading) {
    return (
      <ShellCard>
        <Center axis="both" padding={4}>
          <Spinner aria-label="Loading your invitation…" />
        </Center>
      </ShellCard>
    );
  }

  if (outcome !== null) {
    return (
      <ShellCard>
        <Heading level={1}>{preview?.space_name ?? 'You joined'}</Heading>
        {outcome === 'already_member' || outcome === 'already_accepted' ? (
          <AlreadyMemberMessage spaceName={preview?.space_name ?? null} />
        ) : (
          <Text type="supporting">{outcomeMessage(preview?.space_name ?? null)}</Text>
        )}
        <Button
          label="Go to your space"
          variant="primary"
          onClick={() => navigateTo('/spaces')}
        />
      </ShellCard>
    );
  }

  if (signInPending && status !== 'signed-in') {
    return <SignIn unavailable={null} />;
  }

  if (error?.kind === 'not_usable') {
    return (
      <ShellCard>
        <Heading level={1}>This invitation isn't available</Heading>
        <Banner status="error" title={error.message} container="card" />
      </ShellCard>
    );
  }

  if (error?.kind === 'wrong_account') {
    return (
      <ShellCard>
        {preview && <PreviewCard preview={preview} />}
        <Banner status="error" title={error.message} container="card" />
      </ShellCard>
    );
  }

  if (error?.kind === 'network_error') {
    return (
      <ShellCard>
        <Heading level={1}>This invitation isn't available</Heading>
        <Banner status="error" title={error.message} container="card" />
        <Button label="Try again" variant="secondary" onClick={retry} />
      </ShellCard>
    );
  }

  if (!preview) {
    return (
      <ShellCard>
        <Heading level={1}>This invitation isn't available</Heading>
        <Banner status="error" title="Something went wrong. Try again." container="card" />
        <Button label="Try again" variant="secondary" onClick={retry} />
      </ShellCard>
    );
  }

  return (
    <ShellCard>
      <PreviewCard preview={preview} />
      <HistoryNotice exposesHistory={preview.exposes_history} />
      <Button
        label={accepting ? 'Joining…' : 'Accept'}
        variant="primary"
        isLoading={accepting}
        onClick={() => void accept()}
      />
      {status === 'signed-out' && (
        <Text type="supporting" size="sm">
          To accept, sign in with the address this invitation was sent to. {BRAND.name} is invite-only. No account yet?{' '}
          <Link href={WAITLIST_URL} isExternalLink>Join the waitlist</Link>
        </Text>
      )}
    </ShellCard>
  );
}
