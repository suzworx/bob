// A tab open across a deploy still holds the old entry chunk, whose lazy page chunks are gone from the server.
// Vite fires `vite:preloadError` when such a dynamic import fails; one reload fetches the new build.
const RELOAD_KEY = 'bob.staleReloadAt';
// A second failure inside this window means the server is really down, not that the build is stale.
const RELOAD_WINDOW_MS = 10_000;

const CHUNK_LOAD_MESSAGES = [
  'Failed to fetch dynamically imported module', // Chrome, Edge
  'Importing a module script failed', // Safari
  'error loading dynamically imported module', // Firefox
];

export interface ReloadHost {
  addEventListener(type: 'vite:preloadError', listener: (event: Event) => void): void;
  removeEventListener(type: 'vite:preloadError', listener: (event: Event) => void): void;
  sessionStorage: Storage;
  location: { reload(): void };
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}

export function isChunkLoadError(error: unknown): boolean {
  const message = messageOf(error);
  return CHUNK_LOAD_MESSAGES.some((known) => message.includes(known));
}

// True when a reload is allowed now and its timestamp is recorded. Storage can throw (private mode); without a
// recorded timestamp the loop guard cannot work, so an unreadable or unwritable store means no reload.
function claimReload(win: ReloadHost, now: number): boolean {
  try {
    const last = Number(win.sessionStorage.getItem(RELOAD_KEY));
    if (last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    win.sessionStorage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

// Returns a function that removes the listener again.
export function installStaleBuildReload(win: ReloadHost = window): () => void {
  const onPreloadError = (event: Event): void => {
    // Left unhandled, the original error still reaches the app's error boundary.
    if (!claimReload(win, Date.now())) return;
    event.preventDefault();
    win.location.reload();
  };
  win.addEventListener('vite:preloadError', onPreloadError);
  return () => win.removeEventListener('vite:preloadError', onPreloadError);
}
