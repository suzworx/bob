import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * log-file.mjs — size-capped append-only log writer for the dev scripts.
 *
 * The mirrored console logs (data/dev-api.log, data/device.log, data/api.log)
 * are written for as long as a dev server or monitor runs, which on a device
 * debugging session is hours of serial output. Capping them keeps a long
 * session from filling the disk while still leaving the recent history in
 * place. Mirrors apps/api/src/logger.ts, which does the same for the server's
 * own journal; the two cannot share code across the workspace boundary.
 */

export const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
export const DEFAULT_LOG_GENERATIONS = 3;

/** Size of an existing log, or 0 when it is absent or unreadable. */
function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Renames a rotation generation, tolerating one that was never created. */
function shift(from, to) {
  try {
    renameSync(from, to);
  } catch {
    // ENOENT for a generation that does not exist yet is the normal case.
  }
}

/**
 * The path of one rotated generation, keeping the `.log` suffix last
 * (`device.2.log`) so `npm run logs:clean` still matches it.
 */
export function generationPath(path, index) {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash + 1) return `${path}.${index}`;
  return `${path.slice(0, dot)}.${index}${path.slice(dot)}`;
}

/** Ages every generation by one and drops the oldest. */
function rotate(path, generations) {
  try {
    rmSync(generationPath(path, generations), { force: true });
    for (let index = generations - 1; index >= 1; index -= 1) {
      shift(generationPath(path, index), generationPath(path, index + 1));
    }
    shift(path, generationPath(path, 1));
  } catch {
    // A locked file must never break the stream being mirrored.
  }
}

/**
 * Creates the log's directory and returns an append function that rotates the
 * file once a write would pass `maxBytes`. The text is appended verbatim --
 * callers pass whole lines, newline included.
 */
export function openLogFile(path, { maxBytes = DEFAULT_MAX_LOG_BYTES, generations = DEFAULT_LOG_GENERATIONS } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  let size = fileSize(path);
  return (text) => {
    const bytes = Buffer.byteLength(text);
    // Rotated before the write so no line is split across two generations.
    if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
      rotate(path, generations);
      // Re-read rather than assume zero: a failed rotation leaves the live
      // file in place, and the next write must not think it is empty.
      size = fileSize(path);
    }
    appendFileSync(path, text);
    size += bytes;
  };
}
