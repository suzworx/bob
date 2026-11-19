import { z } from 'zod';

export const PushRegistrationSchema = z.object({
  installation_id: z.string().uuid(),
  token: z.string().regex(/^(?:[a-fA-F0-9]{2}){32,256}$/).transform((value) => value.toLowerCase()),
  environment: z.enum(['sandbox', 'production']),
  topic: z.string().regex(/^[a-zA-Z0-9.-]{1,120}$/),
  app_version: z.string().trim().min(1).max(40),
  local_timer_ids: z.array(z.string().uuid()).max(60).default([]),
}).strict();
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;
export const PushRegisteredSchema = z.object({ registered: z.literal(true), delivery_available: z.boolean() }).strict();
export const PushDeviceParamsSchema = z.object({ installationId: z.string().uuid() }).strict();
