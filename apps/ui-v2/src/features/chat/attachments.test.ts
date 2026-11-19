import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  ATTACHMENT_ERROR_COPY,
  ATTACHMENT_TOO_MUCH,
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  attachmentBytes,
  fileToPart,
  isOverMessageBound,
  validateFiles,
} from './attachments';

function imageFile(name: string, type = 'image/png', size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

// A data URL whose base64 body decodes to exactly `bytes` bytes.
function dataUrlOf(bytes: number): string {
  const padding = (3 - (bytes % 3)) % 3;
  const chars = Math.ceil(bytes / 3) * 4;
  return `data:image/png;base64,${'A'.repeat(chars - padding)}${'='.repeat(padding)}`;
}

describe('attachment copy and accept list', () => {
  it('offers images, PDF, Word and plain text', () => {
    expect(ACCEPT_ATTRIBUTE).toBe('image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.txt,.doc,.docx');
  });

  it('describes the shared document and image limits', () => {
    expect(ATTACHMENT_ERROR_COPY.accept).toBe('Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image.');
    expect(ATTACHMENT_ERROR_COPY.max_file_size).toBe('That file is larger than 4 MB.');
    expect(ATTACHMENT_ERROR_COPY.max_files).toBe('At most 4 files can be attached to one message.');
    expect(ATTACHMENT_TOO_MUCH).toBe(
      'Those files come to more than 8 MB together. Remove one and send again.',
    );
  });
});

describe('attachmentBytes', () => {
  it('measures the decoded size of a base64 data URL', () => {
    expect(attachmentBytes(dataUrlOf(3))).toBe(3);
    expect(attachmentBytes(dataUrlOf(4))).toBe(4);
    expect(attachmentBytes(dataUrlOf(5))).toBe(5);
    expect(attachmentBytes(dataUrlOf(1000))).toBe(1000);
  });

  it('counts anything that is not a data URL as zero', () => {
    expect(attachmentBytes(undefined)).toBe(0);
    expect(attachmentBytes('https://example.com/a.png')).toBe(0);
    expect(attachmentBytes('data:image/png;base64')).toBe(0);
  });
});

describe('isOverMessageBound', () => {
  it('allows exactly 8 MB and refuses anything past it', () => {
    const half = dataUrlOf(MAX_MESSAGE_ATTACHMENT_BYTES / 2);
    expect(isOverMessageBound([{ url: half }, { url: half }])).toBe(false);
    expect(isOverMessageBound([{ url: half }, { url: half }, { url: dataUrlOf(1) }])).toBe(true);
  });
});

describe('validateFiles', () => {
  it('accepts each of the four image types', () => {
    const files = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map((type, index) =>
      imageFile(`f${index}`, type),
    );
    expect(validateFiles(files, 0)).toEqual({ accepted: files });
  });

  it('refuses a wrong type with the accept copy', () => {
    expect(validateFiles([imageFile('a.svg', 'image/svg+xml')], 0)).toEqual({
      error: ATTACHMENT_ERROR_COPY.accept,
    });
    expect(validateFiles([imageFile('a.zip', 'application/zip')], 0)).toEqual({
      error: ATTACHMENT_ERROR_COPY.accept,
    });
  });

  it('allows a file of exactly 4 MB and refuses one byte more', () => {
    expect('accepted' in validateFiles([imageFile('a.png', 'image/png', MAX_ATTACHMENT_BYTES)], 0)).toBe(
      true,
    );
    expect(validateFiles([imageFile('a.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)], 0)).toEqual({
      error: ATTACHMENT_ERROR_COPY.max_file_size,
    });
  });

  it('allows four files in all and refuses the fifth, counting staged ones', () => {
    const four = [1, 2, 3, 4].map((n) => imageFile(`f${n}.png`));
    expect('accepted' in validateFiles(four, 0)).toBe(true);
    expect(validateFiles([imageFile('f5.png')], 4)).toEqual({ error: ATTACHMENT_ERROR_COPY.max_files });
    expect(validateFiles([...four, imageFile('f5.png')], 0)).toEqual({
      error: ATTACHMENT_ERROR_COPY.max_files,
    });
  });

  it('names the wrong type before the size or count', () => {
    const batch = [imageFile('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1), imageFile('a.html', 'text/html')];
    expect(validateFiles(batch, 4)).toEqual({ error: ATTACHMENT_ERROR_COPY.accept });
  });

  it('takes an empty batch as nothing to stage', () => {
    expect(validateFiles([], 0)).toEqual({ accepted: [] });
  });
});

describe('fileToPart', () => {
  it.each(['pdf', 'doc', 'docx', 'txt'])('accepts a .%s file when the browser supplies no MIME type', async (extension) => {
    const file = new File(['fixture'], `notes.${extension}`);
    expect(validateFiles([file], 0)).toEqual({ accepted: [file] });
    const part = await fileToPart(file);
    expect(part.mediaType).not.toBe('');
    expect(part.url).toMatch(new RegExp(`^data:${part.mediaType};base64,`));
  });
  it('turns a file into a data-URL file part', async () => {
    const part = await fileToPart(new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }));
    expect(part).toEqual({
      type: 'file',
      mediaType: 'image/png',
      filename: 'cat.png',
      url: 'data:image/png;base64,AQID',
    });
  });
});
