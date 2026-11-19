import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { BobAppDefinitionSchema } from '../../src/bob-apps/schemas.ts';
import { authoringFixtures } from './authoring-fixtures.ts';
// Explicit opt-in: deterministic boundary tests never spend model tokens.
it.skipIf(process.env.BOB_APPS_LIVE_EVAL !== '1')('measures synthetic model creation and repair, without persisting apps', async () => {
  const { chatModel, refuseProductionKey } = await import('@bob/ai');
  refuseProductionKey();
  const measurements: { family: number; repair: boolean; valid: boolean; latencyMs: number; inputTokens: number; outputTokens: number; cost: unknown }[] = [];
  for (const family of [0, 1, 2, 3]) {
    const fixture = authoringFixtures[family * 8];
    if (!fixture) throw new Error('missing_fixture');
    for (const repair of [false, true]) {
      let valid = false;
      const agent = new ToolLoopAgent({ model: chatModel, stopWhen: stepCountIs(3), tools: {
        propose_bob_app: tool({ description: 'Submit a valid declarative app definition. No executable code or external schedules.', inputSchema: z.strictObject({ definition: BobAppDefinitionSchema }), execute: async ({ definition }) => { valid = BobAppDefinitionSchema.safeParse(definition).success; return { ok: valid }; } }),
      } });
      const start = performance.now();
      const result = await agent.generate({ prompt: fixture.request + (repair ? ` Repair this invalid draft (remove executable code and repair missing references): ${JSON.stringify({ ...(fixture.definition as object), code: 'forbidden', metrics: [{ id: 'bad', table: 'missing', operation: 'count' }] })}` : '') + ' Call propose_bob_app with the finished definition.', abortSignal: AbortSignal.timeout(90000) });
      measurements.push({ family, repair, valid, latencyMs: Math.round(performance.now() - start), inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0, cost: result.providerMetadata?.gateway?.cost ?? null });
    }
  }
  console.info(JSON.stringify({ bobAppAuthoringBaseline: measurements }));
  expect(measurements.filter((result) => result.valid)).toHaveLength(8);
}, 720000);
