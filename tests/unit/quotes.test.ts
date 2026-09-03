import { describe, expect, it } from 'vitest';
import { Catalog, getCatalog } from '../../src/catalog/catalog.js';
import { QuoteService, InvalidQuoteRequestError } from '../../src/quotes/service.js';
import { canonicalJson } from '../../src/lib/canonical.js';
import type { SignedQuote } from '../../src/quotes/types.js';

const SECRET = 'test_signing_secret_do_not_use_in_production';
const TTL = 120;

function service(catalog = getCatalog()): QuoteService {
  return new QuoteService({ catalog, secret: SECRET, ttlSeconds: TTL });
}

/** Deep clone so a mutation in one test cannot leak into another. */
function clone(quote: SignedQuote): SignedQuote {
  return JSON.parse(JSON.stringify(quote)) as SignedQuote;
}

describe('quote service', () => {
  const svc = service();

  it('prices lines from the catalog and totals them in integer paise', () => {
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 2 }]);
    const chai = getCatalog().require('CHAI-MSL-250');
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]!.unit_price_paise).toBe(chai.price_paise);
    expect(quote.lines[0]!.line_total_paise).toBe(chai.price_paise * 2);
    expect(quote.total_paise).toBe(chai.price_paise * 2);
    expect(Number.isSafeInteger(quote.total_paise)).toBe(true);
  });

  it('ignores any price supplied in the request body', () => {
    const chai = getCatalog().require('CHAI-MSL-250');
    const quote = svc.create([
      { sku: 'CHAI-MSL-250', qty: 1, price_paise: 1, unit_price_paise: 1 } as never,
    ]);
    expect(quote.total_paise).toBe(chai.price_paise);
  });

  it('sets expires_at to issued_at + 120 seconds', () => {
    const quote = svc.create([{ sku: 'BSC-PRL-300', qty: 1 }]);
    const span = Date.parse(quote.expires_at) - Date.parse(quote.issued_at);
    expect(span).toBe(TTL * 1000);
  });

  it('rejects a non-positive or fractional qty', () => {
    expect(() => svc.create([{ sku: 'BSC-PRL-300', qty: 0 }])).toThrow(InvalidQuoteRequestError);
    expect(() => svc.create([{ sku: 'BSC-PRL-300', qty: 1.5 }])).toThrow(InvalidQuoteRequestError);
    expect(() => svc.create([])).toThrow(InvalidQuoteRequestError);
  });

  // --- the Phase 1 validation table -------------------------------------

  it('a valid quote passes verifyQuote', () => {
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 2 }, { sku: 'BSC-PRL-300', qty: 3 }]);
    expect(svc.verify(quote)).toEqual({ ok: true, quote });
  });

  it('flipping one digit of total_paise fails the signature check', () => {
    const quote = clone(svc.create([{ sku: 'CHAI-MSL-250', qty: 2 }]));
    quote.total_paise += 1;
    const result = svc.verify(quote);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'QUOTE_SIGNATURE_INVALID' });
  });

  it("changing a line's qty after signing fails the signature check", () => {
    const quote = clone(svc.create([{ sku: 'CHAI-MSL-250', qty: 2 }]));
    quote.lines[0]!.qty = 20;
    quote.lines[0]!.line_total_paise = quote.lines[0]!.unit_price_paise * 20;
    quote.total_paise = quote.lines[0]!.line_total_paise;
    const result = svc.verify(quote);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'QUOTE_SIGNATURE_INVALID' });
  });

  it('an expired quote is rejected as expired', () => {
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 1 }]);
    const afterExpiry = new Date(Date.parse(quote.expires_at) + 1);
    const result = svc.verify(quote, afterExpiry);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'QUOTE_EXPIRED' });
    // Still valid at exactly expires_at; the boundary is inclusive.
    expect(svc.verify(quote, new Date(Date.parse(quote.expires_at))).ok).toBe(true);
  });

  it('a catalog price change makes an outstanding quote QUOTE_STALE with the delta', () => {
    const original = getCatalog().require('CHAI-MSL-250');
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 3 }]);

    const repriced = new Catalog(
      getCatalog().all().map((p) =>
        p.sku === 'CHAI-MSL-250' ? { ...p, price_paise: p.price_paise + 2500 } : p,
      ),
    );
    const result = service(repriced).verify(quote);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUOTE_STALE');
    expect(result.deltas).toEqual([
      {
        sku: 'CHAI-MSL-250',
        quoted_unit_price_paise: original.price_paise,
        current_unit_price_paise: original.price_paise + 2500,
        delta_paise: 2500,
      },
    ]);
    // Delta is reported at quote scale: 2500 paise x qty 3.
    expect(result.total_delta_paise).toBe(7500);
  });

  // --- signing details ---------------------------------------------------

  it('accepts a quote whose JSON key order was reshuffled in transit', () => {
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 1 }]);
    const reordered = JSON.parse(
      JSON.stringify({
        signature: quote.signature,
        total_paise: quote.total_paise,
        expires_at: quote.expires_at,
        issued_at: quote.issued_at,
        lines: quote.lines,
        currency: quote.currency,
        quote_id: quote.quote_id,
      }),
    );
    expect(svc.verify(reordered).ok).toBe(true);
  });

  it('a quote signed with a different secret is rejected', () => {
    const quote = svc.create([{ sku: 'CHAI-MSL-250', qty: 1 }]);
    const other = new QuoteService({ catalog: getCatalog(), secret: 'other', ttlSeconds: TTL });
    expect(other.verify(quote)).toMatchObject({ code: 'QUOTE_SIGNATURE_INVALID' });
  });

  it('reports a malformed quote rather than throwing', () => {
    expect(svc.verify(null)).toMatchObject({ code: 'QUOTE_MALFORMED' });
    expect(svc.verify({ quote_id: 'qt_x' })).toMatchObject({ code: 'QUOTE_MALFORMED' });
  });
});

describe('canonical json', () => {
  it('is stable under key reordering at every depth', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 3 } };
    const b = { a: { c: 3, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('does not reorder arrays', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
