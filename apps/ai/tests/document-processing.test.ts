import { describe, expect, it, vi } from 'vitest';
import { processDocument } from '../src/document-processing.ts';

const text = 'Invoice Acme Demo 2026-10-01 USD subtotal 10.00 tax 1.00 total 11.00';
const field = (value: string): { value: string; quote: string } => ({ value, quote: value });
const fields = { issuer: field('Acme Demo'), reference: null, date: field('2026-10-01'), currency: field('USD'), subtotal: field('10.00'), tax: field('1.00'), total: field('11.00') };
const signal = (): AbortSignal => new AbortController().signal;

describe('document processing', () => {
  it('classifies before extraction and checks grounded amounts', async () => {
    const call = vi.fn().mockResolvedValueOnce({ kind: 'invoice', confidence: 0.95 }).mockResolvedValueOnce(fields);
    const result = await processDocument({ text }, call, signal());
    expect(result.status).toBe('checks_passed');
    expect(call.mock.calls.map((args) => args[0])).toEqual(['classify', 'extract']);
  });

  it.each([
    ['unknown', 1, 'uncertain_kind'], ['invoice', 0.84, 'uncertain_kind'],
    ['contract', 0.95, 'unsupported_kind'],
  ])('abstains for %s at confidence %s', async (kind, confidence, issue) => {
    const call = vi.fn().mockResolvedValue({ kind, confidence });
    expect(await processDocument({ text }, call, signal())).toMatchObject({ fields: null, status: 'needs_review', issues: [issue] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...fields, issuer: field('Invented Company') }, 'ungrounded_field'],
    [{ ...fields, total: null }, 'missing_field'],
    [{ ...fields, total: field('12.00') }, 'total_mismatch'],
    [{ ...fields, total: field('1,200.00') }, 'invalid_amount'],
    [{ ...fields, currency: field('$') }, 'invalid_currency'],
    [{ ...fields, date: field('2026-02-30') }, 'invalid_date'],
  ])('flags invalid fields %#', async (extracted, issue) => {
    const call = vi.fn().mockResolvedValueOnce({ kind: 'receipt', confidence: 0.95 }).mockResolvedValueOnce(extracted);
    const result = await processDocument({ text }, call, signal());
    expect(result.status).toBe('needs_review');
    expect(result.issues).toContain(issue);
  });

  it('rejects a quote that does not contain the asserted value', async () => {
    const call = vi.fn().mockResolvedValueOnce({ kind: 'invoice', confidence: 1 })
      .mockResolvedValueOnce({ ...fields, issuer: { value: 'Other', quote: text } });
    expect((await processDocument({ text }, call, signal())).issues).toContain('ungrounded_field');
  });

  it('rejects invalid inputs without spending a model call', async () => {
    const call = vi.fn();
    for (const input of [{ text: '' }, { text: 'a'.repeat(60001) }, { text, url: 'https://example.org' }]) {
      await expect(processDocument(input, call, signal())).rejects.toThrow();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('stops before provider calls when cancelled', async () => {
    const call = vi.fn();
    await expect(processDocument({ text }, call, AbortSignal.abort())).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates provider failure without inventing a classification', async () => {
    await expect(processDocument({ text }, vi.fn().mockRejectedValue(new Error('provider unavailable')), signal())).rejects.toThrow('provider unavailable');
  });
});
