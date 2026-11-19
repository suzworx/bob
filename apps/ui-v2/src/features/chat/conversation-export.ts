import { BRAND } from '@/lib/brand';
import type { ConversationDetail, ConversationMessagePart } from '@/features/chat/use-conversations';

// Text-bearing parts only: a text part becomes its text, a file part becomes
// an image placeholder, and every other part type (reasoning, tool-*,
// step-start) is dropped from the export.
function partToText(part: ConversationMessagePart): string | null {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'file') {
    const filename = typeof part.filename === 'string' ? part.filename : undefined;
    return `[Image: ${filename ?? 'image'}]`;
  }
  return null;
}

function speakerLabel(role: 'user' | 'assistant'): string {
  return role === 'user' ? '**You**' : `**${BRAND.name}**`;
}

export function conversationMarkdown(detail: ConversationDetail, exportedAt: Date = new Date()): string {
  const blocks: string[] = [
    `# ${detail.title}`,
    `Exported from ${BRAND.name} on ${exportedAt.toISOString().slice(0, 10)}.`,
  ];
  for (const message of detail.messages) {
    const version = message.versions.find((candidate) => candidate.selected) ?? message.versions[0];
    const texts = (version?.parts ?? [])
      .map(partToText)
      .filter((text): text is string => text !== null);
    if (texts.length === 0) continue;
    blocks.push(speakerLabel(message.role), ...texts);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function exportFileName(title: string): string {
  const stripped = title
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  const name = stripped.slice(0, 60) || 'conversation';
  return `${name}.md`;
}

export function downloadMarkdown(fileName: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
