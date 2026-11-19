/** "X.Y.Z" releases and "X.Y.Z-dev+sha" dev builds; a dev build sorts below the same X.Y.Z release. */
export interface FirmwareVersion {
  major: number;
  minor: number;
  patch: number;
  dev: boolean;
}

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-dev\+[0-9a-z]{1,40})?$/i;

export function parseVersion(text: string): FirmwareVersion | null {
  const match = VERSION_RE.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    dev: text.includes('-'),
  };
}

function compareParsed(a: FirmwareVersion, b: FirmwareVersion): number {
  const byNumber = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (byNumber !== 0) return Math.sign(byNumber);
  return Number(b.dev) - Number(a.dev);
}

/** Negative, zero or positive like a sort comparator; null when either text is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  return compareParsed(left, right);
}

export function isDevVersion(text: string): boolean {
  return parseVersion(text)?.dev === true;
}
