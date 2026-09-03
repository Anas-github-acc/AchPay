export interface QuoteLine {
  sku: string;
  title: string;
  /**
   * Catalog category, carried on the quote so the policy engine can apply the
   * denylist without a catalog lookup. It is signed along with everything
   * else, so it cannot be swapped in transit.
   */
  category: string;
  qty: number;
  /** Integer paise, copied from the catalog at signing time. */
  unit_price_paise: number;
  /** unit_price_paise * qty, integer paise. */
  line_total_paise: number;
  /**
   * Median unit price across this line's catalog category, integer paise,
   * computed by the quote service at signing time.
   *
   * It lives on the quote so the policy engine can compare a price against its
   * category without querying anything — the engine stays a pure function of its
   * arguments. And because it is inside the signed payload, a caller cannot
   * inflate the median to make an expensive item look ordinary.
   */
  category_median_paise: number;
}

/** A quote before it is signed. `signature` covers exactly these fields. */
export interface UnsignedQuote {
  quote_id: string;
  currency: 'INR';
  lines: QuoteLine[];
  total_paise: number;
  issued_at: string;
  expires_at: string;
}

export interface SignedQuote extends UnsignedQuote {
  signature: string;
}

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
