/**
 * #565 U7: the Cardputer pointed at a space thread, end to end. A fake
 * Cardputer (support/fake-cardputer.ts) pairs to the suite's own API and two
 * tabs of the same account watch it: the web moves the pointer onto a thread,
 * the device talks in it and both tabs see the turn live, the device's picker
 * moves the pointer away and back, and archiving the thread sends the next
 * turn to a new General conversation. STT and the agent are stubbed.
 * Skipped on a found stack: the fake device only ever pairs to the suite's API.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, ok, test as base } from './fixtures.ts';
import { ThreadPage } from './pages/thread-page.ts';
import { FakeCardputer, pairFakeCardputer, type DeviceMessage, type PairedCardputer } from './support/fake-cardputer.ts';
import { AUTH_FILE, BASE_URL, E2E_API_PORT, FOUND_BASE_URL, runLocalSql, sqlText } from './stack.ts';

/** The stub STT's transcript and the stub agent's answer to it (apps/ai, AI_STUB_MODE). */
const TRANSCRIPT = 'system test transcript';
const REPLY = /^System test response: .*system test transcript/;

/** The run account's bearer, from the setup project's saved session. */
function webBearer(): string {
  const state = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as { origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }> };
  const item = state.origins?.flatMap((origin) => origin.localStorage ?? []).find((entry) => /^sb-.+-auth-token$/.test(entry.name));
  if (!item) throw new Error(`no Supabase session in ${AUTH_FILE}`);
  return (JSON.parse(item.value) as { access_token: string }).access_token;
}

const test = base.extend<{ device: FakeCardputer }, { paired: PairedCardputer }>({
  // One pairing per worker (pair_request is rate limited); revoked when the worker ends.
  paired: [async ({ playwright }, use) => {
    const api = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Authorization: `Bearer ${webBearer()}` } });
    const paired = await pairFakeCardputer(E2E_API_PORT, async (userCode) => {
      const lookup = await api.post('/api/pair/lookup', { data: { user_code: userCode } });
      await ok('pair lookup', lookup);
      const { pairing_id } = (await lookup.json()) as { pairing_id: string };
      await ok('pair approve', await api.post('/api/pair/approve', { data: { pairing_id, name: 'E2E Cardputer' } }));
    });
    await use(paired);
    await ok('revoke device', await api.delete(`/api/devices/${paired.deviceId}`));
    await api.dispose();
  }, { scope: 'worker' }],
  device: async ({ paired }, use) => {
    const device = await FakeCardputer.connect(E2E_API_PORT, paired.token);
    await device.hello();
    await use(device);
    await device.close();
  },
});

const pointsAt = (id: string) => (message: DeviceMessage): boolean => message.payload.id === id;

test.describe('Cardputer thread pointer', () => {
  test.skip(Boolean(FOUND_BASE_URL), 'a found stack may have a real Cardputer; the fake one pairs only to the suite API');

  test('a thread on the Cardputer: pointer, live turn, picker and archive', async ({ page, context, api, tag, userId, cleanup, device }) => {
    // a. A space with a thread (API), and a General conversation for the picker.
    const space = await api.post('/api/spaces', { data: { kind: 'group', name: `Pointer ${tag}` } });
    await ok('create space', space);
    const spaceId = ((await space.json()) as { id: string }).id;
    cleanup(async () => ok('archive space', await api.delete(`/api/spaces/${spaceId}`)));
    const threadTitle = `Thread ${tag}`;
    const thread = await api.post(`/api/spaces/${spaceId}/threads`, { data: { title: threadTitle } });
    await ok('create thread', thread);
    const threadRef = `thr_${((await thread.json()) as { id: string }).id}`;
    const threadId = threadRef.slice(4);
    const generalTitle = `General ${tag}`;
    const generalId = `conv_${randomBytes(8).toString('hex')}`;
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${generalId}`)));
    runLocalSql(`insert into bob.conversations (id, user_id, title) values (${sqlText(generalId)}, ${sqlText(userId)}, ${sqlText(generalTitle)});\n`);

    const tabA = new ThreadPage(page);
    const tabB = new ThreadPage(await context.newPage());
    await tabA.goto(spaceId, threadId);
    await tabB.goto(spaceId, threadId);
    // Both tabs must hear live events before anything moves: an account event
    // (the Cardputer's Space, which step b sets anyway) until both streams answer.
    await expect.poll(async () => {
      await ok('set active space', await api.put('/api/devices/active-space', { data: { space_id: spaceId } }));
      return tabA.eventsLive && tabB.eventsLive;
    }).toBe(true);

    // b. "Use on Cardputer" from the thread's row menu: the device is told the space and the thread.
    let since = device.mark();
    await tabA.useOnCardputerFromRow(threadTitle);
    await device.waitFor('active_space', pointsAt(spaceId), since);
    await device.waitFor('active_conversation', pointsAt(threadRef), since);
    // The title bar now shows "On <device>" instead of offering the button.
    for (const tab of [tabA, tabB]) {
      await expect(tab.onCardputerHere()).toBeVisible();
    }

    // c. The device's picker lists the thread; the device takes one voice turn in it.
    since = device.mark();
    device.send('list_conversations');
    const listed = (await device.waitFor('conversations', undefined, since)).payload.conversations;
    expect(listed).toContainEqual({ id: threadRef, title: threadTitle });
    expect(listed).toContainEqual({ id: generalId, title: generalTitle });
    await device.voiceTurn();

    // d. Both tabs show the device's message and Bob's reply live, without a reload.
    for (const tab of [tabB, tabA]) {
      await expect(tab.message(TRANSCRIPT)).toBeVisible();
      await expect(tab.message(REPLY)).toBeVisible();
    }

    // e. The device picks the General conversation: both tabs show the pointer left the thread.
    since = device.mark();
    device.send('select_conversation', { conversation_id: generalId });
    await device.waitFor('conversation_selected', (message) => message.payload.conversation_id === generalId, since);
    for (const tab of [tabA, tabB]) {
      await expect(tab.onCardputerHere()).toHaveCount(0);
      await expect(tab.useOnCardputerButton()).toBeVisible();
    }

    // f. Back on the thread from the picker, then tab A archives it: the next turn lands in a new
    //    General conversation and the device is told which.
    since = device.mark();
    device.send('select_conversation', { conversation_id: threadRef });
    await device.waitFor('conversation_selected', (message) => message.payload.conversation_id === threadRef, since);
    await tabA.archive(threadTitle);
    since = device.mark();
    await device.voiceTurn();
    const moved = await device.waitFor('active_conversation', (message) => {
      const id = message.payload.id;
      return typeof id === 'string' && !id.startsWith('thr_') && id !== generalId;
    }, since);
    const newId = String(moved.payload.id);
    cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${newId}`)));
    const detail = await api.get(`/api/conversations/${newId}`);
    await ok('read new conversation', detail);
    expect(await detail.text()).toContain(TRANSCRIPT);

    expect(device.violations).toEqual([]);
  });
});
