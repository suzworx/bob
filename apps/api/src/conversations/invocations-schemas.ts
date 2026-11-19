import { z } from 'zod';
import { ChatAppBindingSchema } from './schemas.ts';

/** Targeting only. The workflow authorizes a bound app against the current thread. */
export const CreateInvocationRequestSchema = z.strictObject({
  trigger_message_id: z.uuid(),
  appBinding: ChatAppBindingSchema.optional(),
});
