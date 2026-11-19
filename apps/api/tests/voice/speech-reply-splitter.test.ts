/**
 * Vitest suite for #898: the first streamed reply piece should start sooner
 * (cut at an early clause break, not just a full sentence or 240 chars), and
 * spoken text should carry no markdown symbols. Runs through the root
 * vitest.config.ts.
 */
import { describe, expect, it } from 'vitest';
import { createReplySplitter } from '../../src/voice/audio/stt-tts.ts';
import { speakable } from '../../src/voice/audio/speakable.ts';

/** Feeds `deltas` through a fresh splitter; returns every piece, flush included. */
function splitAll(deltas: string[]): string[] {
  const splitter = createReplySplitter();
  return [...deltas.flatMap((delta) => splitter.push(delta)), ...splitter.flush()];
}

describe('createReplySplitter first-piece clause break (#898)', () => {
  it('cuts the first piece at an early comma once ~40 chars have arrived with no sentence end yet', () => {
    const firstPiece = `${'word '.repeat(9)}comma, `;
    const rest = 'and the opening keeps going, then a second comma follows, right up to the end';
    const reply = firstPiece + rest;

    // (a) the first piece ends right at the first clause break past ~40 chars.
    expect(splitAll([reply])).toEqual([firstPiece, rest]);
    // Streamed one character at a time, the result is identical.
    expect(splitAll([...reply])).toEqual([firstPiece, rest]);

    // (b) the later text is not cut at its own comma: it comes through whole.
    expect(rest.includes(',')).toBe(true);
    // (c) the pieces still join back to exactly the input.
    expect(splitAll([reply]).join('')).toBe(reply);
  });

  it('does not cut the first piece early when a full sentence arrives first', () => {
    const reply = 'Hi. ' + `${'word '.repeat(9)}comma, and more words follow after that.`;
    const pieces = splitAll([reply]);
    expect(pieces[0]).toBe('Hi. ');
    expect(pieces.join('')).toBe(reply);
  });

  it('treats "; ", ": " and " - " as early clause breaks too', () => {
    expect(splitAll([`${'word '.repeat(9)}like so; continuing on`])[0]).toBe(`${'word '.repeat(9)}like so; `);
    expect(splitAll([`${'word '.repeat(9)}like so: continuing on`])[0]).toBe(`${'word '.repeat(9)}like so: `);
    expect(splitAll([`${'word '.repeat(9)}like so - continuing on`])[0]).toBe(`${'word '.repeat(9)}like so - `);
  });

  it('does not cut a short opening clause before ~40 chars', () => {
    const reply = 'Hey, this keeps going without any sentence end for quite a while longer yet';
    const pieces = splitAll([reply]);
    expect(pieces.join('')).toBe(reply);
    expect(pieces[0]).not.toBe('Hey, ');
  });
});

describe('speakable never reads a URL aloud (#1423)', () => {
  const id = '05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10';
  it.each([
    [`Add fill-ups from the app at https://your-app-host/apps/${id}.`, 'Add fill-ups from the app at the link in the chat.'],
    [`Your tracker is ready at /apps/${id}, take a look.`, 'Your tracker is ready at the link in the chat, take a look.'],
    ['See <https://example.com/docs> or www.example.com/a?b=1 for more.', 'See the link in the chat for more.'],
    [`Open [Fuel log](https://your-app-host/apps/${id}) now.`, 'Open Fuel log now.'],
  ])('%s', (reply, spoken) => {
    expect(speakable(reply)).toBe(spoken);
  });

  it.each([
    ["It's at www.nasa.gov.", "It's at the link in the chat."],
    ['See https://a.example/x_(y) ok', 'See the link in the chat ok'],
    ['Awww...thanks!', 'Awww...thanks!'],
    ['Awww.That is sweet', 'Awww.That is sweet'],
    ['Wow, ewww.gross', 'Wow, ewww.gross'],
  ])('keeps Bob readable: %s', (reply, spoken) => {
    expect(speakable(reply)).toBe(spoken);
  });

  it.each([
    `https://h/apps/${id}.`, `(https://h/apps/${id})`, `- https://h/apps/${id}`, `1. https://h/apps/${id}`,
    `> https://h/apps/${id}`, `<https://h/apps/${id}>`, `- https://a.example\n- https://b.example`,
  ])('treats %j as only a link', (reply) => {
    expect(speakable(reply)).toBe('The link is in the chat.');
  });

  it('stays linear on a long run of spaces, with a ceiling a quadratic pass cannot meet', () => {
    const started = performance.now();
    speakable(`${' '.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(5000);
  }, 120_000);

  it.each([
    [`Open /apps/${id}/edit now`, 'Open the link in the chat now'],
    [`Open /apps/${id}?tab=1 now`, 'Open the link in the chat now'],
    [`Open /apps/${id}/. Then rest.`, 'Open the link in the chat. Then rest.'],
    [`Odd /apps/${id}x now`, `Odd /apps/${id}x now`],
  ])('keeps a right boundary on an app path: %s', (reply, spoken) => {
    expect(speakable(reply)).toBe(spoken);
  });

  it.each([
    ['https://a.example https://b.example now', 'the link in the chat now'],
    ['https://a.example, https://b.example now', 'the link in the chat now'],
    ['Try https://a.example or https://b.example or www.c.example today', 'Try the link in the chat today'],
    ['Try https://a.example and https://b.example today', 'Try the link in the chat today'],
    ['A https://a.example then https://b.example.', 'A the link in the chat then the link in the chat.'],
  ])('says the link once when links sit side by side: %s', (reply, spoken) => {
    expect(speakable(reply)).toBe(spoken);
  });

  it('says something kind instead of nothing when a reply is only a link, so callers never fall back to the raw URL', () => {
    expect(speakable(`https://your-app-host/apps/${id}`)).toBe('The link is in the chat.');
    expect(speakable(`/apps/${id}`)).toBe('The link is in the chat.');
  });

  it('leaves a piece that was empty before links empty, and ordinary paths and versions alone', () => {
    expect(speakable('```')).toBe('');
    expect(speakable('Mix 1/2 cup and/or use v1.2/beta.')).toBe('Mix 1/2 cup and/or use v1.2/beta.');
  });

  it('never speaks a URL from a reply cut by the streaming splitter', () => {
    const pieces = splitAll(['Your tracker is ready, and you can add every fill-up ', `from the app at https://your-app-host/apps/${id}. `, 'Enjoy the drive!']);
    expect(pieces.map(speakable).join(' ')).not.toMatch(/https?:|your-app-host|\/apps\//);
  });
});

describe('speakable (#898)', () => {
  it('strips bold markers and code backticks', () => {
    expect(speakable('**Note:** use `npm`')).toBe('Note: use npm');
  });

  it('strips a heading marker', () => {
    expect(speakable('# Title')).toBe('Title');
  });

  it('strips list bullets at line start', () => {
    expect(speakable('- one\n- two')).toBe('one\ntwo');
  });

  it('strips a 1-2 digit ordered-list marker but not a 4-digit year', () => {
    expect(speakable('1. one\n2. two')).toBe('one\ntwo');
    expect(speakable('2026. Was a big year.')).toBe('2026. Was a big year.');
  });

  it('replaces link syntax with its text, including a nested-paren URL', () => {
    expect(speakable('[docs](https://x)')).toBe('docs');
    expect(speakable('[a](b(c))')).toBe('a');
  });

  it('leaves plain text unchanged', () => {
    expect(speakable('Lunch is at one, see you then.')).toBe('Lunch is at one, see you then.');
  });

  it('does not treat spaced-out multiplication as italics', () => {
    expect(speakable('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(speakable('5 * 3')).toBe('5 * 3');
  });

  it('keeps snake_case identifiers intact', () => {
    expect(speakable('snake_case')).toBe('snake_case');
  });

  it('cleans up a bold span cut across two TTS pieces by the splitter', () => {
    const piece1 = speakable('**Here are things, ');
    const piece2 = speakable('mostly** rain gear.');
    expect(piece1).toBe('Here are things,');
    expect(piece2).toBe('mostly rain gear.');
    expect(piece1).not.toMatch(/[*_]/);
    expect(piece2).not.toMatch(/[*_]/);
  });

  it('strips a lone leftover bold marker', () => {
    expect(speakable('**Note')).toBe('Note');
  });

  it('drops a code fence line including its language tag', () => {
    expect(speakable('```js\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('drops a table separator row but keeps header and data rows', () => {
    const out = speakable('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(out).not.toContain('---');
    expect(out).toContain('A');
    expect(out).toContain('1');
  });

  it('parses 50k consecutive "[" in well under 100ms (no quadratic blowup)', () => {
    const input = '['.repeat(50_000);
    const start = Date.now();
    speakable(input);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
