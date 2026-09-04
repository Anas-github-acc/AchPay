import type { SignedQuote } from '../quotes/types.js';
import type { PolicyQuote } from './types.js';

/**
 * Narrows a signed quote to the structured fields the policy engine is allowed
 * to see. `title` — and any description that ever reaches a quote — is dropped
 * here and never reconstructed downstream.
 */
export function toPolicyQuote(quote: SignedQuote): PolicyQuote {
  return {
    quote_id: quote.quote_id,
    total_paise: quote.total_paise,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      category: line.category,
      qty: line.qty,
      unit_price_paise: line.unit_price_paise,
      line_total_paise: line.line_total_paise,
      category_median_paise: line.category_median_paise,
    })),
  };
}
