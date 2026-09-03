import { canonicalJson } from '../lib/canonical.js';
import { sha256Hex } from '../lib/hash.js';
import type { SignedQuote } from '../quotes/types.js';

/**
 * key = sha256(mandate_id + quote_id + canonical_json(sorted_lines))
 *
 * Derived entirely from what is being bought and on whose authority, so a
 * client retrying the same purchase produces the same key without having to
 * remember one. Lines are sorted so line order cannot fork the key.
 */
export function idempotencyKey(mandateId: string, quote: SignedQuote): string {
  const lines = [...quote.lines]
    .map((line) => ({
      sku: line.sku,
      qty: line.qty,
      unit_price_paise: line.unit_price_paise,
      line_total_paise: line.line_total_paise,
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return sha256Hex(mandateId + quote.quote_id + canonicalJson(lines));
}
