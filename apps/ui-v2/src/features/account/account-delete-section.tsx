import { BRAND } from '@/lib/brand';
import { useState, type ReactElement } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useSession } from '@/lib/auth/use-session';
import { deleteAccount } from './account-api';
import { navigateTo } from '../../app/routes';

const FAILED_ERROR = "Your account couldn't be deleted.";

function ownsSpacesError(count: number): string {
  const noun = count === 1 ? 'shared space' : 'shared spaces';
  return `You own ${count} ${noun}. Give each one to another member first, then try again.`;
}

export function DeleteAccountSection({ email }: { email: string | null }): ReactElement {
  const { signOut, signOutEverywhere } = useSession();
  const { isMobile } = useAppShellMobile();
  const phrase = email ?? 'delete my account';
  const [isExpanded, setIsExpanded] = useState(false);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; ownsSpaces: boolean } | null>(null);

  const confirmed = typed.trim().toLowerCase() === phrase.toLowerCase();

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await deleteAccount();
      if (result.kind === 'deleted') {
        // The account is gone either way; this device must not stay signed in.
        if (!(await signOutEverywhere())) await signOut();
        navigateTo('/');
        return;
      }
      setOpen(false);
      setError(
        result.kind === 'owns_groups'
          ? { message: ownsSpacesError(result.count), ownsSpaces: true }
          : { message: FAILED_ERROR, ownsSpaces: false },
      );
    } catch {
      setOpen(false);
      setError({ message: FAILED_ERROR, ownsSpaces: false });
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    setTyped('');
    setError(null);
    setIsExpanded(false);
  };

  // A settings row: the typed confirmation shows only once Delete account is pressed.
  return (
    <>
      <VStack gap={4} paddingBlock={isMobile ? 2 : 4}>
        <HStack gap={3} hAlign="between" vAlign="start" wrap="wrap">
          <VStack gap={0}>
            <Text type="body" weight="semibold" display="block">
              Delete your account
            </Text>
            <Text type="supporting" display="block">
              Deletes your conversations, memories, paired devices, connected Google accounts and private spaces,
              and removes you from every shared space. Tasks, notes and messages you added to shared spaces stay,
              credited to a former member.
            </Text>
          </VStack>
          {!isExpanded && (
            <Button label="Delete account" variant="destructive" size="sm" onClick={() => setIsExpanded(true)} />
          )}
        </HStack>
        {isExpanded && (
          <>
            <Text type="supporting">Your sign-in address is removed separately by the {BRAND.name} team.</Text>
            {error && (
              <Banner
                status="error"
                title={error.message}
                endContent={
                  error.ownsSpaces ? (
                    <Button label="Open spaces" size="sm" onClick={() => navigateTo('/spaces')} />
                  ) : (
                    <Button label="Try again" size="sm" isDisabled={!confirmed || busy} onClick={() => setOpen(true)} />
                  )
                }
              />
            )}
            <TextInput
              label="Type your email to confirm"
              description={`Enter ${phrase} to continue.`}
              value={typed}
              onChange={setTyped}
            />
            <HStack gap={2} wrap="wrap">
              <Button
                label="Delete account"
                variant="destructive"
                isDisabled={!confirmed || busy}
                onClick={() => setOpen(true)}
              />
              <Button label="Cancel" variant="ghost" isDisabled={busy} onClick={cancel} />
            </HStack>
          </>
        )}
      </VStack>
      <AlertDialog
        isOpen={open}
        onOpenChange={(isOpen) => {
          if (!busy) setOpen(isOpen);
        }}
        title={email ? `Delete ${email}?` : 'Delete your account?'}
        description="This can't be undone. Everything listed above is deleted, and you'll be signed out on every device."
        actionLabel="Delete account"
        isActionLoading={busy}
        onAction={() => void remove()}
      />
    </>
  );
}
