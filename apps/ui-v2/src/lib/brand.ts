// The brand, in one place: every user-visible name, the mark and the few lines that are tone rather
// than name read from here. The tab title, favicons and link-preview tags are static in index.html.
export const BRAND = {
  /** The product name in titles, the sign-in wordmark and the nav heading. */
  name: 'Bob',
  /** What the assistant is called in the UI; the server calls it the same. */
  assistantName: 'Bob',
  /** Bob's face, rendered inside the SVG brand mark. */
  markSrc: '/brand/bob/bob-helper.webp',
  copy: { greeting: 'Hello, friend', error: 'Oops, Bob tripped over something. Let’s try again', speak: 'Talk to Bob' },
} as const;
