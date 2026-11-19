import { z } from 'zod';

const ToolScopeSchema = z.enum(['account', 'integration', 'space', 'conversation']);
const ContextId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const ToolContextSchema = z.object({ integrationId: z.uuid().optional(), spaceId: z.uuid().optional(), conversationId: ContextId.optional() }).strict();
export type ToolContext = z.infer<typeof ToolContextSchema>;
export const ToolPreferenceSchema = z.object({ scope: ToolScopeSchema, scopeId: ContextId.optional(), toolId: z.string().min(1).max(80), enabled: z.boolean().nullable() }).strict().superRefine((value, ctx) => {
  if (value.scope !== 'account' && !value.scopeId) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'Choose a scope.' });
  if (value.scopeId && value.scope !== 'conversation' && !z.uuid().safeParse(value.scopeId).success) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'Invalid scope.' });
});
export type ToolPreference = z.infer<typeof ToolPreferenceSchema>;
const ToolScopeRefSchema = z.object({ scope: ToolScopeSchema, scopeId: z.string() });
export type ToolScopeRef = z.infer<typeof ToolScopeRefSchema>;
export const ToolCatalogResponseSchema = z.object({
  scope: ToolScopeRefSchema, canEdit: z.boolean(),
  tools: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), toolName: z.string(), integrationKind: z.literal('google').nullable(), availability: z.enum(['context_dependent', 'unavailable']), group: z.string(), enabled: z.boolean(), preference: z.boolean().nullable(), blockedBy: z.array(ToolScopeRefSchema) })),
});
export type ToolCatalogResponse = z.infer<typeof ToolCatalogResponseSchema>;
