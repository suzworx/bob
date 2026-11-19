import { z } from 'zod';
import { audioFormatSchema } from '@bob/ai';
import { OpaqueId, } from './platform/id-schemas.ts';
export const webVoiceRequestSchema = z.object({ audio: z.string().min(1), format: audioFormatSchema, workflowId: z.string().uuid().optional() });
export const webSpeechRequestSchema = z.object({ text: z.string().min(1), workflowId: z.string().uuid().optional() });
type WebVoiceRequest = z.infer<typeof webVoiceRequestSchema>;
type WebSpeechRequest = z.infer<typeof webSpeechRequestSchema>;

// The web contract is one barrel: feature modules own their DTOs and re-export them here (issue #620).
export { OpaqueId };
export * from './bob-apps/api-schemas.ts';
export * from './bob-apps/refresh-schemas.ts';
export * from './bob-apps/schemas.ts';
export * from './bob-apps/marketing-schemas.ts';
export * from './bob-apps/marketing-campaign-schemas.ts';
export { MarketingConfigDetailResponseSchema, MarketingConfigMutationResponseSchema, MarketingConfigProposeRequestSchema, MarketingConfigApplyRequestSchema, MarketingConfigDiscardRequestSchema, MarketingConfigRestoreRequestSchema, MarketingConfigHistoryQuerySchema } from './bob-apps/marketing-config-schemas.ts';
export * from './conversations/schemas.ts';
export * from './account/schemas.ts';
export * from './devices/schemas.ts';
export * from './integrations/google-schemas.ts';
export * from './integrations/google-native-schemas.ts';
export * from './integrations/google-agenda-schemas.ts';
export * from './memory/schemas.ts';
export * from './tasks/schemas.ts';
export * from './calendar/schemas.ts';
export * from './reminders/schemas.ts';
export * from './platform/observability/schemas.ts';
export { RoutineSchema, RoutineCreateSchema, RoutineUpdateSchema, RoutineDeleteSchema } from './routines/schemas.ts';
export { InsightSchema, InsightCategorySchema, InsightsResponseSchema, RoutineRunSchema, RoutineRunsResponseSchema } from './routines/execution-schemas.ts';
export { RoutineTimelineQuerySchema, RoutineTimelineResponseSchema } from './routines/execution-schemas.ts';
export { TimelineQuerySchema, TimelineResponseSchema } from './timeline/schemas.ts';
export { ToolCatalogResponseSchema, ToolContextSchema, ToolPreferenceSchema } from './tools/schemas.ts';
export { GroupChatSchema, GroupChatMemberSchema, GroupChatLinkPreviewSchema } from './spaces/schemas.ts';

export * from './bob-apps/marketing-review-schemas.ts';
