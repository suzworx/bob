import { BRAND } from '@/lib/brand';
import { Component, lazy, Suspense, type ReactElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Theme } from '@astryxdesign/core/theme';
import { LucideProvider } from 'lucide-react';
import { useSession } from '@/lib/auth/use-session';
import { SpacesProvider } from '@/features/spaces/use-spaces';
import { createQueryClient } from '@/lib/query-client';
import { CommandPalette } from '../features/chat/command-palette';
import { navigateTo, routeFromPath, useLocationPath } from './routes';
import { SignIn } from '../features/account/sign-in';
import { Shell } from './shell';
import { isChunkLoadError } from './stale-build';
import { useActiveTheme, useThemeChoice } from './theme-choice';

// Pages split out of the entry chunk; each module is fetched on first visit.
const InvitePage = lazy(() => import('../features/spaces/invite-page').then((m) => ({ default: m.InvitePage })));
const ResetPage = lazy(() => import('../features/account/reset-page').then((m) => ({ default: m.ResetPage })));

const queryClient = createQueryClient();

function CentredSpinner({ label = 'Loading' }: { label?: string }): ReactElement {
  return (
    <Center axis="both" minHeight="100dvh">
      <Spinner size="lg" aria-label={label} />
    </Center>
  );
}

interface BoundaryState {
  // null while healthy; `stale` is true when a lazy page chunk failed to load (an old build after a deploy).
  failure: { stale: boolean } | null;
}

// Astryx has no ErrorBoundary. Without one, any render error unmounts the whole root and leaves a white screen.
class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: { stale: isChunkLoadError(error) } };
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    return (
      <Center axis="both" minHeight="100dvh">
        <EmptyState
          title={failure.stale ? `A new version of ${BRAND.name} is available` : BRAND.copy.error}
          description={failure.stale ? 'Reload to get it.' : 'Reload the page to try again.'}
          actions={<Button label="Reload" variant="primary" onClick={() => window.location.reload()} />}
        />
      </Center>
    );
  }
}

// The gate order v1 uses. /reset and /invite/<token> come first because a
// visitor on either is often signed out; then loading -> spinner, signed out ->
// sign-in surface, signed in -> the app shell, which renders every page
// (/pair included) inside its navigation.
function SessionGate(): ReactElement {
  const { status, session, unavailable, signOut } = useSession();
  const route = routeFromPath(useLocationPath());
  if (route.kind === 'reset') {
    return (
      <Suspense fallback={<CentredSpinner />}>
        <ResetPage />
      </Suspense>
    );
  }
  if (route.kind === 'invite') {
    return (
      <Suspense fallback={<CentredSpinner />}>
        <InvitePage token={route.token} />
      </Suspense>
    );
  }
  if (status === 'loading') return <CentredSpinner label="Loading session" />;
  if (status === 'signed-out') {
    // A signed-out visitor on a deep route (e.g. /calendar) gets a way back to the
    // chat home, as v1, so they are never stranded on the sign-in surface.
    if (window.location.pathname === '/') return <SignIn unavailable={unavailable} />;
    const backHome = <Button label="Back to home" variant="ghost" onClick={() => navigateTo('/')} />;
    return <SignIn unavailable={unavailable} backHome={backHome} />;
  }
  return (
    <SpacesProvider>
      <Shell session={session} onSignOut={signOut} />
      <CommandPalette />
    </SpacesProvider>
  );
}

export function App(): ReactElement {
  // The stored mode is the Theme's mode (System leaves colour-scheme to the OS); the active option is
  // its theme. The root Theme stamps html[data-theme] and html[data-astryx-theme], which is also how
  // portalled menus and dialogs get the chosen theme.
  const choice = useThemeChoice();
  const active = useActiveTheme();
  // lucide's default stroke of 2 renders 1.33px at Astryx's 16px icon size and looks soft; 1.5 renders exactly 1px
  // there (the Heroicons outline weight the Astryx templates use), and it also covers the theme's built-in lucide icons.
  return (
    <Theme theme={active.theme} mode={choice}>
      {/* The app-wide toast viewport: every useToast() in the app shows here, themed. */}
      <LayerProvider>
        <AppErrorBoundary>
          <LucideProvider strokeWidth={1.5}>
            <QueryClientProvider client={queryClient}>
              <SessionGate />
            </QueryClientProvider>
          </LucideProvider>
        </AppErrorBoundary>
      </LayerProvider>
    </Theme>
  );
}
