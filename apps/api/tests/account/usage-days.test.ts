// Pure check of the Usage day window (no database): every calendar day of the
// range is listed, oldest first, zeros included, across a month end.
import { describe, expect, it } from 'vitest';
import { fillDays } from '../../src/account/usage-store.ts';

describe('fillDays', () => {
  it('lists every day of the window, zero-filled, oldest first', () => {
    const days = fillDays('2026-11-02', 4, [
      { day: '2026-10-31', origin: 'device', n: 2 },
      { day: '2026-11-02', origin: 'web_text', n: 1 },
      { day: '2026-11-02', origin: 'web_text', n: 3 },
    ]);
    expect(days).toEqual([
      { day: '2026-10-30', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-10-31', device: 2, web_voice: 0, web_text: 0 },
      { day: '2026-11-01', device: 0, web_voice: 0, web_text: 0 },
      { day: '2026-11-02', device: 0, web_voice: 0, web_text: 4 },
    ]);
  });

  it('drops rows outside the window and unknown origins', () => {
    const days = fillDays('2026-10-21', 2, [
      { day: '2026-10-01', origin: 'device', n: 9 },
      { day: '2026-10-21', origin: 'fax', n: 9 },
    ]);
    expect(days.map((day) => day.device + day.web_voice + day.web_text)).toEqual([0, 0]);
  });
});
