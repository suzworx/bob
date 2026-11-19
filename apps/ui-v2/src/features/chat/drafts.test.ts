import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, getDraft, moveDraft, NEW_CHAT_DRAFT_KEY, resetDrafts, setDraft } from './drafts';

describe('drafts', () => {
  beforeEach(resetDrafts);

  it('has no draft until one is set', () => {
    expect(getDraft('c1')).toBe('');
  });

  it('keeps a draft per conversation', () => {
    setDraft('c1', 'first');
    setDraft('c2', 'second');
    expect(getDraft('c1')).toBe('first');
    expect(getDraft('c2')).toBe('second');
  });

  it('replaces a draft on every set', () => {
    setDraft('c1', 'a');
    setDraft('c1', 'ab');
    expect(getDraft('c1')).toBe('ab');
  });

  it('treats empty text as no draft', () => {
    setDraft('c1', 'text');
    setDraft('c1', '');
    expect(getDraft('c1')).toBe('');
  });

  it('clears one key and leaves the rest', () => {
    setDraft('c1', 'one');
    setDraft('c2', 'two');
    clearDraft('c1');
    expect(getDraft('c1')).toBe('');
    expect(getDraft('c2')).toBe('two');
  });

  it('moves the new-chat draft to the conversation that adopts it', () => {
    setDraft(NEW_CHAT_DRAFT_KEY, 'and then?');
    moveDraft(NEW_CHAT_DRAFT_KEY, 'c9');
    expect(getDraft('c9')).toBe('and then?');
    expect(getDraft(NEW_CHAT_DRAFT_KEY)).toBe('');
  });

  it('moves nothing, and leaves the target alone, when the source has no draft', () => {
    setDraft('c9', 'kept');
    moveDraft(NEW_CHAT_DRAFT_KEY, 'c9');
    expect(getDraft('c9')).toBe('kept');
  });
});
