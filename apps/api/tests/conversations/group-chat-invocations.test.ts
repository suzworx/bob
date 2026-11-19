import { createAppTurnExtension } from '../../src/bob-apps/app-turn-extension.ts';
import { saveAppIdea } from '../../src/workflows/workflow-app-idea.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentHarness, type AgentHarness } from '../support/agent-harness.ts';
import type { Db } from '../../src/platform/db/db.ts';

const mocks = vi.hoisted(() => ({
  space: vi.fn(), claim: vi.fn(), messages: vi.fn(), post: vi.fn(), state: vi.fn(),
  tasks: vi.fn(), agenda: vi.fn(), factory: vi.fn(),
}));
vi.mock('../../src/spaces/store.ts', () => ({ getSpace: mocks.space }));
vi.mock('../../src/conversations/invocations-store.ts', () => ({
  claimInvocation: mocks.claim, setInvocationState: mocks.state, InvocationBusyError: class extends Error {},
}));
vi.mock('../../src/conversations/thread-store.ts', () => ({
  listMessages: mocks.messages, postAssistantMessage: mocks.post,
  ThreadAudienceChangedError: class extends Error {},
}));
vi.mock('../../src/tasks/store.ts', async (orig) => ({ ...(await orig<typeof import('../../src/tasks/store.ts')>()), listTasks: mocks.tasks }));
vi.mock('../../src/calendar/store.ts', async (orig) => ({ ...(await orig<typeof import('../../src/calendar/store.ts')>()), listAgenda: mocks.agenda }));
vi.mock('../../src/tools/policy.ts', () => ({ prepareToolPolicyFilter: async () => (tools: unknown) => tools }));
vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()), createBobAgent: mocks.factory,
  traceSpan: async (_name: string, _attrs: unknown, action: () => Promise<unknown>) => action(),
}));
import { runInvocation } from '../../src/workflows/workflow-thread-invocation.ts';
import { ThreadAudienceChangedError } from '../../src/conversations/thread-store.ts';

const context = { actorUserId: 'actor', spaceId: 'space', threadId: 'chat', triggerMessageId: 'trigger', contextHighWater: 1 };
const db = {} as Db;
let harness: AgentHarness;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.space.mockResolvedValue({ kind: 'group', membershipRevision: 1, conversationId: 'chat' });
  mocks.claim.mockResolvedValue({ claimed: true, invocation: { id: 'invocation' } });
  mocks.messages.mockResolvedValue({ messages: [{ authorUserId: 'actor', body: 'shared text', sequence: 1, tombstonedAt: null }], nextCursor: null });
  mocks.post.mockResolvedValue({ id: 'reply' });
  mocks.tasks.mockResolvedValue([]); mocks.agenda.mockResolvedValue([]);
  harness = createAgentHarness([[{ type: 'text', text: 'reply' }]]);
  vi.spyOn(harness.agent, 'generate');
  mocks.factory.mockReturnValue(harness.agent);
});
describe('conversation-only Bob invocation', () => {
  it('reads only shared history and offers no productivity, private integration or memory tools', async () => {
    await runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db });
    expect(mocks.tasks).not.toHaveBeenCalled();
    expect(mocks.agenda).not.toHaveBeenCalled();
    expect(harness.agent.generate).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'shared text' }] });
    expect(mocks.factory).toHaveBeenCalledWith(expect.objectContaining({ memoryTools: {} }));
    expect(Object.keys(mocks.factory.mock.calls[0]?.[0].capabilityTools)).toEqual(['list_space_members']);
  });
  it('fails closed before model work when membership is unavailable', async () => {
    mocks.space.mockRejectedValue(new Error('not_found'));
    await expect(runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db })).rejects.toThrow('not a member');
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.factory).not.toHaveBeenCalled();
  });
  it('does not commit a reply when membership is revoked during generation', async () => {
    mocks.post.mockRejectedValueOnce(new ThreadAudienceChangedError());
    const result = await runInvocation(context, { appTurnTools: createAppTurnExtension(saveAppIdea), db });
    expect(result).toMatchObject({ outcome: 'cancelled', resultMessageId: null });
    expect(mocks.post).toHaveBeenCalledWith(db, context.actorUserId,
      { threadId: context.threadId, spaceId: context.spaceId, expectedMembershipRevision: 1 }, 'invocation', 'reply');
    expect(mocks.state).toHaveBeenCalledWith(db, context.actorUserId, 'invocation', 'cancelled');
  });
});


