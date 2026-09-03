import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signs the webhook body with HMAC-SHA256 under the endpoint secret
 * and sends the hex digest in `x-razorpay-signature`.
 *
 * `body` must be the bytes that arrived. See src/http/raw-body.ts for why
 * re-serialised JSON is not good enough.
 */
export function computeSignature(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time comparison of the expected and supplied signatures.
 *
 * Compared as bytes with `timingSafeEqual` so the check does not leak how much
 * of a forged signature was correct. A length mismatch is rejected first,
 * because timingSafeEqual throws on unequal lengths.
 */
export function verifySignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(computeSignature(body, secret), 'utf8');
  const supplied = Buffer.from(signature, 'utf8');
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}
