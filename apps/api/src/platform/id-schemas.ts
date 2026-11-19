/** Opaque web-facing id bound (mirrors schemas.ts OpaqueIdSchema); shared by web-schemas.ts and the feature modules' DTOs. */
import { z } from 'zod';

export const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Where a message came from; shared by conversations (web-schemas.ts) and memory sources. */
export const OriginSchema = z.enum(['web_text', 'web_voice', 'device']);
