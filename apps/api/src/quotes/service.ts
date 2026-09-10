import { randomUUID } from 'node:crypto';
import type { Catalog } from '../catalog/catalog.js';
import { UnknownSkuError } from '../catalog/catalog.js';
import { signQuote, verifySignature } from './sign.js';
import type {
  MedianDrift,
  QuoteLine,
  QuoteRequestItem,
  SignedQuote,
  StaleLineDelta,
  UnsignedQuote,
  VerifyQuoteResult,
} from './types.js';

export interface QuoteServiceOptions {
  catalog: Catalog;
  catalogForShop?: (shopId: string) => Catalog | undefined;
  secret: string;
  ttlSeconds: number;
  /** Injectable clock so expiry is testable without sleeping. */
  now?: () => Date;
}

export class QuoteService {
  private readonly catalog: Catalog;
  private readonly catalogForShop?: (shopId: string) => Catalog | undefined;
  private readonly secret: string;
  readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(opts: QuoteServiceOptions) {
    this.catalog = opts.catalog;
    this.catalogForShop = opts.catalogForShop;
    this.secret = opts.secret;
    this.ttlSeconds = opts.ttlSeconds;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Prices `items` against the catalog and returns a signed quote.
   *
   * The request body supplies sku and qty only. There is no code path by which
   * a caller-supplied price reaches a quote — that is the whole point.
   */
  create(items: QuoteRequestItem[], shopId?: string): SignedQuote {
    if (!Array.isArray(items) || items.length === 0) {
      throw new InvalidQuoteRequestError('items must be a non-empty array');
    }

    const merged = new Map<string, number>();
    for (const item of items) {
      if (typeof item?.sku !== 'string' || item.sku.length === 0) {
        throw new InvalidQuoteRequestError('each item needs a sku');
      }
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) {
        throw new InvalidQuoteRequestError(`qty for ${item.sku} must be a positive integer`);
      }
      merged.set(item.sku, (merged.get(item.sku) ?? 0) + item.qty);
    }

    const catalog = shopId && this.catalogForShop ? this.catalogForShop(shopId) : this.catalog;
    if (!catalog) throw new InvalidQuoteRequestError(`Unknown shop: ${shopId}`);
    const lines: QuoteLine[] = [];
    for (const [sku, qty] of merged) {
      const product = catalog.require(sku);
      lines.push({
        sku: product.sku,
        title: product.title,
        category: product.category,
        qty,
        unit_price_paise: product.price_paise,
        line_total_paise: product.price_paise * qty,
        category_median_paise: catalog.categoryMedianPaise(product.category),
      });
    }
    lines.sort((a, b) => a.sku.localeCompare(b.sku));

    const issuedAt = this.now();
    const unsigned: UnsignedQuote = {
      quote_id: `qt_${randomUUID().replaceAll('-', '')}`,
      ...(shopId ? { shop_id: shopId } : {}),
      currency: 'INR',
      lines,
      total_paise: sumPaise(lines),
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    return signQuote(unsigned, this.secret);
  }

  /**
   * Re-derives everything about a quote from first principles:
   * signature, then expiry, then a full re-price against the live catalog.
   *
   * Order matters. A tampered quote must report tampering, not staleness —
   * otherwise an attacker learns which of the two checks they tripped.
   *
   * `allowExpired` waives the two-minute window and nothing else — the
   * signature and the full re-price still have to pass. It exists for one
   * caller: a purchase a human has just approved. The short expiry is there to
   * stop an agent replaying a stale quote, and a person walking to their phone
   * takes longer than two minutes; the protection that actually matters there
   * is the re-price, which still runs. There is no route that sets it.
   */
  verify(
    candidate: unknown,
    at: Date = this.now(),
    opts: { allowExpired?: boolean } = {},
  ): VerifyQuoteResult {
    const shapeError = checkShape(candidate);
    if (shapeError) return { ok: false, code: 'QUOTE_MALFORMED', reason: shapeError };
    const quote = candidate as SignedQuote;
    const catalog = quote.shop_id && this.catalogForShop ? this.catalogForShop(quote.shop_id) : this.catalog;
    if (!catalog) return { ok: false, code: 'QUOTE_STALE', reason: 'The selected shop no longer exists' };

    if (!verifySignature(quote, this.secret)) {
      return {
        ok: false,
        code: 'QUOTE_SIGNATURE_INVALID',
        reason: 'Quote signature does not match its contents',
      };
    }

    const expiresAt = Date.parse(quote.expires_at);
    if (!Number.isFinite(expiresAt)) {
      return { ok: false, code: 'QUOTE_MALFORMED', reason: 'expires_at is not a valid timestamp' };
    }
    if (!opts.allowExpired && at.getTime() > expiresAt) {
      return {
        ok: false,
        code: 'QUOTE_EXPIRED',
        reason: `Quote expired at ${quote.expires_at}`,
      };
    }

    const deltas: StaleLineDelta[] = [];
    const medianDrift: MedianDrift[] = [];
    for (const line of quote.lines) {
      const product = catalog.get(line.sku);
      if (!product) {
        deltas.push({
          sku: line.sku,
          quoted_unit_price_paise: line.unit_price_paise,
          // A withdrawn sku is drift, not a signature problem. Price it as
          // unavailable so the caller re-quotes rather than charging.
          current_unit_price_paise: -1,
          delta_paise: -1 - line.unit_price_paise,
        });
        continue;
      }
      const currentMedian = catalog.categoryMedianPaise(product.category);
      if (currentMedian !== line.category_median_paise) {
        medianDrift.push({
          sku: line.sku,
          quoted_median_paise: line.category_median_paise,
          current_median_paise: currentMedian,
        });
      }
      if (product.price_paise !== line.unit_price_paise) {
        deltas.push({
          sku: line.sku,
          quoted_unit_price_paise: line.unit_price_paise,
          current_unit_price_paise: product.price_paise,
          delta_paise: product.price_paise - line.unit_price_paise,
        });
      }
    }

    if (deltas.length > 0 || medianDrift.length > 0) {
      const totalDelta = deltas.reduce((sum, d) => sum + d.delta_paise * qtyForSku(quote, d.sku), 0);
      return {
        ok: false,
        code: 'QUOTE_STALE',
        reason: 'Catalog prices changed since this quote was issued',
        deltas,
        total_delta_paise: totalDelta,
        ...(medianDrift.length > 0 ? { median_drift: medianDrift } : {}),
      };
    }

    return { ok: true, quote };
  }
}

export class InvalidQuoteRequestError extends Error {
  readonly code = 'QUOTE_REQUEST_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuoteRequestError';
  }
}

export { UnknownSkuError };

function qtyForSku(quote: SignedQuote, sku: string): number {
  return quote.lines.find((l) => l.sku === sku)?.qty ?? 0;
}

function sumPaise(lines: QuoteLine[]): number {
  return lines.reduce((sum, line) => sum + line.line_total_paise, 0);
}

function checkShape(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) return 'quote must be an object';
  const q = candidate as Partial<SignedQuote>;
  if (typeof q.quote_id !== 'string') return 'quote_id must be a string';
  if (typeof q.signature !== 'string') return 'signature must be a string';
  if (typeof q.issued_at !== 'string') return 'issued_at must be a string';
  if (typeof q.expires_at !== 'string') return 'expires_at must be a string';
  if (q.currency !== 'INR') return 'currency must be INR';
  if (!Array.isArray(q.lines) || q.lines.length === 0) return 'lines must be a non-empty array';
  if (!Number.isSafeInteger(q.total_paise)) return 'total_paise must be an integer';
  for (const line of q.lines) {
    if (typeof line?.sku !== 'string') return 'each line needs a sku';
    if (typeof line.category !== 'string') return `each line needs a category (${line.sku})`;
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0) return `bad qty on ${line?.sku}`;
    if (!Number.isSafeInteger(line.unit_price_paise)) return `bad unit price on ${line.sku}`;
    if (!Number.isSafeInteger(line.line_total_paise)) return `bad line total on ${line.sku}`;
    if (!Number.isSafeInteger(line.category_median_paise) || line.category_median_paise < 0) {
      return `bad category median on ${line.sku}`;
    }
  }
  return undefined;
}
