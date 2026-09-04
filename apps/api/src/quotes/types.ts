import type { SignedQuote } from '@storefront/shared';

export type { QuoteLine, SignedQuote, UnsignedQuote } from '@storefront/shared';

export interface QuoteRequestItem {
  sku: string;
  qty: number;
}

export type QuoteFailureCode =
  | 'QUOTE_MALFORMED'
  | 'QUOTE_SIGNATURE_INVALID'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_STALE'
  | 'QUOTE_NOT_FOUND';

/** A category median that has moved since the quote was signed. */
export interface MedianDrift {
  sku: string;
  quoted_median_paise: number;
  current_median_paise: number;
}

export interface StaleLineDelta {
  sku: string;
  quoted_unit_price_paise: number;
  current_unit_price_paise: number;
  /** current - quoted, in paise. Negative means the price dropped. */
  delta_paise: number;
}

export type VerifyQuoteResult =
  | { ok: true; quote: SignedQuote }
  | {
      ok: false;
      code: QuoteFailureCode;
      reason: string;
      /** Present on QUOTE_STALE: which lines drifted and by how much. */
      deltas?: StaleLineDelta[];
      /** Present on QUOTE_STALE: total drift in paise across the quote. */
      total_delta_paise?: number;
      /**
       * Present on QUOTE_STALE when a category median moved. A neighbouring
       * item's price change can shift a median without touching this line's own
       * price, and the median feeds a policy rule — so it is re-derived too.
       */
      median_drift?: MedianDrift[];
    };
