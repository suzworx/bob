import { expect, it } from 'vitest';
import { splitWindow, toUIMessages } from './conversation-messages';
import type { ConversationDetail } from './use-conversations';

it('restores selected message versions and source timestamps identically in every chat surface', () => {
  const detail = {
    id: 'conversation', title: 'A chat', createdAt: 1, updatedAt: 2,
    messages: [{ id: 'message', role: 'assistant' as const, position: 0, origin: 'device', createdAt: 123,
      versions: [
        { id: 'old', versionIndex: 0, selected: false, parts: [{ type: 'text', text: 'Old reply' }] },
        { id: 'new', versionIndex: 1, selected: true, parts: [{ type: 'text', text: 'Selected reply' }] },
      ],
    }],
  };
  expect(toUIMessages(detail)).toEqual([{ id: 'message', role: 'assistant',
    parts: [{ type: 'text', text: 'Selected reply' }], metadata: { origin: 'device', createdAt: 123 } }]);
});

it('keeps older messages available while opening on the latest 200', () => {
  const detail: ConversationDetail = { id: 'chat', title: 'Chat', createdAt: 1, updatedAt: 2,
    messages: Array.from({ length: 205 }, (_, index) => ({ id: String(index), role: 'user', position: index,
      versions: [{ id: `version-${index}`, versionIndex: 0, selected: false, parts: [{ type: 'text', text: String(index) }] }] })),
  };
  const window = splitWindow(toUIMessages(detail));
  expect(window.earlier.map((message) => message.id)).toEqual(['0', '1', '2', '3', '4']);
  expect(window.recent).toHaveLength(200);
  expect(window.recent[0]?.parts).toEqual([{ type: 'text', text: '5' }]);
  expect(window.recent[199]?.id).toBe('204');
});
