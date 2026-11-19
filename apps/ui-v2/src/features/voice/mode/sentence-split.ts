export interface SentenceSplitter {
  push(chunk: string): string[];
  flush(): string[];
}

interface SentenceSplitterOptions {
  maxChars?: number;
}

const ABBREVIATIONS = new Set([
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'St',
  'vs',
  'etc',
  'e.g',
  'i.e',
]);

const DEFAULT_MAX_CHARS = 700;

function isAbbreviationBefore(text: string, pos: number): boolean {
  const before = text.slice(0, pos).trim();
  const last = before.split(/[\s,;:]/).pop() ?? '';
  return ABBREVIATIONS.has(last);
}

function findBoundary(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '.' && isDigitBefore(text, i) && isDigitAfter(text, i)) {
      i += 1;
      continue;
    }
    if ((c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] ?? '')) {
      if (!(c === '.' && isAbbreviationBefore(text, i))) {
        return i + 1;
      }
    }
    if (c === '\n' && text[i + 1] === '\n') {
      return i + 2;
    }
    i += 1;
  }
  return -1;
}

function isDigitBefore(text: string, pos: number): boolean {
  return /\d/.test(text[pos - 1] ?? '');
}

function isDigitAfter(text: string, pos: number): boolean {
  return /\d/.test(text[pos + 1] ?? '');
}

function stripMarkdown(sentence: string): string {
  let out = sentence
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}\s+|- |\* |\d+\. )/, ''))
    .join('\n');
  return out.trim();
}

function cleanSentence(raw: string): string {
  const cleaned = stripMarkdown(raw).trim();
  return cleaned;
}

export function createSentenceSplitter(
  options: SentenceSplitterOptions = {},
): SentenceSplitter {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let buffer = '';

  function emitComplete(from: number, to: number, out: string[]): void {
    const sentence = cleanSentence(buffer.slice(from, to));
    if (sentence.length > 0) {
      out.push(sentence);
    }
  }

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      let from = 0;
      while (from < buffer.length) {
        const boundary = findBoundary(buffer, from);
        if (boundary === -1) {
          break;
        }
        emitComplete(from, boundary, out);
        from = boundary;
      }
      if (from > 0) {
        buffer = buffer.slice(from);
      }
      while (buffer.length > maxChars) {
        const cut = buffer.lastIndexOf(' ', maxChars);
        if (cut <= 0) {
          break;
        }
        const sentence = cleanSentence(buffer.slice(0, cut));
        if (sentence.length > 0) {
          out.push(sentence);
        }
        buffer = buffer.slice(cut + 1);
      }
      return out;
    },
    flush(): string[] {
      const out: string[] = [];
      if (buffer.length > 0) {
        const sentence = cleanSentence(buffer);
        if (sentence.length > 0) {
          out.push(sentence);
        }
        buffer = '';
      }
      return out;
    },
  };
}