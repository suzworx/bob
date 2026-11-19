import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ToolsPage } from './tools-page';
vi.mock('./tool-controls', () => ({ ToolControls: ({ context }: { context: { conversationId?: string } }) => <output>{context.conversationId ?? 'Account'}</output> }));
it('changes scope on query-only browser navigation without reloading the page', async () => {
  window.history.replaceState(null, '', '/tools?conversationId=cnv_one');
  render(<ToolsPage />);
  expect(screen.getByText('cnv_one')).toBeTruthy();
  await act(async () => { window.history.pushState(null, '', '/tools?conversationId=cnv_two'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(screen.queryByText('cnv_one')).toBeNull();
  expect(screen.getByText('cnv_two')).toBeTruthy();
});
