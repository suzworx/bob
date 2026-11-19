import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { MessageView } from './message-view';

const savedWeek = {
  ok: true, untrusted: true,
  data: { receipt: { kind: 'campaign.week_plan', campaignId: '39be9e3e-fc1b-4a45-a84f-13279d8ae7ea', draftId: null, revision: 1 },
    postCount: 7, url: '/apps/95ded76c-0518-4318-9c98-6ee566beed45' },
};
function tool(toolName: string, output: unknown): UIMessage['parts'][number] {
  return { type: 'dynamic-tool', toolName, toolCallId: `call-${toolName}`, state: 'output-available', input: {}, output };
}
function Harness({ part, streaming = false }: { part: UIMessage['parts'][number]; streaming?: boolean }): ReactElement {
  return <Theme theme={neutralTheme}><MessageView message={{ id: 'week-reply', role: 'assistant', parts: [part] }} isStreaming={streaming} mentionTokens={[]} /></Theme>;
}
afterEach(cleanup);

describe('a finished week acknowledgement comes from saved tool receipts', () => {
  it.each(['direct', 'specialist', 'incomplete-specialist'] as const)('acknowledges a verified %s week write once', (kind) => {
    const part = kind === 'direct' ? tool('save_week_plan', savedWeek)
      : tool('marketing_agent', { ok: kind === 'specialist', receipts: [{ tool: 'save_week_plan', output: savedWeek }],
        ...(kind === 'specialist' ? { summary: 'Saved.' } : { error: 'specialist_incomplete' }) });
    render(<Harness part={part} />);
    expect(screen.getAllByText('Your week is ready to review.')).toHaveLength(1);
    expect(screen.getByText('Your week is ready to review.').closest('[role="status"]')).toBeTruthy();
  });

  it.each([
    ['failed write', tool('save_week_plan', { ok: false, error: 'marketing_unavailable' })],
    ['seven existing rows', tool('list_drafts', { ok: true, untrusted: true, data: { items: Array.from({ length: 7 }, (_, index) => ({ id: `draft-${index}` })) } })],
    ['wrong receipt kind', tool('save_week_plan', { ...savedWeek, data: { ...savedWeek.data, receipt: { ...savedWeek.data.receipt, kind: 'draft.create' } } })],
    ['missing saved identity', tool('save_week_plan', { ...savedWeek, data: { ...savedWeek.data, receipt: { ...savedWeek.data.receipt, campaignId: null } } })],
    ['out-of-contract count', tool('save_week_plan', { ...savedWeek, data: { ...savedWeek.data, postCount: 8 } })],
    ['failed specialist receipt', tool('marketing_agent', { ok: true, receipts: [{ tool: 'save_week_plan', output: { ok: false, data: savedWeek.data } }] })],
  ] satisfies Array<[string, UIMessage['parts'][number]]>)('does not celebrate %s', (_name, part) => {
    render(<Harness part={part} />);
    expect(screen.queryByText('Your week is ready to review.')).toBeNull();
  });

  it('waits until the turn finishes, even when its saved receipt already arrived', () => {
    render(<Harness part={tool('save_week_plan', savedWeek)} streaming />);
    expect(screen.queryByText('Your week is ready to review.')).toBeNull();
  });
});
