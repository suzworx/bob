import { readFileSync } from 'node:fs';
import { expect, ok, test } from './fixtures.ts';

test('picks, sends and reopens PDF, Word and text attachments', async ({ page, chatPage, api, cleanup, tag }, testInfo) => {
  await chatPage.goto();
  const files = [
    { name: 'notes.pdf', mimeType: 'application/pdf', buffer: readFileSync(new URL('../../api/tests/conversations/fixtures/attachment.pdf', import.meta.url)) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Project code: ORBIT-42.') },
    { name: 'notes.doc', mimeType: 'application/msword', buffer: readFileSync(new URL('../../api/tests/conversations/fixtures/attachment.doc', import.meta.url)) },
    { name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: readFileSync(new URL('../../api/tests/conversations/fixtures/attachment.docx', import.meta.url)) },
  ];
  await page.getByLabel('Upload files').setInputFiles(files);
  for (const file of files) await expect(page.getByText(file.name, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('documents-staged.png') });
  await chatPage.send(`Summarize these documents. ${tag}`);
  const id = await chatPage.conversationId();
  cleanup(async () => ok('delete conversation', await api.delete(`/api/conversations/${id}`)));
  await expect(chatPage.lastReply()).not.toHaveText('');
  await page.reload();
  for (const file of files) await expect(chatPage.userMessages.getByText(file.name, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('documents-persisted.png') });
});
