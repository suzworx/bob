import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { withSpecialists } from '../src/specialists.ts';
import { bobMarketingPack } from '../src/marketing-pack.ts';
import { marketingAgentInstructions, marketingConfigInstructions, marketingToolNames, marketingWriteNames } from '../src/marketing-agent.ts';
import { marketingPhases } from '../src/marketing-skills.ts';

/** Upper bound for one assembled child instruction (rules + phase skill + public pack). About 3,500 tokens. */
const MAX_INSTRUCTION_CHARS = 14000;

describe('Marketing child instructions', () => {
  it('saves requested team feedback without claiming approval or changing posts', () => {
    const text = marketingAgentInstructions('review');
    expect(text).toContain('add_marketing_review_note');
    expect(text).toContain('only the feedback the sender asked to record');
    expect(text).toContain('A saved note does not edit posts or approve the plan');
    expect(text).toContain('never substitute save_plan_section');
    expect(text).toContain('Publishing is not connected');
  });
  it('keeps evidence in metadata and ready-to-post copy free of internal citations', () => {
    const text = marketingAgentInstructions('planning');
    expect(text).toMatch(/claimIds metadata/iu);
    expect(text).toMatch(/never put[^.]*claim IDs[^.]*post body/iu);
    expect(text).not.toContain('Every factual sentence cites a pack claim ID or a retrieved source.');
  });
  it.each(marketingPhases)('%s instructions carry the public pack facts with their IDs and status', (phase) => {
    const text = marketingAgentInstructions(phase);
    expect(text).toContain('early-beta.interest');
    expect(text).toContain('pending-live-verification');
    expect(text).toContain('unknown.price');
    expect(text).toContain('Unknown price is never free');
    expect(text).toContain('bob-playful');
    expect(text).toContain(bobMarketingPack.assets['bob-playful'].sha256);
    expect(text).toMatch(/planned, not available/u);
  });

  it.each(marketingPhases)('%s instructions treat data as untrusted and never grant tools', (phase) => {
    const text = marketingAgentInstructions(phase);
    expect(text).toMatch(/untrusted/iu);
    expect(text).toMatch(/only the tools provided/iu);
    expect(text).not.toMatch(/you may use|you can also use|enable .* tool/iu);
  });

  it.each(marketingPhases)('%s assembled instructions stay within the size bound', (phase) => {
    expect(marketingAgentInstructions(phase).length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
  });

  it('differs by phase only in the phase skill text', () => {
    const [first, second] = marketingPhases;
    expect(marketingAgentInstructions(first)).not.toBe(marketingAgentInstructions(second));
    expect(marketingAgentInstructions(second)).not.toContain(`bob-marketing-${first}`);
  });

  it('never presents a planned capability as available or a waitlist as sign-in', () => {
    const text = marketingAgentInstructions('planning');
    expect(text).toMatch(/waitlist is not sign-in/iu);
    expect(text).toMatch(/interest is not immediate access/iu);
  });
});

describe('Marketing tool groups', () => {
  it('offers exactly the planned Marketing tool names', () => {
    expect([...marketingToolNames].sort()).toEqual([
      'add_marketing_review_note', 'create_campaign', 'list_campaigns', 'list_capabilities', 'list_drafts', 'marketing_context', 'read_campaign',
      'read_draft', 'research_sources', 'save_draft', 'save_plan_section', 'save_week_plan', 'select_campaign', 'update_draft',
    ]);
  });

  it('keeps configuration tools out of the Marketing group', () => {
    expect(marketingToolNames).not.toContain('read_marketing_config');
    expect(marketingToolNames).not.toContain('propose_marketing_config');
  });

  it('marks saved writes as receipts but not reads', () => {
    expect([...marketingWriteNames].sort()).toEqual(['add_marketing_review_note', 'create_campaign', 'save_draft', 'save_plan_section', 'save_week_plan', 'update_draft']);
  });

  it('delegates a note and preserves its verified receipt if the child later fails', async () => {
    const receipt = { kind: 'review.note', installationId: 'installation-1', campaignId: 'campaign-1', noteId: 'note-1' };
    const output = { ok: true, untrusted: true, data: { receipt, url: '/spaces/team/apps?app=marketing' } };
    const received: unknown[] = [];
    const addNote = tool({ inputSchema: z.strictObject({ text: z.string().trim().min(1).max(1000) }),
      execute: async (input) => { received.push(input); return output; } });
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      calls += 1;
      if (calls > 1) throw new Error('provider unavailable after saved note');
      return { content: [{ type: 'tool-call', toolCallId: 'review-note', toolName: 'add_marketing_review_note', input: '{"text":"Make Monday warmer."}' }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
    } });
    const offered = withSpecialists({ add_marketing_review_note: addNote }, model, 'Shared team context.', undefined, { delegates: ['marketing'], shared: true });
    expect(Object.keys(offered)).toEqual(['marketing_agent']);
    const execute = offered.marketing_agent?.execute;
    if (!execute) throw new Error('Missing Marketing delegate');
    const result = await execute({ phase: 'review', task: 'Leave my plan feedback.' }, { toolCallId: 'delegate', messages: [] });
    expect(received).toEqual([{ text: 'Make Monday warmer.' }]);
    expect(result).toMatchObject({ ok: false, error: 'specialist_incomplete', receipts: [{ tool: 'add_marketing_review_note', output }] });
    expect(model.doGenerateCalls[0]?.tools?.map((entry) => entry.name)).toEqual(['add_marketing_review_note']);
    expect(calls).toBe(2);
  });

  it('tells Apps that configuration only edits registered Marketing views and defaults', () => {
    const text = marketingConfigInstructions;
    expect(text).toMatch(/registered Marketing views/u);
    expect(text).toMatch(/read first/iu);
    expect(text).toMatch(/pending proposal/iu);
    expect(text).toMatch(/Apply/u);
    expect(text).toMatch(/cannot author code, grants or publishing/iu);
  });
});
