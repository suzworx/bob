/**
 * Phone-layout gate (#1349 round 3): the screens table and the in-browser
 * geometry measurement shared by e2e/mobile-layout.e2e.ts and
 * scripts/mobile-sweep.ts. Real layout boxes, never jsdom.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { ChatPage } from './chat-page.ts';
import { prefixedId } from '../../src/lib/ids.ts';

// spanLeft/spanRight: the chat composer card must reach at least this far out. The
// main chat's card measures 20..370 (a 12px inset inside Astryx's 8px composer padding).
export const GUTTER = { min: 14, max: 376, spanLeft: 20, spanRight: 370 };
// The phone composer stacks its top row of actions above the input, with the
// send row below it. Measured 114px on open-chat, space-thread and group-chat
// (MW-COMPOSER-TOP; it was 84 before the actions moved up), so the cap is 114 + 4.
export const COMPOSER_MAX_HEIGHT = 118;
export const LIST_GAP_MAX = 120;

export const ASSERTIONS = ['overflow', 'bounds', 'slashes', 'topBar', 'alerts', 'composer', 'listGap', 'h1', 'reachable', 'inlineMessageActions'] as const;
export type AssertionName = (typeof ASSERTIONS)[number];

/** A control the phone must expose by accessible name. */
export interface ReachableControl { label: string; name: RegExp }
const OPEN_CHAT_CONTROLS: ReachableControl[] = [
  { label: 'Attach (composer top row)', name: /^Attach$/ },
  { label: 'Mention (composer top row)', name: /^Mention Bob, people or features$/ },
  { label: 'Tools (composer top row)', name: /^Tools$/ },
  { label: 'More actions (per message)', name: /^(more actions|message actions)$/i },
];

export interface Fixtures {
  page: Page;
  api: APIRequestContext;
  tag: string;
  seed: { memory: (content: string) => Promise<string>; space: () => Promise<string> };
  cleanup: (undo: () => Promise<unknown>) => void;
}

export interface Screen {
  label: string;
  path: string;
  /** docs/design/images/bob-mobile-v4 file (no extension) to put beside the sweep screenshot. */
  mockup?: string;
  /** A list page: the gap from the top bar to the first item is checked. */
  list?: boolean;
  /** A chat screen: the composer is checked. */
  chat?: boolean;
  /** Controls that must be reachable by accessible name (the `reachable` assertion). */
  reachable?: ReachableControl[];
  /** The drawer: measured inside the Navigation dialog instead of main. */
  drawer?: boolean;
  /** Replaces the plain goto(path): seeds data, sends a message, opens the drawer. */
  setup?: (fx: Fixtures) => Promise<void>;
}

/** A group space with one thread and one message sent now: it is a conversation on today's timeline. */
async function seedThread({ api, tag, cleanup }: Fixtures): Promise<{ spaceId: string; threadId: string }> {
  const space = await api.post('/api/spaces', { data: { kind: 'group', name: `Sweep ${tag}` } });
  const spaceId = ((await space.json()) as { id: string }).id;
  cleanup(async () => { await api.delete(`/api/spaces/${spaceId}`); });
  const thread = await api.post(`/api/spaces/${spaceId}/threads`, { data: { title: `Thread ${tag}` } });
  const threadId = ((await thread.json()) as { id: string }).id;
  await api.post(`/api/threads/${threadId}/messages`, { data: { body: 'Hello from the sweep.', client_message_id: `${tag}-sweep` } });
  return { spaceId, threadId };
}

async function openThread(fx: Fixtures): Promise<void> {
  const { spaceId, threadId } = await seedThread(fx);
  await fx.page.goto(`/spaces/${prefixedId('space', spaceId)}/conversations/${prefixedId('conversation', threadId)}`);
}

/** A private chat copied into a group chat, the way chat-group.e2e.ts builds one (two messages: the latest per sender gets the menu). */
async function openGroupChat({ page, api, tag, cleanup }: Fixtures): Promise<void> {
  const source = await api.post('/api/chat', { data: { message: { id: `msg-${tag}`, role: 'user', parts: [{ type: 'text', text: `Group sweep ${tag}` }] } } });
  const conversationId = (await source.text()).match(/"conversationId":"([^"]+)"/)?.[1];
  if (!conversationId) throw new Error('source conversation missing');
  cleanup(async () => { await api.delete(`/api/conversations/${conversationId}`); });
  const group = await api.post('/api/group-chats', { data: { request_id: crypto.randomUUID(), source_conversation_id: conversationId, text_only: true } });
  const groupId = ((await group.json()) as { chat: { id: string } }).chat.id;
  await page.goto(`/groups/${groupId}`);
  await page.getByRole('log').getByText(`Group sweep ${tag}`, { exact: true }).waitFor();
}

export const SCREENS: Screen[] = [
  { label: 'home', path: '/', mockup: '02-chat', chat: true },
  { label: 'today', path: '/today', mockup: '01-today' },
  { label: 'calendar', path: '/calendar', mockup: '05-calendar' },
  {
    label: 'memory', path: '/memory', mockup: '10-memory', list: true,
    setup: async ({ page, seed, tag }) => { await seed.memory(`Sweep fact ${tag}`); await page.goto('/memory'); },
  },
  { label: 'spaces', path: '/spaces', mockup: '14-space', list: true, setup: async ({ page, seed }) => { await seed.space(); await page.goto('/spaces'); } },
  { label: 'devices', path: '/devices', mockup: '18-devices', list: true },
  { label: 'integrations', path: '/integrations', mockup: '25-connectors', list: true },
  { label: 'insights', path: '/insights' },
  { label: 'routines', path: '/routines', list: true },
  {
    label: 'timeline', path: '/timeline', list: true,
    setup: async (fx) => { await seedThread(fx); await fx.page.goto('/timeline'); await fx.page.getByRole('listitem').first().waitFor(); },
  },
  { label: 'apps', path: '/apps', list: true },
  { label: 'tools', path: '/tools', list: true },
  { label: 'settings', path: '/settings', mockup: '22-account' },
  { label: 'settings-usage', path: '/settings#usage', mockup: '24-usage' },
  {
    label: 'open-chat', path: '/', chat: true, reachable: OPEN_CHAT_CONTROLS,
    setup: async ({ page }) => { const chat = new ChatPage(page); await chat.goto(); await chat.send('Hello Bob'); await chat.lastReply().waitFor(); },
  },
  { label: 'space-thread', path: '/spaces', mockup: '16-thread', chat: true, setup: openThread },
  { label: 'group-chat', path: '/chat', chat: true, setup: openGroupChat },
  {
    label: 'drawer', path: '/', drawer: true,
    setup: async ({ page }) => { await page.goto('/'); await page.getByTestId('mobile-nav-toggle').click(); await page.getByRole('dialog', { name: 'Navigation' }).waitFor(); },
  },
];

export interface Measurement {
  /** Assertion name -> human-readable offenders; absent or empty means it passed. */
  failures: Partial<Record<AssertionName, string[]>>;
}

/** Opens the screen and reads every assertion's geometry in one pass. */
export async function measureScreen(screen: Screen, fx: Fixtures): Promise<Measurement> {
  if (screen.setup) await screen.setup(fx);
  else await fx.page.goto(screen.path);
  if (screen.drawer) await fx.page.getByRole('dialog', { name: 'Navigation' }).evaluate((el) => el.setAttribute('data-sweep-root', ''));
  const root = screen.drawer ? '[data-sweep-root]' : 'main, [role="main"]';
  await fx.page.locator(root).first().waitFor();
  await fx.page.waitForTimeout(800);
  const failures = await fx.page.evaluate(
    ({ root, gutter }) => {
      const out: Record<string, string[]> = {};
      const fail = (name: string, text: string): void => { out[name] = [...(out[name] ?? []), text]; };
      const scope = document.querySelector(root) ?? document.body;
      /** The element's box clipped by every scrolling/overflow-hidden ancestor, or null when hidden. */
      const clippers = (el: Element): DOMRect[] => {
        const rects: DOMRect[] = [];
        // From the element itself: a maxLines Text clips its own overflow (ellipsis).
        for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== 'visible') rects.push(a.getBoundingClientRect());
        }
        return rects;
      };
      const box = (el: Element, rect: DOMRect): DOMRect | null => {
        const clips = clippers(el);
        // A clipping box of ~0 size is visually hidden (sr-only).
        if (rect.width < 2 || rect.height < 2 || clips.some((r) => r.width <= 1 || r.height <= 1)) return null;
        const left = Math.max(rect.left, ...clips.map((r) => r.left));
        const right = Math.min(rect.right, ...clips.map((r) => r.right));
        return right - left < 1 ? null : new DOMRect(left, rect.top, right - left, rect.height);
      };
      const shown = (el: Element): boolean => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const check = (base: string, label: string, b: DOMRect, el: Element): void => {
        const name = el.closest('[aria-label="Mobile navigation"]') ? 'topBar' : base;
        if (b.left < gutter.min - 0.5 || b.right > gutter.max + 0.5) fail(name, `${label} x ${Math.round(b.left)}..${Math.round(b.right)}`);
      };
      const scanTextNode = (n: Node): void => {
        const text = (n.textContent ?? '').trim();
        const el = n.parentElement;
        if (!text || !el || !shown(el) || ['SCRIPT', 'STYLE'].includes(el.tagName)) return;
        const range = document.createRange();
        range.selectNodeContents(n);
        const b = box(el, range.getBoundingClientRect());
        if (!b) return;
        if (text.startsWith('//')) fail('slashes', text.slice(0, 40));
        check('bounds', `text "${text.slice(0, 30)}"`, b, el);
      };
      const scanText = (): void => {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) scanTextNode(n);
      };
      const controls = 'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="combobox"],[role="textbox"],[role="tab"],[role="switch"]';
      const scanControls = (): void => {
        for (const el of scope.querySelectorAll(controls)) {
          const b = shown(el) ? box(el, el.getBoundingClientRect()) : null;
          if (b) check('bounds', `<${el.tagName.toLowerCase()}> "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`, b, el);
        }
      };
      const scanAlerts = (): void => {
        for (const alert of document.querySelectorAll('[role="alert"]')) {
          const text = (alert.textContent ?? '').trim();
          if (shown(alert) && text) fail('alerts', text.slice(0, 80));
        }
      };
      if (document.documentElement.scrollWidth > innerWidth) fail('overflow', `scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}`);
      for (const scan of [scanText, scanControls, scanAlerts]) scan();
      return out;
    },
    { root, gutter: GUTTER },
  );
  const result = mergeFailures(failures, await measureStructure(fx.page, root, screen)) as Measurement['failures'];
  const missing = await missingControls(fx.page, screen.reachable ?? []);
  if (missing.length) result.reachable = missing.map((control) => `no control named "${control.label}"`);
  return { failures: result };
}

/** The phone must expose these controls by accessible name (Playwright, not in-page). */
async function missingControls(page: Page, controls: ReachableControl[]): Promise<ReachableControl[]> {
  const counts = await Promise.all(controls.map((control) => page.getByRole('button', { name: control.name }).count()));
  return controls.filter((_, i) => counts[i] === 0);
}

function mergeFailures(a: Record<string, string[]>, b: Record<string, string[]>): Record<string, string[]> {
  const merged = { ...a };
  for (const [name, texts] of Object.entries(b)) merged[name] = [...(merged[name] ?? []), ...texts];
  return merged;
}

interface StructureArgs { root: string; spec: { chat: boolean; list: boolean; seeded: boolean }; gutter: typeof GUTTER; composerMax: number; gapMax: number }

/** Page structure: document overflow, inner scrollers, the h1, the composer card and the first list row. */
async function measureStructure(page: Page, root: string, screen: Screen): Promise<Record<string, string[]>> {
  const args: StructureArgs = { root, spec: { chat: Boolean(screen.chat), list: Boolean(screen.list), seeded: Boolean(screen.setup) }, gutter: GUTTER, composerMax: COMPOSER_MAX_HEIGHT, gapMax: LIST_GAP_MAX };
  return page.evaluate(({ root, spec, gutter, composerMax, gapMax }: StructureArgs) => {
    const out: Record<string, string[]> = {};
    const fail = (name: string, text: string): void => { out[name] = [...(out[name] ?? []), text]; };
    const scope = document.querySelector(root) ?? document.body;
    const label = (el: Element): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
    /** The nearest bordered or shadowed ancestor of the input: the composer card. */
    const composerCard = (input: Element | null): Element | null => {
      for (let a = input, i = 0; a && i < 6; a = a.parentElement, i += 1) {
        const s = getComputedStyle(a);
        if (s.borderTopWidth !== '0px' || s.boxShadow !== 'none') return a;
      }
      return null;
    };
    const scanComposer = (): void => {
      const input = scope.querySelector('textarea, [role="textbox"], [role="combobox"]');
      const r = (composerCard(input) ?? scope.querySelector('[aria-label="Message composer"]') ?? input)?.getBoundingClientRect();
      if (!r) return fail('composer', 'no composer found');
      const outside = r.left < gutter.min - 0.5 || r.right > gutter.max + 0.5;
      // It must also span the gutter (16..374), not merely stay inside it: a doubled inset leaves it at 36..354.
      const narrow = r.left > gutter.spanLeft + 0.5 || r.right < gutter.spanRight - 0.5;
      if (r.height > composerMax || outside || narrow) fail('composer', `${Math.round(r.width)}x${Math.round(r.height)} at x ${Math.round(r.left)}..${Math.round(r.right)}`);
    };
    /** The composer's buttons above its input: the top row. The send row below the input is not checked here. */
    const topRowButtons = (): HTMLButtonElement[] => {
      const card = scope.querySelector('.astryx-chat-composer');
      if (!card) return [];
      const inputTop = card.querySelector('textarea, [role="textbox"], [role="combobox"]')?.getBoundingClientRect().top ?? Infinity;
      return [...card.querySelectorAll('button')].filter((button) => button.checkVisibility() && button.getBoundingClientRect().bottom <= inputTop);
    };
    const ellipsized = (button: HTMLElement): boolean =>
      /…|\.\.\./.test(button.textContent ?? '') || [button, ...button.querySelectorAll('*')].some((el) => getComputedStyle(el).textOverflow === 'ellipsis');
    /** Phone: a top-row button is at least 28px square (Astryx size="sm", which ChatComposer headerActions asks for), inside the card, and its label is not truncated. */
    const topRowProblems = (button: HTMLButtonElement, card: DOMRect): string[] => {
      const b = button.getBoundingClientRect();
      const name = `<button> "${label(button)}"`;
      const inside = b.left >= card.left && b.right <= card.right && b.top >= card.top && b.bottom <= card.bottom;
      return [
        Math.min(b.width, b.height) < 28 ? `${name} ${Math.round(b.width)}x${Math.round(b.height)}, under 28px` : '',
        inside ? '' : `${name} outside the composer card`,
        ellipsized(button) ? `${name} truncated` : '',
      ].filter(Boolean);
    };
    const scanTopRow = (): void => {
      const card = scope.querySelector('.astryx-chat-composer')?.getBoundingClientRect();
      if (!card) return;
      const buttons = topRowButtons();
      if (buttons.length < 3) fail('composer', `top row has ${buttons.length} buttons, expected at least Attach, Mention and Voice mode`);
      for (const problem of buttons.flatMap((button) => topRowProblems(button, card))) fail('composer', problem);
    };
    /** The first row of the first list in main: header links and GroupedList actions are not rows. */
    const firstRow = (): Element | null => {
      for (const list of scope.querySelectorAll('ul, ol, [role="list"]')) {
        if (list.closest('[aria-label="Mobile navigation"], header, nav')) continue;
        const row = list.querySelector(':scope > li, :scope > [role="listitem"]');
        if (row) return row;
      }
      return null;
    };
    const seeded = spec.seeded;
    const scanList = (): void => {
      const bar = document.querySelector('[aria-label="Mobile navigation"]');
      const item = firstRow();
      // A screen that seeds its own row must show it; an unseeded one may be empty.
      if (bar && !item && seeded) return fail('listGap', 'no list item');
      if (!bar || !item) return;
      const gap = item.getBoundingClientRect().top - bar.getBoundingClientRect().bottom;
      if (gap > gapMax) fail('listGap', `${Math.round(gap)}px from the top bar to the first item`);
    };
    const scrollsSideways = (el: Element): boolean => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1;
    /** An inner horizontal scroller hides content off-screen; code blocks and tables may scroll. */
    const scanScrollers = (): void => {
      for (const el of scope.querySelectorAll('*')) {
        if (el.closest('pre, code, table') || !scrollsSideways(el) || !el.checkVisibility()) continue;
        fail('overflow', `inner scroller <${el.tagName.toLowerCase()}> "${label(el)}" ${el.scrollWidth} > ${el.clientWidth}`);
      }
    };
    const scanH1 = (): void => {
      const count = document.querySelectorAll('h1, [role="heading"][aria-level="1"]').length;
      if (count !== 1) fail('h1', `${count} level-1 headings, expected exactly 1`);
    };
    if (document.documentElement.scrollWidth > innerWidth) fail('overflow', `scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}`);
    scanScrollers();
    scanH1();
    /** On a phone message actions live in the "More actions" menu, never as inline buttons. */
    const scanInlineActions = (): void => {
      for (const el of scope.querySelectorAll('button[aria-label]')) {
        const name = el.getAttribute('aria-label') ?? '';
        if (/^(Copy message|Copy response|Copied|Edit this message|Edit and resend this message|Delete this message)$/.test(name) && el.checkVisibility() && el.getBoundingClientRect().width > 1) fail('inlineMessageActions', `inline "${name}"`);
      }
    };
    if (spec.chat) { scanComposer(); scanTopRow(); scanInlineActions(); }
    if (spec.list) scanList();
    return out;
  }, args);
}
