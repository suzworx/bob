/**
 * The wire vocabulary of `express`, kept free of imports so the protocol can
 * share it without loading the agent layer (@bob/ai/express).
 */
/** Bob's feelings the device can show (the firmware's emotion table, in its order). */
export const EXPRESS_EMOTIONS = [
  'idle', 'listening', 'thinking', 'speaking', 'sleeping', 'waking_up', 'hello', 'updating', 'offline', 'error',
  'success', 'failed', 'happy', 'joyful', 'laughing', 'love', 'grateful', 'proud', 'playful', 'excited',
  'celebrating', 'relieved', 'calm', 'cool', 'curious', 'surprised', 'amazed', 'confused', 'skeptical', 'focused',
  'idea', 'sad', 'crying', 'worried', 'scared', 'grumpy', 'annoyed', 'embarrassed', 'shy', 'bored', 'sleepy',
  'dizzy', 'sick', 'apologetic', 'alarm', 'music', 'reminder',
] as const;
export type ExpressEmotion = (typeof EXPRESS_EMOTIONS)[number];
export const EXPRESS_DEFAULT_SECONDS = 6;
export const EXPRESS_MAX_SECONDS = 15;
