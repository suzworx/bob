import { expect, it } from 'vitest';
import { z } from 'zod';
import { BobAppDefinitionSchema } from '../../src/bob-apps/schemas.ts';
import { authoringFixtures } from './authoring-fixtures.ts';
it('keeps at least forty synthetic boundary fixtures', () => expect(authoringFixtures.length).toBeGreaterThanOrEqual(40));
it.each(authoringFixtures)('deterministic definition boundary $id (not model quality)', ({ definition, valid }) => {
  expect(BobAppDefinitionSchema.safeParse(definition).success).toBe(valid);
});
it('exports the authoring shape to provider JSON schema', () => {
  const schema = z.toJSONSchema(z.strictObject({ definition: BobAppDefinitionSchema }));
  expect(schema.type).toBe('object');
  expect(schema.additionalProperties).toBe(false);
});
