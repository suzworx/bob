import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetail } from '@/features/chat/use-conversations';
import { conversationMarkdown, downloadMarkdown, exportFileName } from './conversation-export';

function detailFixture(): ConversationDetail {
  return {
    id: 'c1',
    title: 'Trip plan',
    createdAt: 0,
    updatedAt: 0,
    messages: [
      {
        id: 'm1',
        role: 'user',
        position: 0,
        versions: [
          { id: 'v1', versionIndex: 0, selected: true, parts: [{ type: 'text', text: 'What should I pack?' }] },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        position: 1,
        versions: [
          { id: 'v2a', versionIndex: 0, selected: false, parts: [{ type: 'text', text: 'Old answer' }] },
          {
            id: 'v2b',
            versionIndex: 1,
            selected: true,
            parts: [
              { type: 'text', text: 'Pack layers and a rain jacket.' },
              { type: 'file', filename: 'photo.png', mediaType: 'image/png', url: 'data:x' },
              { type: 'reasoning', text: 'thinking about weather' },
              { type: 'tool-lookup', toolCallId: 't1', state: 'output-available' },
            ],
          },
        ],
      },
    ],
  };
}

describe('conversationMarkdown', () => {
  it('renders the title, date, speakers in order, selected text and an image placeholder, dropping reasoning/tool parts', () => {
    const markdown = conversationMarkdown(detailFixture(), new Date('2024-01-15T00:00:00Z'));
    expect(markdown).toBe(
      [
        '# Trip plan',
        'Exported from Bob on 2024-01-15.',
        '**You**',
        'What should I pack?',
        '**Bob**',
        'Pack layers and a rain jacket.',
        '[Image: photo.png]',
      ].join('\n\n') + '\n',
    );
    expect(markdown).not.toContain('thinking about weather');
    expect(markdown).not.toContain('Old answer');
  });
});

describe('exportFileName', () => {
  it('strips unsafe characters, collapses whitespace to dashes, and adds .md', () => {
    expect(exportFileName('Trip plan: May/June!')).toBe('Trip-plan-MayJune.md');
  });

  it('falls back to "conversation" when nothing usable remains', () => {
    expect(exportFileName('')).toBe('conversation.md');
    expect(exportFileName('!!!')).toBe('conversation.md');
  });

  it('caps the name at 60 characters plus the extension', () => {
    const name = exportFileName('a'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith('.md')).toBe(true);
  });
});

describe('downloadMarkdown', () => {
  it('creates a blob url, clicks a download anchor, and revokes the url after a tick', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadMarkdown('notes.md', '# Notes');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/markdown;charset=utf-8');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('notes.md');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');

    clickSpy.mockRestore();
    vi.useRealTimers();
  });
});
