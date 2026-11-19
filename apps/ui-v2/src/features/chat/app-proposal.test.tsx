import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { MessageView } from './message-view';
import { starterApp } from '@/features/bob-apps/app-starters';
import type { BobApp } from '@/features/bob-apps/bob-apps-api';

const network = vi.hoisted(() => ({ request: vi.fn<typeof fetch>() }));
vi.mock('@/lib/auth/use-session', async (original) => ({
  ...(await original<typeof import('@/lib/auth/use-session')>()),
  fetchWithAuth: network.request,
}));

const appId = '95ded76c-0518-4318-9c98-6ee566beed45';
const app: BobApp = {
  id: appId, installationId: '81144f0d-fb29-4dd5-a325-e5cfe1ce7771', spaceId: null,
  canManage: true, revision: 3, lifecycle: 'draft', createdAt: 1793491200000, updatedAt: 1793491200000,
  definition: { ...starterApp('checklist'), title: 'Trip checklist' }, state: {}, metrics: {},
  pendingDefinition: null, canUndo: false,
};
const proposal = {
  ok: true, untrusted: true,
  data: { id: appId, title: 'Trip checklist', status: 'draft', revision: 3, url: `/apps/${appId}`, requiresApply: false },
};
function tool(toolName: string, output: unknown): UIMessage['parts'][number] {
  return { type: 'dynamic-tool', toolName, toolCallId: `call-${toolName}`, state: 'output-available', input: {}, output };
}
function message(parts: UIMessage['parts']): UIMessage { return { id: 'proposal-reply', role: 'assistant', parts }; }
function Harness({ value }: { value: UIMessage }): ReactElement {
  return <Theme theme={neutralTheme}><MessageView message={value} isStreaming={false} mentionTokens={[]} /></Theme>;
}
function VersionedProposal(): ReactElement {
  const [active, onSelect] = useState(1);
  return <Theme theme={neutralTheme}><MessageView
    message={message([tool('propose_bob_app', proposal), { type: 'text', text: 'A trip checklist.' }])}
    isStreaming={false} mentionTokens={[]} versions={{ texts: ['A simple reminder.', 'A trip checklist.'], active, onSelect }} />
  </Theme>;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function writes(): Array<Parameters<typeof fetch>> {
  return network.request.mock.calls.filter(([, options]) => options?.method === 'PATCH');
}

beforeEach(() => {
  network.request.mockReset();
  network.request.mockImplementation(async (_url, options) => json({ app: options?.method === 'PATCH' ? { ...app, lifecycle: 'active', revision: 4 } : app }));
});
afterEach(cleanup);

describe('personal app proposal acceptance in the existing message view', () => {
  it.each(['direct', 'specialist', 'incomplete-specialist'] as const)('accepts a verified %s proposal only after an explicit tap', async (kind) => {
    const user = userEvent.setup();
    const part = kind === 'direct' ? tool('propose_bob_app', proposal)
      : tool('apps_agent', { ok: kind === 'specialist', ...(kind === 'specialist' ? { summary: 'Here is your checklist.' } : { error: 'specialist_incomplete' }), receipts: [{ tool: 'propose_bob_app', output: proposal }] });
    render(<Harness value={message([part])} />);
    const accept = await screen.findByRole('button', { name: 'Use this app' });
    expect(network.request).toHaveBeenCalledWith(`/api/bob-apps/${appId}`, expect.anything());
    expect(writes()).toHaveLength(0);
    await user.click(accept);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const command = JSON.parse(String(writes()[0]?.[1]?.body)) as Record<string, unknown>;
    expect(command).toEqual({ operation: 'activate', expectedRevision: 3, mutationId: expect.any(String) });
    expect(writes()[0]?.[0]).toBe(`/api/bob-apps/${appId}`);
  });

  it.each([
    ['assistant prose', [{ type: 'text', text: `Use this app: /apps/${appId}` }]],
    ['another tool', [tool('create_note', proposal)]],
    ['failed proposal', [tool('propose_bob_app', { ok: false, data: proposal.data })]],
    ['malformed identity', [tool('propose_bob_app', { ...proposal, data: { ...proposal.data, id: 'not-an-app-id' } })]],
    ['invented link', [tool('propose_bob_app', { ...proposal, data: { ...proposal.data, url: 'https://invented.example/app' } })]],
    ['failed nested write', [tool('apps_agent', { ok: true, receipts: [{ tool: 'propose_bob_app', output: { ok: false, data: proposal.data } }] })]],
  ] satisfies Array<[string, UIMessage['parts']]>)('does not turn %s into an acceptance command', (_name, parts) => {
    render(<Harness value={message(parts)} />);
    expect(screen.queryByRole('button', { name: 'Use this app' })).toBeNull();
    expect(network.request).not.toHaveBeenCalled();
  });

  it('does not grant personal acceptance when the live app belongs to a group', async () => {
    network.request.mockResolvedValue(json({ app: { ...app, spaceId: '7dab9e1f-6455-4ce6-95d1-d2124591997a', canManage: false } }));
    render(<Harness value={message([tool('propose_bob_app', proposal)])} />);
    await waitFor(() => expect(network.request).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Use this app' })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('does not accept an old proposal after its saved app changed', async () => {
    network.request.mockResolvedValue(json({ app: { ...app, revision: 4, definition: { ...app.definition, title: 'A teammate changed this' } } }));
    render(<Harness value={message([tool('propose_bob_app', proposal)])} />);
    await waitFor(() => expect(network.request).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Use this app' })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('keeps a post-read conflict for review instead of automatically retrying acceptance', async () => {
    const user = userEvent.setup();
    network.request.mockImplementation(async (_url, options) => options?.method === 'PATCH'
      ? json({ error: 'revision_conflict' }, 409) : json({ app }));
    render(<Harness value={message([tool('propose_bob_app', proposal)])} />);
    await user.click(await screen.findByRole('button', { name: 'Use this app' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(writes()).toHaveLength(1);
  });

  it('reuses the acceptance command identity after a lost response and an explicit retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    network.request.mockImplementation(async (_url, options) => {
      if (options?.method !== 'PATCH') return json({ app });
      attempts += 1;
      if (attempts === 1) throw new TypeError('Network response was lost');
      return json({ app: { ...app, lifecycle: 'active', revision: 4 } });
    });
    render(<Harness value={message([tool('propose_bob_app', proposal)])} />);
    await user.click(await screen.findByRole('button', { name: 'Use this app' }));
    await screen.findByRole('alert');
    expect(writes()).toHaveLength(1);
    await user.click(await screen.findByRole('button', { name: /^(Use this app|Try again|Retry)$/ }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(String(writes()[1]?.[1]?.body))).toEqual(JSON.parse(String(writes()[0]?.[1]?.body)));
  });

  it('hides the current proposal acceptance while an older reply version is selected', async () => {
    const user = userEvent.setup();
    render(<VersionedProposal />);
    await screen.findByRole('button', { name: 'Use this app' });
    await user.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByText('A simple reminder.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this app' })).toBeNull();
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Next version' }));
    await screen.findByRole('button', { name: 'Use this app' });
  });
});
