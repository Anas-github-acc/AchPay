import { canonicalJson } from '../lib/canonical.js';
import { hmacSha256Hex, safeEqualHex } from '../lib/hash.js';
import type { SignedQuote, UnsignedQuote } from './types.js';

/**
 * signature = HMAC-SHA256(secret, canonical_json(quote_without_signature)).
 * Canonical JSON means key order in the wire payload cannot change the digest,
 * so a client may reformat a quote but not alter a single value in it.
 */
export function signQuote(quote: UnsignedQuote, secret: string): SignedQuote {
  return { ...quote, signature: computeSignature(quote, secret) };
}

export function computeSignature(quote: UnsignedQuote, secret: string): string {
  return hmacSha256Hex(secret, canonicalJson(stripSignature(quote)));
}

export function verifySignature(quote: SignedQuote, secret: string): boolean {
  if (typeof quote?.signature !== 'string') return false;
  return safeEqualHex(quote.signature, computeSignature(quote, secret));
}

function stripSignature(quote: UnsignedQuote | SignedQuote): UnsignedQuote {
  const { signature: _ignored, ...rest } = quote as SignedQuote;
  return rest;
}
