// Its own module so playback and announce keep real speakable() while test
// suites vi.mock stt-tts.ts wholesale.

/** True for a code-fence delimiter line ("```", "```js") -- never spoken. */
function isFenceLine(line: string): boolean {
  return /^\s*`{3,}\w*\s*$/.test(line);
}

/** True for a markdown table separator row ("|---|---|", "| :-- | --: |"). */
function isTableSeparatorLine(line: string): boolean {
  return line.includes('|') && /^[\s|:-]+$/.test(line);
}

/** Strips well-formed bold (double-star or double-underscore) and italic
 *  (single-star or single-underscore) spans. A marker must hug non-space
 *  text on both sides, so "2 * 3 * 4" (spaced-out, multiplication) is never
 *  mistaken for italics. */
function stripPairedEmphasis(text: string): string {
  return text
    .replace(/(?<!\w)\*\*(?=\S)([^*\n]*?\S)\*\*(?!\w)/g, '$1')
    .replace(/(?<!\w)__(?=\S)([^_\n]*?\S)__(?!\w)/g, '$1')
    .replace(/(?<!\w)\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1');
}

/** Removes emphasis markers left dangling when a bold/italic span is cut
 *  across two TTS pieces: any surviving "**"/"__", and a lone "*"/"_"
 *  that touches a word on exactly one side. "5 * 3" and "snake_case" are
 *  left alone, since neither touches a word on exactly one side only. */
function stripDanglingEmphasis(text: string): string {
  return text.replace(/\*\*|__/g, '').replace(/[*_]/g, (mark, offset: number, full: string) => {
    const touchesLeft = /\w/.test(full[offset - 1] ?? '');
    const touchesRight = /\w/.test(full[offset + 1] ?? '');
    return touchesLeft !== touchesRight ? '' : mark;
  });
}

const APP_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A web address, or the app path the app tools return. The left boundaries keep "Awww.That" whole. */
const URL_IN_SPEECH = new RegExp(
  `<?(?<![\\w.@-])(?:https?://|www\\.)(?:[^\\s<>()\\[\\]]|\\([^\\s()]*\\))*(?<![.,!?;:'"])>?|(?<![\\w./:-])/apps/${APP_ID}(?![\\w-])(?:[/?#][^\\s<>()\\[\\]]*(?<![.,!?;:'"]))?`,
  'gi',
);
const LINK_IN_A_SENTENCE = 'the link in the chat';
/** Links side by side, alone or joined by "or", say it once. */
const REPEATED_LINK = new RegExp(`${LINK_IN_A_SENTENCE}(?:[\\s,]+(?:(?:or|and)\\s+)?${LINK_IN_A_SENTENCE})+`, 'g');
export const ONLY_A_LINK = 'The link is in the chat.';

/**
 * Strips markdown syntax that reads wrong when spoken: bold/italic markers,
 * code fences and backticks, heading '#'s, list bullets/numbers, link syntax
 * (keeping the link text), table rows/pipes. Applied by the TTS caller to
 * each piece from createReplySplitter -- the splitter itself keeps its
 * raw-slice contract so pieces still join back to the exact reply text, and
 * this function tolerates a marker pair split across two pieces. A web address
 * becomes spoken words, never read out.
 */
export function speakable(text: string): string {
  let out = text
    .split('\n')
    .map((line) => (isFenceLine(line) || isTableSeparatorLine(line) ? '' : line))
    .join('\n');
  out = out
    .replace(/`+/g, '')
    // The bracketed text stops at the next '[' too, so a run of unmatched
    // '[' fails each attempt in O(1) instead of backtracking the whole tail.
    .replace(/\[([^\]\[]*)\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*\)/g, '$1');
  out = out
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,2}[.)]\s+)/, ''))
    .join('\n');
  const withoutLinks = out.replace(URL_IN_SPEECH, '');
  if (withoutLinks !== out && !/[\p{L}\p{N}]/u.test(withoutLinks)) return ONLY_A_LINK;
  out = out.replace(URL_IN_SPEECH, LINK_IN_A_SENTENCE).replace(REPEATED_LINK, LINK_IN_A_SENTENCE);
  out = stripDanglingEmphasis(stripPairedEmphasis(out)).replace(/\|/g, ' ');
  return out.trim();
}
