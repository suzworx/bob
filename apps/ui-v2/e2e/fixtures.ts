/**
 * #550 fixtures. Every spec gets:
 *  - one page object per page (signInPage, chatPage, calendarPage,
 *    memoryPage, devicesPage; e2e/pages/);
 *  - `tag`: a per-test marker put in every title it creates, so nothing it
 *    makes can be confused with anyone else's data;
 *  - `api`: the REST API as the signed-in dev user (the web page's bearer);
 *  - `cleanup(step)`: registers an undo for something the test created. The
 *    steps run after the test, newest first, pass or fail; a failing undo
 *    fails the test, so leftovers are never silent;
 *  - `seed`: makes the data a spec reads through the real API (or local SQL
 *    where no API exists) and registers its undo; every spec seeds what it
 *    reads, because the run's account starts empty (fresh-state.e2e.ts);
 *  - `makeAxeBuilder()`: an axe scan limited to the WCAG 2.x A/AA rules.
 * Specs only ever delete what they registered here.
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CalendarPage } from './pages/calendar-page.ts';
import { ChatPage } from './pages/chat-page.ts';
import { DevicesPage } from './pages/devices-page.ts';
import { MemoryPage } from './pages/memory-page.ts';
import { SignInPage } from './pages/sign-in-page.ts';
import { AUTH_FILE, BASE_URL, runLocalSql, runTag, sqlText } from './stack.ts';

interface StoredState {
  origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
}

/** The access token supabase-js saved in the setup project's session. */
function savedAccessToken(): string {
  const state = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as StoredState;
  for (const origin of state.origins ?? []) {
    for (const item of origin.localStorage ?? []) {
      if (!/^sb-.+-auth-token$/.test(item.name)) continue;
      const token = (JSON.parse(item.value) as { access_token?: unknown }).access_token;
      if (typeof token === 'string' && token.length > 0) return token;
    }
  }
  throw new Error(`no Supabase session in ${AUTH_FILE}; did the setup project run?`);
}

/** The `sub` claim of a JWT: the dev user's id. */
function tokenSubject(token: string): string {
  const payload = token.split('.')[1] ?? '';
  const sub = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
  if (typeof sub !== 'string') throw new Error('session token has no subject');
  return sub;
}

type Undo = () => Promise<unknown>;

export type MemoryKind = 'fact' | 'action_item';

/** Test data made for one test and undone after it, pass or fail. */
export interface Seed {
  /** A memory through POST /api/memories; deleted after. Returns its id. */
  memory: (content: string, kind?: MemoryKind) => Promise<string>;
  /**
   * The account's private Space, made the way the product makes it: a first
   * chat turn (web-chat.ts ensurePrivateSpace), whose conversation is then
   * deleted. The Space stays, as after any first conversation. Returns its id.
   */
  space: () => Promise<string>;
  /** A running timer row (no API creates one); deleted after. Returns its id. */
  timer: (label: string, minutes: number) => Promise<string>;
}

interface Fixtures {
  signInPage: SignInPage;
  chatPage: ChatPage;
  calendarPage: CalendarPage;
  memoryPage: MemoryPage;
  devicesPage: DevicesPage;
  tag: string;
  api: APIRequestContext;
  userId: string;
  cleanup: (undo: Undo) => void;
  seed: Seed;
  makeAxeBuilder: () => AxeBuilder;
}

export const test = base.extend<Fixtures>({
  signInPage: async ({ page }, use): Promise<void> => use(new SignInPage(page)),
  chatPage: async ({ page }, use): Promise<void> => use(new ChatPage(page)),
  calendarPage: async ({ page }, use): Promise<void> => use(new CalendarPage(page)),
  memoryPage: async ({ page }, use): Promise<void> => use(new MemoryPage(page)),
  devicesPage: async ({ page }, use): Promise<void> => use(new DevicesPage(page)),
  tag: async ({}, use): Promise<void> => use(runTag()),
  api: async ({ playwright }, use): Promise<void> => {
    const context = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${savedAccessToken()}` },
    });
    await use(context);
    await context.dispose();
  },
  userId: async ({}, use): Promise<void> => use(tokenSubject(savedAccessToken())),
  cleanup: async ({}, use): Promise<void> => {
    const undos: Undo[] = [];
    await use((undo) => {
      undos.push(undo);
    });
    const failures: unknown[] = [];
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} cleanup step(s) failed`);
  },
  seed: async ({ api, userId, cleanup }, use): Promise<void> => {
    const spaceIds = async (): Promise<string[]> => {
      const response = await api.get('/api/spaces');
      await ok('list spaces', response);
      return ((await response.json()) as { spaces: Array<{ id: string }> }).spaces.map((space) => space.id);
    };
    await use({
      memory: async (content, kind = 'fact') => {
        const created = await api.post('/api/memories', { data: { content, kind } });
        await ok(`create ${kind} memory`, created);
        const { id } = (await created.json()) as { id: string };
        cleanup(async () => ok('delete memory', await api.delete(`/api/memories/${id}`)));
        return id;
      },
      space: async () => {
        const existing = (await spaceIds())[0];
        if (existing) return existing;
        const turn = await api.post('/api/chat', {
          data: { message: { id: `msg-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: 'hello' }] } },
        });
        await ok('first chat turn', turn);
        const conversationId = (await turn.text()).match(/"conversationId":"([^"]+)"/)?.[1];
        if (conversationId) await ok('delete conversation', await api.delete(`/api/conversations/${conversationId}`));
        const made = (await spaceIds())[0];
        if (!made) throw new Error('a first chat turn made no Space');
        return made;
      },
      timer: async (label, minutes) => {
        const id = randomUUID();
        cleanup(async () => runLocalSql(`delete from bob.reminders where id = ${sqlText(id)};
`));
        const owner = sqlText(userId);
        runLocalSql(
          `insert into bob.spaces (id, kind, name, owner_user_id) values (gen_random_uuid(), 'private', 'Private', ${owner}) ` +
            `on conflict (owner_user_id) where kind = 'private' do nothing;
`,
        );
        runLocalSql(
          `insert into bob.space_memberships (space_id, user_id, role) select id, owner_user_id, 'owner' from bob.spaces ` +
            `where kind = 'private' and owner_user_id = ${owner} on conflict (space_id, user_id) do nothing;
`,
        );
        runLocalSql(
          `insert into bob.reminders (id, space_id, created_by, kind, title, due_at, due_zone, duration_ms, status) values ` +
            `(${sqlText(id)}, (select id from bob.spaces where kind = 'private' and owner_user_id = ${owner}), ${owner}, 'timer', ` +
            `${sqlText(label)}, now() + interval '${minutes} minutes', 'UTC', ${minutes * 60_000}, 'pending');
`,
        );
        return id;
      },
    });
  },
  makeAxeBuilder: async ({ page }, use): Promise<void> =>
    use(() => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])),
});

export { expect };

/** Fails loudly on any non-2xx answer, naming the call. */
export async function ok(what: string, response: { ok(): boolean; status(): number; text(): Promise<string> }): Promise<void> {
  if (!response.ok()) throw new Error(`${what} failed (${response.status()}): ${await response.text()}`);
}

/** Runs an axe scan and fails on any serious or critical violation, listing each one. */
export async function expectNoSeriousA11yViolations(builder: AxeBuilder): Promise<void> {
  const results = await builder.analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}
