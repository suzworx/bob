/**
 * Journal for v2 protocol events: writes timestamped JSON lines to the
 * console and an optional file sink. Never logs audio, transcripts, agent
 * text, credentials, URLs, or prompts. Each line carries the keys Railway's
 * log explorer reads (`message`, `level`) and the active trace ids.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { journal, journalLevel, moduleJournal, setJournalSink, type Journal, type JournalFields } from '@bob/ai/journal';

// The line shape lives in @bob/ai/journal so ai, web and device code share it; this file keeps the file sink.
// The subpath keeps the logger from loading @bob/ai's config (read once at import) before a test sets its env.
export { journal, journalLevel, moduleJournal, setJournalSink, type Journal, type JournalFields };
export const DEFAULT_JOURNAL_PATH = join(process.cwd(), 'data', 'v2-journal.log');

/** Debug-mode sink path. Separate file so journal output stays redacted, and
 *  under data/ so .gitignore keeps its transcripts out of the repository. */
export const DEFAULT_DEBUG_PATH = join(process.cwd(), 'data', 'v2-debug.log');

/**
 * Bytes a log file may reach before it is rotated. Both sinks under this
 * roof are append-only and long-lived -- a server left running writes to the
 * same journal for weeks -- so without a cap the file is unbounded, and the
 * first thing anyone does with a multi-gigabyte log is delete it, taking the
 * history with it.
 */
export const DEFAULT_MAX_LOG_BYTES = Number.parseInt(process.env.BOB_LOG_MAX_BYTES ?? '', 10) || 8 * 1024 * 1024;

/** Rotated generations kept beside the live file. */
export const DEFAULT_LOG_GENERATIONS = Number.parseInt(process.env.BOB_LOG_KEEP ?? '', 10) || 3;

/** Size of an existing log, or 0 when it is absent or unreadable. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Renames a rotation generation, tolerating one that was never created. */
function shift(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // ENOENT for a generation that does not exist yet is the normal case.
  }
}

/**
 * The path of one rotated generation. The `.log` suffix is kept last
 * (`v2-journal.2.log`, not `v2-journal.log.2`) so `npm run logs:clean`, which
 * matches on the extension, still sweeps rotated files away.
 */
function generationPath(path: string, index: number): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash + 1) return `${path}.${index}`;
  return `${path.slice(0, dot)}.${index}${path.slice(dot)}`;
}

/** Ages every generation by one and drops the oldest. */
function rotate(path: string, generations: number): void {
  try {
    rmSync(generationPath(path, generations), { force: true });
    for (let index = generations - 1; index >= 1; index -= 1) {
      shift(generationPath(path, index), generationPath(path, index + 1));
    }
    shift(path, generationPath(path, 1));
  } catch {
    // A locked file (Windows, with a monitor attached) must not take the
    // server down: the caller re-reads the size and simply keeps appending.
  }
}

/**
 * Creates the journal directory and returns an append-only line sink for a
 * file, rotating it once it would pass `maxBytes`.
 */
export function openJournalFile(
  path: string,
  { maxBytes = DEFAULT_MAX_LOG_BYTES, generations = DEFAULT_LOG_GENERATIONS }: { maxBytes?: number; generations?: number } = {},
): (line: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  let size = fileSize(path);
  return (line: string): void => {
    const bytes = Buffer.byteLength(line) + 1;
    // Rotated before the write rather than after, so no entry is ever split
    // across two generations. `size > 0` keeps a single line longer than the
    // whole budget from rotating an empty file forever.
    if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
      rotate(path, generations);
      // Re-read rather than assume zero: a rotation that failed leaves the
      // live file in place, and the next line must not think it is empty.
      size = fileSize(path);
    }
    appendFileSync(path, `${line}\n`);
    size += bytes;
  };
}
