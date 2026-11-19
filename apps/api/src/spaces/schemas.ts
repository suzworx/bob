import { z } from 'zod';

export const GroupChatSchema = z.object({
  id: z.string().uuid(), space_id: z.string().uuid(), title: z.string().min(1).max(120),
  created_by: z.string().uuid(), role: z.enum(['owner', 'admin', 'member']),
  created_at: z.number().int().positive(), updated_at: z.number().int().positive(),
}).strict();
export const GroupChatMemberSchema = z.object({
  user_id: z.string().uuid(), display_name: z.string().nullable(), role: z.enum(['owner', 'admin', 'member']),
}).strict();
export const GroupChatLinkPreviewSchema = z.object({
  title: z.string(), inviter_name: z.string(), expires_at: z.number().int().positive(),
}).strict();
