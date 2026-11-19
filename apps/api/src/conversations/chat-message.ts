/**
 * A turn of conversation history: who said it and what. Domain type shared by
 * storage, the agent and the wire contract (schemas.ts re-exports it, so the
 * protocol depends on the domain and not the other way round).
 */
import { z } from 'zod';

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
