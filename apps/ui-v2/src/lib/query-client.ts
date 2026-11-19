import { QueryClient } from '@tanstack/react-query';

/** An error that carries the HTTP status that produced it, so retry policies
 *  can separate a 4xx (the app's own rejection; retrying cannot succeed) from
 *  a transient failure. */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Query keys for threads data, centralised so a later hook cannot collide
 *  with this one's keys by accident. The account id is the FIRST segment: the
 *  cache is namespaced per reader, so one signed-in account can never be served
 *  another account's cached threads (or their unread counts) on a shared
 *  browser. */
export const threadKeys = {
  list: (accountId: string | null, spaceId: string | null) =>
    ['threads', 'list', accountId, spaceId] as const,
  messages: (accountId: string | null, threadId: string | null) =>
    ['threads', 'messages', accountId, threadId] as const,
};

/** Drop every cached thread entry for one account. Called when the signed-in
 *  reader changes or signs out, so a departing reader's data does not linger in
 *  memory for the next one. */
export function clearAccountThreadQueries(client: QueryClient, accountId: string | null): void {
  client.removeQueries({ queryKey: ['threads', 'list', accountId] });
  client.removeQueries({ queryKey: ['threads', 'messages', accountId] });
}

/** The app-wide QueryClient defaults. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A chat app: stale data is worse than a refetch, so data goes stale fast.
        staleTime: 5_000,
        // Never retry a 4xx: the server has already decided; retry only transient failures.
        retry: (failureCount, error) => {
          if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 3;
        },
        // Deliberate: returning to the window should surface new messages.
        refetchOnWindowFocus: true,
      },
    },
  });
}