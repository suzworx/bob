// Helpers for pair-page device code entry.

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Shape check only; the server owns alphabet membership — the contract's
// own example code contains digits (e.g., "K7QX-4TZP").
export function isNormalizable(code: string): boolean {
  return code.length === 8 && /^[A-Z0-9]+$/.test(code);
}

/** Live input shaping: uppercase, one hyphen after the 4th character. */
export function formatCodeInput(raw: string): string {
  const normalized = normalizeCode(raw).slice(0, 8);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

export function formatRetryAfter(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.ceil(seconds / 3600);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
