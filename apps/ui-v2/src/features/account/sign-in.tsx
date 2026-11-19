import { BRAND } from '@/lib/brand';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { isAuthApiError, isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Heading } from '@astryxdesign/core/Heading';
import { Link } from '@astryxdesign/core/Link';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { getSupabaseSetup, SIGN_IN_UNAVAILABLE_MESSAGE, type AuthSetup } from '@/lib/auth/supabase-client';
import { signInDev } from '@/lib/auth/use-session';
import { WAITLIST_URL } from './waitlist';

// Astryx TextInput (0.6.2) leaves inputMode off its props but forwards a ref to the
// native input: the code field asks phones for the number keypad through it.
function numericKeypad(input: HTMLInputElement | null): void {
  input?.setAttribute('inputmode', 'numeric');
}

// The neutral message for anything unrecognised, and for a wrong password: it
// never hints whether the email is known.
const NEUTRAL_SIGN_IN_ERROR = 'Sign-in failed. Check your details and try again.';
// An empty or malformed field is a local check, not a provider outcome, so it
// can be precise: it says nothing about whether an account exists.
const EMAIL_REQUIRED_MESSAGE = 'Enter your email address first.';
const EMAIL_INVALID_MESSAGE = 'Enter a valid email address, like you@example.com.';
const CODE_REQUIRED_MESSAGE = 'Enter the 6-digit code from your email.';

// The shape check from the Astryx Login SSO template: something@domain.tld, no spaces.
function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function emailProblem(value: string): string | null {
  if (!value) return EMAIL_REQUIRED_MESSAGE;
  return isValidEmail(value) ? null : EMAIL_INVALID_MESSAGE;
}

type InputStatus = { type: 'error'; message: string } | undefined;
const fieldStatus = (message: string | null): InputStatus =>
  message === null ? undefined : { type: 'error', message };

type Operation = 'send' | 'verify' | 'password';
type Failure = 'rate-limited' | 'bad-code' | 'network' | 'neutral';
// 'ok' also covers sending a code to an address with no account: no email
// arrives, and the screen answers exactly as it does for a real one.
type Outcome = 'ok' | Failure;

const FAILURE_MESSAGES: Record<Exclude<Failure, 'rate-limited'>, string> = {
  'bad-code': 'That code is wrong or has expired. Request a new code.',
  network: "Couldn't reach the sign-in service. Check your connection and try again.",
  neutral: NEUTRAL_SIGN_IN_ERROR,
};

const RATE_LIMIT_EMAIL_CAP_MESSAGE =
  'Too many sign-in emails were sent recently. Use a code you already received, try again later, or sign in with your password.';
const RATE_LIMIT_GENERIC_MESSAGE = 'Too many attempts. Wait a few minutes, then try again.';

const RATE_LIMIT_CODES = new Set(['over_email_send_rate_limit', 'over_request_rate_limit']);
const NO_ACCOUNT_CODES = new Set(['otp_disabled', 'signup_disabled', 'user_not_found']);

// Supabase reuses over_email_send_rate_limit for two different limits and tells
// them apart only by message: the per-address cooldown names its seconds, the
// project-wide hourly email cap does not. The message is parsed, never shown.
function rateLimitMessage(error: unknown): string {
  if (!isAuthApiError(error)) return RATE_LIMIT_GENERIC_MESSAGE;
  const waitSeconds = /after (\d+) seconds?/i.exec(error.message)?.[1];
  if (waitSeconds !== undefined) {
    const seconds = Number.parseInt(waitSeconds, 10);
    return `Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'}, then request a new code.`;
  }
  return error.code === 'over_email_send_rate_limit' ? RATE_LIMIT_EMAIL_CAP_MESSAGE : RATE_LIMIT_GENERIC_MESSAGE;
}

function failureMessage(failure: Failure, error: unknown): string {
  return failure === 'rate-limited' ? rateLimitMessage(error) : FAILURE_MESSAGES[failure];
}

// Maps a provider error (returned or thrown) to what the screen may say. Only the
// status and code decide the outcome; the provider's own message is read solely to
// tell rate limits apart (rateLimitMessage) and never reaches the screen.
function classifyAuthError(operation: Operation, error: unknown): Outcome {
  if (error instanceof TypeError || isAuthRetryableFetchError(error)) return 'network';
  if (!isAuthApiError(error)) return 'neutral';
  if (error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code))) return 'rate-limited';
  if (operation === 'verify' && (error.code === 'otp_expired' || error.status === 403)) return 'bad-code';
  if (operation === 'send' && (error.status === 422 || (error.code !== undefined && NO_ACCOUNT_CODES.has(error.code)))) {
    return 'ok';
  }
  return 'neutral';
}

type AuthShellProps = { subtitle: string; children: ReactNode; backHome?: ReactNode };

function BobAuthShell({ subtitle, children, backHome }: AuthShellProps): ReactElement {
  const isNarrow = useMediaQuery('(max-width: 639px)');
  // Login Split: 24px page gutter, 32px desktop inset and gap. The 16px
  // mobile inset leaves a 240px track at 320px. Below 640px the art precedes the form.
  return (
    <Center axis="both" padding={6} minHeight="100dvh">
      <VStack gap={4} width="100%" maxWidth={1000}>
        {backHome}
        <Card padding={isNarrow ? 4 : 8} width="100%">
          <Grid columns={isNarrow ? 1 : { minWidth: 240, repeat: 'fit' }} gap={8} align="center">
            <VStack gap={4} hAlign="center">
              <img src="/brand/bob/bob-playful.webp" width={isNarrow ? 160 : 240} height={isNarrow ? 160 : 240} alt="Bob waving hello" />
              <VStack gap={1} hAlign="center">
                <Heading level={1} justify="center">Hello again, friend.</Heading>
                <Text color="secondary" justify="center">A little help. A little brighter day.</Text>
              </VStack>
            </VStack>
            <VStack gap={4} hAlign="stretch" width="100%">
              <VStack gap={1}>
                <Heading level={2}>Sign in to Bob</Heading>
                <Text color="secondary" size="sm">{subtitle}</Text>
              </VStack>
              {children}
            </VStack>
          </Grid>
        </Card>
      </VStack>
    </Center>
  );
}

function AuthShell({ subtitle, children, backHome }: AuthShellProps): ReactElement {
  return <BobAuthShell subtitle={subtitle} backHome={backHome}>{children}</BobAuthShell>;
}

// Resolves the shared Supabase setup once on mount; null while it is in flight.
function useAuthSetup(): AuthSetup | null {
  const [setup, setSetup] = useState<AuthSetup | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSupabaseSetup().then((next) => {
      if (!cancelled) setSetup(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return setup;
}

// Local-only path: the server advertises the loopback test issuer, so sign in
// without Supabase or Docker. On success the session store flips the app gate.
function DevSignIn(): ReactElement {
  const [failed, setFailed] = useState(false);
  const handleSignIn = async (): Promise<void> => {
    setFailed(false);
    if (!(await signInDev())) setFailed(true);
  };
  return (
    <VStack gap={4} hAlign="stretch">
      <Text type="supporting" size="sm">
        Local development build — sign in without Supabase or Docker.
      </Text>
      {failed && <Banner status="error" title={NEUTRAL_SIGN_IN_ERROR} container="card" />}
      <Button label="Dev sign-in (local only)" variant="primary" size="lg" clickAction={handleSignIn} />
    </VStack>
  );
}

const RESET_EMAIL_REQUIRED = 'Enter your email address first.';
const RESET_SENT_MESSAGE = 'Check your email for a password reset link.';

type Mode = 'code' | 'code-sent' | 'password' | 'reset-request';

function signInSubtitle(mode: Mode): string {
  if (mode === 'password') return 'Sign in with your password.';
  if (mode === 'reset-request') return 'We’ll email you a password reset link.';
  return mode === 'code-sent' ? 'Enter the code from your email.' : 'We’ll email you a sign-in code.';
}

function SignInActions({ children }: { children: ReactNode }): ReactElement {
  return <HStack gap={2} wrap="wrap">{children}</HStack>;
}

// The email one-time-code flow (one email carries both the code and a magic
// link) with a password alternative. Success needs no handling here: the
// session store's auth-state listener flips the app gate.
function ReadySignIn({ client, backHome }: { client: SupabaseClient; backHome?: ReactNode }): ReactElement {
  // /?reset=1 (from an expired reset link) opens straight on "Send reset link".
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).get('reset') === '1' ? 'reset-request' : 'code',
  );
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Local checks show on their field instead of the banners, and clear both
  // banners so a stale "check your email" never sits beside an error.
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const showFieldError = (field: 'email' | 'code', message: string): void => {
    setError(null);
    setNotice(null);
    if (field === 'email') setEmailError(message);
    else setCodeError(message);
  };

  // True when the email is well formed; otherwise flags the field.
  const checkEmail = (): boolean => {
    const problem = emailProblem(email.trim());
    if (problem !== null) showFieldError('email', problem);
    return problem === null;
  };

  // Runs one provider call and returns how it went. A returned or thrown error
  // is classified (see classifyAuthError) and its safe message is shown.
  const attempt = async (
    operation: Operation,
    call: () => PromiseLike<{ error: unknown }>,
  ): Promise<Outcome> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setEmailError(null);
    setCodeError(null);
    let outcome: Outcome = 'ok';
    let cause: unknown;
    try {
      const { error: authError } = await call();
      if (authError) {
        cause = authError;
        outcome = classifyAuthError(operation, authError);
      }
    } catch (thrown) {
      cause = thrown;
      outcome = classifyAuthError(operation, thrown);
    }
    setBusy(false);
    if (outcome !== 'ok') setError(failureMessage(outcome, cause));
    return outcome;
  };

  const sendCode = async (): Promise<void> => {
    if (!checkEmail()) return;
    const outcome = await attempt('send', () =>
      client.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
      }),
    );
    if (outcome === 'ok') {
      setCode('');
      setNotice('Check your email for a sign-in code or a magic link.');
      setMode('code-sent');
    } else if (outcome === 'rate-limited') {
      // Nothing was sent, but an earlier email still carries a valid code: go to
      // code entry with the rate-limit message (already set) instead of the notice.
      setMode('code-sent');
    }
  };

  // Straight to code entry for a code that already arrived; nothing is sent.
  const haveCode = (): void => {
    if (busy) return;
    if (!checkEmail()) return;
    setError(null);
    setNotice(null);
    setCode('');
    setMode('code-sent');
  };

  const verifyCode = async (): Promise<void> => {
    if (code.trim().length < 6) {
      showFieldError('code', CODE_REQUIRED_MESSAGE);
      return;
    }
    await attempt('verify', () => client.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' }));
  };

  const passwordSignIn = async (): Promise<void> => {
    if (!email.trim() || !password) {
      setError(NEUTRAL_SIGN_IN_ERROR);
      return;
    }
    await attempt('password', () => client.auth.signInWithPassword({ email: email.trim(), password }));
  };

  const clearMessages = (): void => {
    setError(null);
    setNotice(null);
    setEmailError(null);
    setCodeError(null);
  };

  const toggleMode = (): void => {
    setMode((prev) => (prev === 'password' ? 'code' : 'password'));
    clearMessages();
  };

  const goBackFromReset = (): void => {
    setMode('code');
    setError(null);
    setNotice(null);
  };

  const requestReset = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError(RESET_EMAIL_REQUIRED);
      return;
    }
    setBusy(true);
    // A rejection (network error) is the same neutral failure as a provider
    // error, and busy always clears so the button never sticks.
    try {
      const { error: resetError } = await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset`,
      });
      if (resetError) {
        setError(NEUTRAL_SIGN_IN_ERROR);
        return;
      }
      setNotice(RESET_SENT_MESSAGE);
    } catch {
      setError(NEUTRAL_SIGN_IN_ERROR);
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = (): void => {
    setMode('reset-request');
    clearMessages();
  };

  if (mode === 'reset-request') {
    const run = (): void => {
      if (!busy) void requestReset();
    };
    return (
      <AuthShell subtitle={signInSubtitle(mode)} backHome={backHome}>
        {error && <Banner status="error" title={error} container="card" />}
        {notice && <Banner status="info" title={notice} container="card" />}
        <TextInput
          label="Email"
          type="email"
          size="lg"
          value={email}
          onChange={setEmail}
          onEnter={run}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Button label="Send reset link" variant="primary" size="lg" isLoading={busy} onClick={run} />
        <Button label="Back to sign in" variant="ghost" onClick={goBackFromReset} />
      </AuthShell>
    );
  }

  const submit = mode === 'password' ? passwordSignIn : mode === 'code-sent' ? verifyCode : sendCode;
  const submitLabel = mode === 'password' ? 'Sign in with password' : mode === 'code-sent' ? 'Verify' : 'Send code';
  const run = (): void => {
    if (!busy) void submit();
  };
  const resend = (): void => {
    if (!busy) void sendCode();
  };

  return (
    <AuthShell
      backHome={backHome}
      subtitle={signInSubtitle(mode)}
    >
      {error && <Banner status="error" title={error} container="card" />}
      {notice && <Banner status="info" title={notice} container="card" />}
      <TextInput
        label="Email"
        type="email"
        size="lg"
        value={email}
        onChange={(value) => {
          setEmail(value);
          setEmailError(null);
        }}
        onEnter={run}
        placeholder="you@example.com"
        autoComplete="email"
        status={fieldStatus(emailError)}
      />
      {mode === 'code-sent' && (
        <TextInput
          label="Six-digit code"
          size="lg"
          ref={numericKeypad}
          value={code}
          onChange={(value) => {
            setCode(value.replace(/\D/g, '').slice(0, 6));
            setCodeError(null);
          }}
          status={fieldStatus(codeError)}
          onEnter={run}
          placeholder="000000"
          autoComplete="one-time-code"
        />
      )}
      {mode === 'password' && (
        <TextInput
          label="Password"
          type="password"
          size="lg"
          value={password}
          onChange={setPassword}
          onEnter={run}
          autoComplete="current-password"
        />
      )}
      <Button label={submitLabel} variant="primary" size="lg" isLoading={busy} onClick={run} />
      <SignInActions>
        {mode === 'code-sent' && <Button label="Send a new code" variant="ghost" onClick={resend} />}
        {mode === 'code' && <Button label="I have a code" variant="ghost" onClick={haveCode} />}
        <Button label={mode === 'password' ? 'Use a code instead' : 'Use password'} variant="ghost" onClick={toggleMode} />
        {mode === 'password' && <Button label="Forgot password?" variant="ghost" onClick={handleForgotPassword} />}
      </SignInActions>
      <Text type="supporting" size="sm">
        {BRAND.name} is invite-only. No account yet? <Link href={WAITLIST_URL} isExternalLink>Join the waitlist</Link>
      </Text>
    </AuthShell>
  );
}

const DEFAULT_SUBTITLE = 'Sign in to continue to your conversations.';

/**
 * The signed-out surface. `unavailable` is the "server not configured for
 * sign-in" message the session store surfaces when /api/public-config cannot be
 * fetched; it is shown in place of the form.
 */
export function SignIn({ unavailable, backHome }: { unavailable: string | null; backHome?: ReactNode }): ReactElement {
  const setup = useAuthSetup();
  if (setup === null) {
    return (
      <AuthShell subtitle={DEFAULT_SUBTITLE} backHome={backHome}>
        <Center axis="both" padding={4}>
          <Spinner aria-label="Loading sign-in" />
        </Center>
      </AuthShell>
    );
  }
  if (setup.devSignIn) {
    return (
      <AuthShell subtitle={DEFAULT_SUBTITLE} backHome={backHome}>
        <DevSignIn />
      </AuthShell>
    );
  }
  if (setup.status === 'ready') return <ReadySignIn client={setup.client} backHome={backHome} />;
  return (
    <AuthShell subtitle={DEFAULT_SUBTITLE} backHome={backHome}>
      <Banner status="warning" title={unavailable ?? SIGN_IN_UNAVAILABLE_MESSAGE} container="card" />
    </AuthShell>
  );
}
