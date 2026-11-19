import { createBobAgent } from '@bob/ai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreateBobAgentOptions } from '@bob/ai/testing';
import type { Tool } from 'ai';
import type { Db } from '../../src/platform/db/db.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import { setJournalSink } from '../../src/platform/logger.ts';
import { createAgentHarness } from '../support/agent-harness.ts';
import { generateReply } from '../../src/voice/turn/generate.ts';
import { prepareToolPolicyFilter } from '../../src/tools/policy.ts';

vi.mock('../../src/voice/turn/context.ts', async original => ({
 ...await original<typeof import('../../src/voice/turn/context.ts')>(),
 buildAgentMessages: vi.fn(async () => [{role:'user',content:'hello'}]),
}));
vi.mock('../../src/voice/turn/tools.ts', () => ({
 buildTurnCapabilities: vi.fn(async () => ({ capabilityTools: {}, spaceContext:null,scope:'space',spaceMs:0,game:null })),
 googleTurnTools: vi.fn(async () => ({})),
 appTurnTools: vi.fn(async () => ({})),
}));
vi.mock('../../src/tools/policy.ts', () => ({ prepareToolPolicyFilter: vi.fn(async () => (tools: Record<string,Tool>) => tools) }));
vi.mock('@bob/ai', async original => ({ ...await original<typeof import('@bob/ai')>(), withTraceContext: (_attrs: unknown, run: () => unknown) => run() }));
let lines: string[];
beforeEach(() => { lines=[]; setJournalSink(line => lines.push(line)); vi.clearAllMocks(); });
afterEach(() => setJournalSink(null));
function fixture() {
 const captured: CreateBobAgentOptions[]=[];
 const base=vi.fn(() => createAgentHarness([[{type:'text',text:'unsafe fallback'}]]).agent);
 const create=vi.fn((options: CreateBobAgentOptions) => { captured.push(options); return createAgentHarness([[{type:'text',text:'hello'}]]).agent; });
 const deps={agent:{base,create}} as unknown as TurnDeps;
 return {captured,base,create,deps};
}
it('resolves shared device references before reading conversation policy', async () => {
 const f=fixture(); const session=createSession(); const id='d4e68e09-3c39-4bd3-a74b-567f4f45b001';
 session.activeConversationId=`thr_${id}`;
 const db={} as Db;
 await generateReply(f.deps,session,'hello','turn', {db,userId:'owner',memoryOn:false,timeZone:'UTC',conversation:{conversationId:id,spaceId:'space',spaceKind:'group',spaceName:'Group',spaceArchived:false,archivedAt:null,title:'Chat'}});
 expect(prepareToolPolicyFilter).toHaveBeenCalledWith(db,'owner',{conversationId:id});
 expect(f.base).not.toHaveBeenCalled();
});
it('offers and journals zero tools when policy storage is unavailable', async () => {
 const f=fixture();
 await generateReply(f.deps,createSession(),'hello','turn',null);
 // The degraded row supplies the no-tools variant (TURN_PROFILES, spec 015 U3).
 expect(f.captured[0]?.mode).toBe('device_degraded');
 expect(Object.keys(createBobAgent(f.captured[0] as CreateBobAgentOptions).tools)).toEqual([]);
 const event=lines.map(line => JSON.parse(line) as Record<string,unknown>).find(line => line.event==='v2.agent_tools');
 expect(event?.tools).toBe('');
 expect(f.base).not.toHaveBeenCalled();
});
it('never calls an unfiltered singleton when safe agent construction fails', async () => {
 const f=fixture(); f.create.mockImplementation(() => {throw new Error('unavailable');});
 await expect(generateReply(f.deps,createSession(),'hello','turn',null)).rejects.toThrow('unavailable');
 expect(f.base).not.toHaveBeenCalled();
});
