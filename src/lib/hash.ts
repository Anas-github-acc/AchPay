import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

/** Constant-time hex comparison. Returns false on any length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
