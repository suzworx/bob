import { BRAND } from '@/lib/brand';
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { Heading } from '@astryxdesign/core/Heading';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { getSupabaseSetup } from '@/lib/auth/supabase-client';
import { isRecoverySession, useSession } from '@/lib/auth/use-session';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { navigateTo } from '@/app/routes';

// Supabase config (supabase/config.toml): minimum_password_length = 10, password_requirements = "lower_upper_letters_digits"
const NEUTRAL_RESET_ERROR = 'The password could not be updated. Try again.';
const EXPIRED_TITLE = 'This reset link has expired';
const EXPIRED_HINT = 'Reset links work once and only for a short while. Ask for a new one and use it from the newest email.';
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MIN_MESSAGE = 'Password must be at least 10 characters.';
const PASSWORD_REQUIREMENTS_MESSAGE = 'Password needs an upper-case letter, a lower-case letter and a number.';
const PASSWORD_MISMATCH_MESSAGE = 'Passwords do not match.';
const PASSWORD_HELPER_TEXT = 'At least 10 characters, with upper and lower case letters and a number.';

function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return PASSWORD_MIN_MESSAGE;
  }
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasUppercase || !hasLowercase || !hasDigit) {
    return PASSWORD_REQUIREMENTS_MESSAGE;
  }
  return null;
}

function ResetCard({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <Center axis="both" padding={6} minHeight="100dvh">
      <VStack gap={4} hAlign="center" width="100%" maxWidth={400}>
        <VStack gap={2} hAlign="center">
          <Heading level={1}>Reset your password</Heading>
          <Text type="supporting" size="sm">
            Choose a new password for your account.
          </Text>
        </VStack>
        <VStack gap={4} hAlign="stretch" width="100%">
          {children}
        </VStack>
      </VStack>
    </Center>
  );
}

// Resolves Supabase client on mount; null while in flight or unavailable.
function useResetSetup(): { client: SupabaseClient | null; loaded: boolean } {
  const [state, setState] = useState<{ client: SupabaseClient | null; loaded: boolean }>({
    client: null,
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    void getSupabaseSetup().then((setup) => {
      if (!cancelled) {
        setState({
          client: setup.status === 'ready' ? setup.client : null,
          loaded: true,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function ResetPage(): ReactElement {
  const { status, session } = useSession();
  const { client, loaded } = useResetSetup();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submitPassword = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirm) {
      setError(PASSWORD_MISMATCH_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const { error: resetError } = await client!.auth.updateUser({ password });
      if (resetError) {
        setError(NEUTRAL_RESET_ERROR);
        return;
      }
      setDone(true);
    } catch {
      // A rejected call (a dropped network) reads the same as a refused one.
      setError(NEUTRAL_RESET_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    await submitPassword();
  };

  if (!loaded) {
    return (
      <ResetCard>
        <Center axis="both" padding={4}>
          <Spinner aria-label="Loading password reset" />
        </Center>
      </ResetCard>
    );
  }

  // A plain signed-in session must not set a password without the current one:
  // only a session from a reset link (a recovery session) gets the form.
  if (!client || status !== 'signed-in' || !isRecoverySession(session)) {
    const signedIn = status === 'signed-in';
    // supabase-js puts a failed link's reason in the URL (#error=…&error_code=otp_expired).
    const expired = /error_code=otp_expired|error=access_denied/.test(`${window.location.hash}${window.location.search}`);
    return (
      <ResetCard>
        <EmptyState
          title={expired ? EXPIRED_TITLE : 'Open the link from your email'}
          description={
            expired
              ? EXPIRED_HINT
              : signedIn
                ? 'To change your password, ask for a reset link in Settings and open it from your email.'
                : 'Open the password reset link from your email to set a new password.'
          }
          headingLevel={2}
          actions={
            signedIn ? (
              <Button label="Go to Settings" variant="primary" onClick={() => navigateTo('/settings#security')} />
            ) : (
              <Button label="Send a new link" variant="primary" onClick={() => window.location.assign('/?reset=1')} />
            )
          }
        />
      </ResetCard>
    );
  }

  if (done) {
    return (
      <ResetCard>
        <VStack gap={4} hAlign="stretch">
          <VStack gap={2} hAlign="center">
            <Heading level={2}>Password updated</Heading>
            <Text type="supporting" size="sm">
              Your password has been changed.
            </Text>
          </VStack>
          <Button
            id="continue-to-bob"
            label={`Continue to ${BRAND.name}`}
            variant="primary"
            size="lg"
            onClick={() => window.location.assign(window.location.origin)}
          />
        </VStack>
      </ResetCard>
    );
  }

  return (
    <ResetCard>
      <form onSubmit={(e) => void submit(e)}>
        <VStack gap={4} hAlign="stretch">
          {error && <Banner status="error" title={error} container="card" />}
          <TextInput
            label="New password"
            type="password"
            size="lg"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            description={PASSWORD_HELPER_TEXT}
          />
          <TextInput
            label="Confirm new password"
            type="password"
            size="lg"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
          <Button
            label={busy ? 'Updating…' : 'Update password'}
            type="submit"
            variant="primary"
            size="lg"
            isLoading={busy}
            isDisabled={busy}
          />
        </VStack>
      </form>
    </ResetCard>
  );
}
