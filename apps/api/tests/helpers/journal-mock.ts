import { vi } from 'vitest';

/** Logger module mock: module files call `moduleJournal(...)`, so every module's journal is this one spy. */
export function loggerMock(journal: (event: string, fields?: Record<string, unknown>) => void = vi.fn()): {
  journal: typeof journal;
  moduleJournal: () => typeof journal;
} {
  return { journal, moduleJournal: () => journal };
}
