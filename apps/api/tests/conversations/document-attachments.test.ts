import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { prepareDocumentMessages } from '../../src/conversations/document-attachments.ts';

const message = (mediaType: string, content: string, filename = 'notes.txt') => [{
  id: 'u1', role: 'user' as const,
  parts: [{ type: 'file' as const, mediaType, filename, url: `data:${mediaType};base64,${Buffer.from(content).toString('base64')}` }],
}];

it('turns UTF-8 text into model text while preserving the original attachment', async () => {
  const input = message('text/plain', 'The moon is bright.');
  const result = await prepareDocumentMessages(input, AbortSignal.timeout(1000));
  expect(result[0]?.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('The moon is bright.') });
  expect(input[0]?.parts[0]?.type).toBe('file');
});

it('retains PDF file parts for native model input', async () => {
  const input = message('application/pdf', '%PDF-1.7\n%%EOF', 'notes.pdf');
  expect(await prepareDocumentMessages(input, AbortSignal.timeout(1000))).toEqual(input);
});

it('rejects a spoofed PDF, corrupt Word file and empty document', async () => {
  for (const input of [message('application/pdf', 'not a pdf'), message('application/msword', 'not word'), message('text/plain', '   ')]) {
    await expect(prepareDocumentMessages(input, AbortSignal.timeout(1000))).rejects.toThrow('document_unreadable');
  }
});

it('rejects document text beyond its character budget', async () => {
  await expect(prepareDocumentMessages(message('text/plain', 'x'.repeat(60001)), AbortSignal.timeout(1000))).rejects.toThrow('document_unreadable');
});

it('honors cancellation before reading', async () => {
  await expect(prepareDocumentMessages(message('text/plain', 'hello'), AbortSignal.abort())).rejects.toThrow();
});

it.each([
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
])('extracts a real synthetic %s document in the isolated parser', async (extension, mediaType) => {
  const bytes = readFileSync(new URL(`./fixtures/attachment.${extension}`, import.meta.url));
  const input = [{ id: 'u1', role: 'user' as const, parts: [{ type: 'file' as const, mediaType, filename: `attachment.${extension}`, url: `data:${mediaType};base64,${bytes.toString('base64')}` }] }];
  const result = await prepareDocumentMessages(input, AbortSignal.timeout(5000));
  expect(result[0]?.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('ORBIT-42') });
  expect(input[0]?.parts[0]?.type).toBe('file');
});

it('rejects invalid UTF-8 and aggregate text over the turn budget', async () => {
  const invalid = message('text/plain', 'temporary');
  const file = invalid[0]?.parts[0];
  if (!file) throw new Error('fixture missing');
  file.url = 'data:text/plain;base64,//8=';
  await expect(prepareDocumentMessages(invalid, AbortSignal.timeout(1000))).rejects.toThrow('document_unreadable');
  const input = [...message('text/plain', 'x'.repeat(60000)), ...message('text/plain', 'y'.repeat(60000)), ...message('text/plain', 'z')];
  await expect(prepareDocumentMessages(input, AbortSignal.timeout(1000))).rejects.toThrow('document_unreadable');
});

it('keeps newer documents within the history budget without trapping later turns', async () => {
  const input = [...message('text/plain', 'a'.repeat(50000)), ...message('text/plain', 'b'.repeat(50000)), ...message('text/plain', 'c'.repeat(50000))];
  const result = await prepareDocumentMessages(input, AbortSignal.timeout(1000), true);
  expect(JSON.stringify(result[0])).toContain('Older document omitted');
  expect(JSON.stringify(result[1])).toContain('b'.repeat(50000));
  expect(JSON.stringify(result[2])).toContain('c'.repeat(50000));
  expect(input[0]?.parts[0]?.type).toBe('file');
});
