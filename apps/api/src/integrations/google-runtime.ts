import { z } from 'zod';
import type { Db } from '../platform/db/db.ts';
import { createGoogleBridge } from './google-bridge.ts';
import { createGoogleConnectionService } from './google-connection-service.ts';
import { createGoogleCalendarService } from './google-calendar-service.ts';
import { createGmailService } from './google-gmail-service.ts';
import { createGmailActionsService } from './google-mail-actions-service.ts';
import { createGoogleMailActionsClient } from './google-mail-actions-client.ts';
import { createGoogleAgendaService } from './google-agenda-service.ts';
import { createGoogleTools, type GoogleTurnTools } from './google-tools.ts';
import { createRoutineTools } from '../routines/tools.ts';

const configSchema = z.object({
  BOB_GOOGLE_BRIDGE_URL: z.url(),
  BOB_GOOGLE_BRIDGE_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  BOB_GOOGLE_CLIENT_ID: z.string().max(256).regex(/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/),
  BOB_GOOGLE_CALLBACK_URLS: z.string().transform(value => value.split(',').map(url => url.trim())).pipe(z.array(z.url()).min(1).max(10)),
  BOB_GOOGLE_NATIVE_CALLBACK_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
});
const keys = Object.keys(configSchema.shape);

interface GoogleRuntime {
  calendar: Pick<ReturnType<typeof createGoogleCalendarService>, 'listCalendars' | 'listEvents'>;
  gmail: Pick<ReturnType<typeof createGmailService>, 'search' | 'readThread'>;
  connection: ReturnType<typeof createGoogleConnectionService>;
  agenda: ReturnType<typeof createGoogleAgendaService>;
  tools: GoogleTurnTools;
}

/** Production composition is dormant without configuration. A partially
 * configured deployment fails at startup with no values in its error. */
export function createGoogleRuntime(
  getDb: () => Promise<Db>, env: Record<string, string | undefined> = process.env,
): GoogleRuntime | undefined {
  if (keys.every((key) => !env[key])) return undefined;
  try {
    const config = configSchema.parse(env);
    // Each operation resolves the root handle independently; never capture a
    // request transaction, because provider markers/receipts must commit first.
    const db: Db = {
      query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => (await getDb()).query<T>(sql, params),
      tx: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => (await getDb()).tx(fn),
    };
    const bridge = createGoogleBridge({ url: config.BOB_GOOGLE_BRIDGE_URL, secret: config.BOB_GOOGLE_BRIDGE_SECRET });
    const connection = createGoogleConnectionService({ db, bridge,
      clientId: config.BOB_GOOGLE_CLIENT_ID, callbackUrls: config.BOB_GOOGLE_CALLBACK_URLS,
      nativeCallbackUrl: config.BOB_GOOGLE_NATIVE_CALLBACK_URL });
    const calendar = createGoogleCalendarService({ db, resolveCredential: connection.resolve });
    const gmail = createGmailService({ db, resolveCredential: connection.resolve });
    const mailActions = createGmailActionsService({ db, client: createGoogleMailActionsClient(), resolveCredential: connection.resolve });
    const agenda = createGoogleAgendaService({ db, calendar });
    const tools: GoogleTurnTools = async (context) => ({
      ...await createGoogleTools({ ...context, db, calendar, gmail, mailActions, getVerifiedCapabilities: connection.capabilities }),
      ...await createRoutineTools({ ...context, db, getVerifiedCapabilities: connection.capabilities }),
    });
    return { connection, agenda, tools, gmail: { search: gmail.search, readThread: gmail.readThread },
      calendar: { listCalendars: calendar.listCalendars, listEvents: calendar.listEvents } };

  } catch {
    throw new Error('google_runtime_configuration_invalid');
  }
}
