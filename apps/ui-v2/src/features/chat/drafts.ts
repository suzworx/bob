// Unsent composer text, kept per conversation so switching away and back does
// not lose it. Module-level on purpose: the chat surface is unmounted on every
// switch, so nothing that lives in a component survives one. It is memory only:
// a reload starts clean, and nothing here is ever logged.

// The key of a chat that has no conversation id yet.
export const NEW_CHAT_DRAFT_KEY = 'new';

const drafts = new Map<string, string>();

export function getDraft(key: string): string {
  return drafts.get(key) ?? '';
}

// Empty text is not a draft, so it clears the key rather than storing "".
export function setDraft(key: string, text: string): void {
  if (text === '') drafts.delete(key);
  else drafts.set(key, text);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

// A new chat adopted as a conversation carries its draft over to the new id.
export function moveDraft(from: string, to: string): void {
  if (from === to) return;
  const text = drafts.get(from);
  drafts.delete(from);
  if (text !== undefined) drafts.set(to, text);
}

// For tests: forget every draft.
export function resetDrafts(): void {
  drafts.clear();
}
