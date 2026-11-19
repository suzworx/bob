import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToolControls } from './tool-controls';
import type { ToolCatalog } from './tools-api';
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), owner: 'one' }));
vi.mock('./tools-api', () => ({ getTools: mocks.get, setTool: mocks.set }));
vi.mock('@/lib/auth/use-session', () => ({ useSession: () => ({ session: mocks.owner ? { user: { id: mocks.owner } } : null }) }));
const base: ToolCatalog = { scope: { scope: 'conversation', scopeId: 'cnv_one' }, canEdit: true, tools: [
  { id: 'create_task', toolName: 'create_task', name: 'Create task', description: 'Add something to your task list.', group: 'Productivity', integrationKind: null, availability: 'context_dependent', enabled: true, preference: null, blockedBy: [] },
] };
beforeEach(() => { mocks.owner = 'one'; mocks.get.mockReset().mockResolvedValue(base); mocks.set.mockReset().mockResolvedValue(undefined); });
it('uses confirmed values, saves a disable and resets to inheritance', async () => {
  const disabled: ToolCatalog = { ...base, tools: [{ ...base.tools[0] as ToolCatalog['tools'][number], enabled: false, preference: false, blockedBy: [base.scope] }] };
  render(<ToolControls context={{ conversationId: 'cnv_one' }} />);
  const toggle = await screen.findByRole('switch', { name: 'Create task' });
  mocks.get.mockResolvedValue(disabled);
  await userEvent.click(toggle);
  await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(base.scope, 'create_task', false, expect.any(AbortSignal)));
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  mocks.get.mockResolvedValue(base);
  await userEvent.click(screen.getByRole('button', { name: 'Use inherited setting for Create task' }));
  await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(base.scope, 'create_task', null, expect.any(AbortSignal)));
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
});
it('shows the denying ancestor and cannot turn it back on in a child scope', async () => {
  mocks.get.mockResolvedValue({ ...base, tools: [{ ...base.tools[0], enabled: false, preference: true, blockedBy: [{ scope: 'account', scopeId: 'one' }] }] });
  render(<ToolControls context={{ conversationId: 'cnv_one' }} />);
  const toggle = await screen.findByRole('switch', { name: 'Create task' });
  expect(screen.getAllByText('Turned off for your account. Change that setting first.').length).toBeGreaterThan(0);
  await userEvent.click(toggle);
  expect(mocks.set).not.toHaveBeenCalled();
  expect((toggle as HTMLInputElement).checked).toBe(false);
});
it('never shows enabled defaults after failed loading, and failed save keeps last confirmed off state', async () => {
  mocks.get.mockRejectedValueOnce(new Error('offline'));
  render(<ToolControls />);
  expect(await screen.findByText("Couldn't load these tool settings.")).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  mocks.get.mockResolvedValue({ ...base, tools: [{ ...base.tools[0], enabled: false, preference: false, blockedBy: [base.scope] }] });
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  const toggle = await screen.findByRole('switch', { name: 'Create task' });
  mocks.set.mockRejectedValueOnce(new Error('offline'));
  await userEvent.click(toggle);
  expect(await screen.findByText("Couldn't confirm that change.")).toBeTruthy();
  expect((toggle as HTMLInputElement).checked).toBe(false);
});
it('drops previous owner settings immediately and ignores a late response', async () => {
  const { rerender } = render(<ToolControls />);
  await screen.findByRole('switch');
  mocks.get.mockImplementationOnce(() => new Promise(() => {}));
  mocks.owner = 'two';
  rerender(<ToolControls />);
  expect(screen.queryByRole('switch')).toBeNull();
  await act(async () => {});
});

it('does not fetch tools when signed out and removes previously loaded settings', async () => {
  const { rerender } = render(<ToolControls />);
  await screen.findByRole('switch');
  mocks.get.mockClear();
  mocks.owner = '';
  rerender(<ToolControls />);
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByText('Sign in to choose your tools.')).toBeTruthy();
  expect(mocks.get).not.toHaveBeenCalled();
});
