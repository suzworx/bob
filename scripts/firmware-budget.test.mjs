import { describe, expect, it } from 'vitest';

import { checkBudget, parseSizeReport } from './firmware-budget.mjs';

// The tail of a real `pio run -e m5stack-cardputer-v2-poc` (2026-09-23).
const PIO_OUTPUT = `Linking .pio/build/m5stack-cardputer-v2-poc/firmware.elf
Retrieving maximum program size .pio/build/m5stack-cardputer-v2-poc/firmware.elf
Checking size .pio/build/m5stack-cardputer-v2-poc/firmware.elf
Advanced Memory Usage is available via "PlatformIO Home > Project Inspect"
RAM:   [==        ]  16.0% (used 52484 bytes from 327680 bytes)
Flash: [====      ]  36.7% (used 1226157 bytes from 3342336 bytes)
Building .pio/build/m5stack-cardputer-v2-poc/firmware.bin
========================= [SUCCESS] Took 41.20 seconds =========================
`;

const BUDGET = {
  static: {
    ram: { totalBytes: 327680, baselineBytes: 52484, limitBytes: 65536, growthWarnBytes: 2048 },
    flash: { totalBytes: 3342336, baselineBytes: 1226157, limitBytes: 1572864, growthWarnBytes: 32768 },
  },
};

describe('parseSizeReport', () => {
  it('reads RAM and flash used/total from the PlatformIO size summary', () => {
    expect(parseSizeReport(PIO_OUTPUT)).toEqual({
      ram: { usedBytes: 52484, totalBytes: 327680 },
      flash: { usedBytes: 1226157, totalBytes: 3342336 },
    });
  });

  it('ignores ANSI colour codes and CRLF line endings', () => {
    const coloured = PIO_OUTPUT.replaceAll('\n', '\r\n').replace('RAM:', '\u001b[32mRAM:').replace('bytes)\r\nFlash', 'bytes)\u001b[0m\r\nFlash');
    expect(parseSizeReport(coloured)?.ram.usedBytes).toBe(52484);
    expect(parseSizeReport(coloured)?.flash.usedBytes).toBe(1226157);
  });

  it('takes the last summary when the log holds more than one build', () => {
    const twice = `${PIO_OUTPUT}${PIO_OUTPUT.replace('52484', '53000')}`;
    expect(parseSizeReport(twice)?.ram.usedBytes).toBe(53000);
  });

  it('returns null when the log has no size summary (failed build)', () => {
    expect(parseSizeReport('Compiling...\n*** [firmware.elf] Error 1\n')).toBeNull();
    expect(parseSizeReport(PIO_OUTPUT.replace(/^Flash:.*$/m, ''))).toBeNull();
  });
});

describe('checkBudget', () => {
  const report = (ram, flash) => ({
    ram: { usedBytes: ram, totalBytes: 327680 },
    flash: { usedBytes: flash, totalBytes: 3342336 },
  });

  it('passes the baseline with no warnings', () => {
    expect(checkBudget(report(52484, 1226157), BUDGET)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('warns, but passes, when growth over the baseline exceeds the per-PR threshold', () => {
    const result = checkBudget(report(52484 + 2049, 1226157 + 40000), BUDGET);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/RAM grew 2049 B/);
    expect(result.warnings[1]).toMatch(/flash grew 39\.1 KiB/i);
  });

  it('fails when a region goes over its limit', () => {
    const result = checkBudget(report(65537, 1226157), BUDGET);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/RAM 65537 B is over the 65536 B limit/)]);
  });

  it('exactly at the limit still passes', () => {
    expect(checkBudget(report(65536, 1572864), BUDGET).ok).toBe(true);
  });

  it('fails when the region size changed (partition or board change): the budget must be re-based', () => {
    const result = checkBudget({ ...report(52484, 1226157), flash: { usedBytes: 1226157, totalBytes: 6553600 } }, BUDGET);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/flash region is 6553600 B, budget assumes 3342336 B/);
  });
});
